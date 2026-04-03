/**
 * Local Proxy Server — Direct Provider Access
 *
 * Routes requests to provider APIs using the user's own API keys.
 * Keeps all the smart routing logic (tier classification, fallback chains).
 *
 * Flow:
 *   OpenClaw → http://localhost:{port}/v1/chat/completions
 *           → proxy classifies request, picks cheapest model
 *           → forwards to provider API (OpenAI, Anthropic, Google, etc.)
 *           → streams response back
 */


import {
  loadApiKeys,
  getConfiguredProviders,
  getApiKey,
  getProviderBaseUrl,
  getProviderFromModel,
  resolveProviderAccess,
  isModelAccessible,
  getAccessibleProviders,
  hasOpenRouter,
  type ApiKeysConfig,
} from "./api-keys";
import {
  route,
  getFallbackChain,
  getFallbackChainFiltered,
  DEFAULT_ROUTING_CONFIG,
  type RouterOptions,
  type RoutingDecision,
  type RoutingConfig,
  type ModelPricing,
} from "./router/index";
import { BLOCKRUN_MODELS, resolveModelAlias, getModelContextWindow } from "./models";
import { logUsage, type UsageEntry } from "./logger";
import { getStats } from "./stats";
import { RequestDeduplicator } from "./dedup";
import { USER_AGENT } from "./version";
import { SessionStore, getSessionId, type SessionConfig } from "./session";
import { resolveOpenRouterModelId, ensureOpenRouterCache } from "./openrouter-models";
import { getCustomModels } from "./model-registry";

const AUTO_MODEL = "coldrouter/auto";
const AUTO_MODEL_SHORT = "auto";
const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_PORT = 8403;
const MAX_FALLBACK_ATTEMPTS = 3;
const HEALTH_CHECK_TIMEOUT_MS = 2_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const PORT_RETRY_ATTEMPTS = 5;
const PORT_RETRY_DELAY_MS = 1_000;

// Global logger instance (set by startProxy)
let proxyLogger: ProxyOptions["logger"] = {
  info: (msg) => console.log(`[ColdRouter] ${msg}`),
  warn: (msg) => console.warn(`[ColdRouter] ${msg}`),
  error: (msg) => console.error(`[ColdRouter] ${msg}`),
};

const rateLimitedModels = new Map<string, number>();

function isRateLimited(modelId: string): boolean {
  const hitTime = rateLimitedModels.get(modelId);
  if (!hitTime) return false;
  if (Date.now() - hitTime >= RATE_LIMIT_COOLDOWN_MS) {
    rateLimitedModels.delete(modelId);
    return false;
  }
  return true;
}

function markRateLimited(modelId: string): void {
  rateLimitedModels.set(modelId, Date.now());
  proxyLogger.warn?.(`Model ${modelId} rate-limited, will deprioritize for 60s`);
}

function prioritizeNonRateLimited(models: string[]): string[] {
  const available: string[] = [];
  const limited: string[] = [];
  for (const model of models) {
    (isRateLimited(model) ? limited : available).push(model);
  }
  return [...available, ...limited];
}

export function getProxyPort(): number {
  const envPort = process.env.COLDROUTER_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return DEFAULT_PORT;
}

async function checkExistingProxy(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = (await response.json()) as { status?: string };
      return data.status === "ok";
    }
    return false;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

const PROVIDER_ERROR_PATTERNS = [
  /billing/i,
  /insufficient.*balance/i,
  /credits/i,
  /quota.*exceeded/i,
  /rate.*limit/i,
  /model.*unavailable/i,
  /service.*unavailable/i,
  /capacity/i,
  /overloaded/i,
  /temporarily.*unavailable/i,
  /api.*key.*invalid/i,
  /authentication.*failed/i,
];

const FALLBACK_STATUS_CODES = [400, 401, 402, 403, 404, 405, 429, 500, 502, 503, 504];

function isProviderError(status: number, body: string): boolean {
  if (!FALLBACK_STATUS_CODES.includes(status)) return false;
  if (status >= 500) return true;
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(body));
}

const VALID_ROLES = new Set(["system", "user", "assistant", "tool", "function"]);
const ROLE_MAPPINGS: Record<string, string> = { developer: "system", model: "assistant" };

type ChatMessage = { role: string; content: string | unknown };

const VALID_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolId(id: string | undefined): string | undefined {
  if (!id || typeof id !== "string") return id;
  if (VALID_TOOL_ID_PATTERN.test(id)) return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

type MessageWithTools = ChatMessage & {
  tool_calls?: Array<{ id?: string; type?: string; function?: unknown }>;
  tool_call_id?: string;
};

type ContentBlock = { type?: string; id?: string; tool_use_id?: string; [key: string]: unknown };

function sanitizeToolIds(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const sanitized = messages.map((msg) => {
    const typedMsg = msg as MessageWithTools;
    let msgChanged = false;
    let newMsg = { ...msg } as MessageWithTools;

    if (typedMsg.tool_calls && Array.isArray(typedMsg.tool_calls)) {
      const newToolCalls = typedMsg.tool_calls.map((tc) => {
        if (tc.id && typeof tc.id === "string") {
          const s = sanitizeToolId(tc.id);
          if (s !== tc.id) {
            msgChanged = true;
            return { ...tc, id: s };
          }
        }
        return tc;
      });
      if (msgChanged) newMsg = { ...newMsg, tool_calls: newToolCalls };
    }

    if (typedMsg.tool_call_id && typeof typedMsg.tool_call_id === "string") {
      const s = sanitizeToolId(typedMsg.tool_call_id);
      if (s !== typedMsg.tool_call_id) {
        msgChanged = true;
        newMsg = { ...newMsg, tool_call_id: s };
      }
    }

    if (Array.isArray(typedMsg.content)) {
      const newContent = (typedMsg.content as ContentBlock[]).map((block) => {
        if (!block || typeof block !== "object") return block;
        let blockChanged = false;
        let newBlock = { ...block };
        if (block.type === "tool_use" && block.id && typeof block.id === "string") {
          const s = sanitizeToolId(block.id);
          if (s !== block.id) {
            blockChanged = true;
            newBlock = { ...newBlock, id: s };
          }
        }
        if (
          block.type === "tool_result" &&
          block.tool_use_id &&
          typeof block.tool_use_id === "string"
        ) {
          const s = sanitizeToolId(block.tool_use_id);
          if (s !== block.tool_use_id) {
            blockChanged = true;
            newBlock = { ...newBlock, tool_use_id: s };
          }
        }
        if (blockChanged) {
          msgChanged = true;
          return newBlock;
        }
        return block;
      });
      if (msgChanged) newMsg = { ...newMsg, content: newContent };
    }

    if (msgChanged) {
      hasChanges = true;
      return newMsg;
    }
    return msg;
  });
  return hasChanges ? sanitized : messages;
}

function normalizeMessageRoles(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (VALID_ROLES.has(msg.role)) return msg;
    const mapped = ROLE_MAPPINGS[msg.role];
    if (mapped) {
      hasChanges = true;
      return { ...msg, role: mapped };
    }
    hasChanges = true;
    return { ...msg, role: "user" };
  });
  return hasChanges ? normalized : messages;
}

function normalizeMessagesForGoogle(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;
  let firstNonSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") {
      firstNonSystemIdx = i;
      break;
    }
  }
  if (firstNonSystemIdx === -1) return messages;
  const firstRole = messages[firstNonSystemIdx].role;
  if (firstRole === "user") return messages;
  if (firstRole === "assistant" || firstRole === "model") {
    const normalized = [...messages];
    normalized.splice(firstNonSystemIdx, 0, { role: "user", content: "(continuing conversation)" });
    return normalized;
  }
  return messages;
}

function isGoogleModel(modelId: string): boolean {
  return modelId.startsWith("google/") || modelId.startsWith("gemini");
}

type ExtendedChatMessage = ChatMessage & { tool_calls?: unknown[]; reasoning_content?: unknown };

function normalizeMessagesForThinking(messages: ExtendedChatMessage[]): ExtendedChatMessage[] {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0 &&
      msg.reasoning_content === undefined
    ) {
      hasChanges = true;
      return { ...msg, reasoning_content: "" };
    }
    return msg;
  });
  return hasChanges ? normalized : messages;
}

const KIMI_BLOCK_RE = /<[｜|][^<>]*begin[^<>]*[｜|]>[\s\S]*?<[｜|][^<>]*end[^<>]*[｜|]>/gi;
const KIMI_TOKEN_RE = /<[｜|][^<>]*[｜|]>/g;
const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>/gi;
const THINKING_BLOCK_RE =
  /<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

function stripThinkingTokens(content: string): string {
  if (!content) return content;
  let cleaned = content.replace(KIMI_BLOCK_RE, "");
  cleaned = cleaned.replace(KIMI_TOKEN_RE, "");
  cleaned = cleaned.replace(THINKING_BLOCK_RE, "");
  cleaned = cleaned.replace(THINKING_TAG_RE, "");
  return cleaned;
}

function convertToAnthropicFormat(parsed: Record<string, unknown>): Record<string, unknown> {
  const messages = (parsed.messages as ChatMessage[]) || [];

  let system: string | undefined;
  const nonSystemMessages: Array<{ role: string; content: string | unknown }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    } else {
      nonSystemMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }
  }

  const result: Record<string, unknown> = {
    model: parsed.model,
    messages: nonSystemMessages,
    max_tokens: (parsed.max_tokens as number) || 4096,
  };

  if (system) result.system = system;
  if (parsed.stream) result.stream = true;
  if (parsed.temperature !== undefined) result.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) result.top_p = parsed.top_p;
  if (parsed.tools) result.tools = parsed.tools;

  return result;
}

function convertAnthropicResponseToOpenAI(
  anthropicData: Record<string, unknown>,
): Record<string, unknown> {
  const content = anthropicData.content as Array<{ type: string; text?: string }> | undefined;
  const textContent =
    content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("") || "";

  return {
    id: (anthropicData.id as string) || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropicData.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
        },
        finish_reason:
          anthropicData.stop_reason === "end_turn" ? "stop" : anthropicData.stop_reason || "stop",
      },
    ],
    usage: anthropicData.usage
      ? {
          prompt_tokens: (anthropicData.usage as Record<string, number>).input_tokens || 0,
          completion_tokens: (anthropicData.usage as Record<string, number>).output_tokens || 0,
          total_tokens:
            ((anthropicData.usage as Record<string, number>).input_tokens || 0) +
            ((anthropicData.usage as Record<string, number>).output_tokens || 0),
        }
      : undefined,
  };
}

export type ProxyOptions = {
  apiKeys: ApiKeysConfig;
  port?: number;
  routingConfig?: Partial<RoutingConfig>;
  requestTimeoutMs?: number;
  sessionConfig?: Partial<SessionConfig>;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  onRouted?: (decision: RoutingDecision) => void;
  /** Optional logger for structured logging */
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  configuredProviders: string[];
  close: () => Promise<void>;
};

function buildModelPricing(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();

  // Built-in models
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === "auto") continue;
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }

  // Custom models from registry
  for (const m of getCustomModels()) {
    map.set(m.id, { inputPrice: m.pricing.input, outputPrice: m.pricing.output });
  }

  return map;
}

function mergeRoutingConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  if (!overrides) return DEFAULT_ROUTING_CONFIG;
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...overrides,
    classifier: { ...DEFAULT_ROUTING_CONFIG.classifier, ...overrides.classifier },
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...overrides.scoring },
    tiers: { ...DEFAULT_ROUTING_CONFIG.tiers, ...overrides.tiers },
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...overrides.overrides },
  };
}

function buildUpstreamUrl(
  modelId: string,
  path: string,
  apiKeys: ApiKeysConfig,
):
  | { url: string; provider: string; apiKey: string; actualModelId: string; viaOpenRouter: boolean }
  | undefined {
  const access = resolveProviderAccess(apiKeys, modelId);
  if (!access) return undefined;

  const { apiKey, baseUrl, provider, viaOpenRouter } = access;

  if (viaOpenRouter) {
    const resolvedModelId = resolveOpenRouterModelId(modelId);
    ensureOpenRouterCache(apiKey);
    const orPath = baseUrl.endsWith("/v1") && path.startsWith("/v1") ? path.slice(3) : path;
    return {
      url: `${baseUrl}${orPath}`,
      provider,
      apiKey,
      actualModelId: resolvedModelId,
      viaOpenRouter: true,
    };
  }

  const actualModelId = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;

  const normalizedPath = baseUrl.endsWith("/v1") && path.startsWith("/v1") ? path.slice(3) : path;

  if (provider === "google") {
    return {
      url: `${baseUrl}/models/${actualModelId}:streamGenerateContent?alt=sse`,
      provider,
      apiKey,
      actualModelId,
      viaOpenRouter: false,
    };
  }

  if (provider === "anthropic") {
    const ANTHROPIC_MODEL_MAP: Record<string, string> = {
      "claude-sonnet-4": "claude-sonnet-4-20250514",
      "claude-opus-4": "claude-opus-4-20250514",
      "claude-opus-4.5": "claude-opus-4-20250514",
      "claude-haiku-4.5": "claude-haiku-4-20250414",
    };
    const mappedModel = ANTHROPIC_MODEL_MAP[actualModelId] || actualModelId;
    return {
      url: `${baseUrl}/messages`,
      provider,
      apiKey,
      actualModelId: mappedModel,
      viaOpenRouter: false,
    };
  }

  return {
    url: `${baseUrl}${normalizedPath}`,
    provider,
    apiKey,
    actualModelId,
    viaOpenRouter: false,
  };
}

function buildProviderHeaders(
  provider: string,
  apiKey: string,
  viaOpenRouter = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
  };

  if (viaOpenRouter) {
    headers["authorization"] = `Bearer ${apiKey}`;
    headers["x-title"] = "ColdRouter";
    return headers;
  }

  switch (provider) {
    case "anthropic":
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "google":
      headers["x-goog-api-key"] = apiKey;
      break;
    default:
      headers["authorization"] = `Bearer ${apiKey}`;
      break;
  }

  return headers;
}

type ModelRequestResult = {
  success: boolean;
  response?: Response;
  errorBody?: string;
  errorStatus?: number;
  isProviderError?: boolean;
};

async function tryModelRequest(
  modelId: string,
  path: string,
  method: string,
  body: Buffer,
  maxTokens: number,
  apiKeys: ApiKeysConfig,
  signal: AbortSignal,
): Promise<ModelRequestResult> {
  const upstream = buildUpstreamUrl(modelId, path, apiKeys);
  if (!upstream) {
    return {
      success: false,
      errorBody: `No API key configured for provider: ${getProviderFromModel(modelId)} (and no OpenRouter fallback)`,
      errorStatus: 401,
      isProviderError: true,
    };
  }

  let requestBody = body;
  let parsedBody: Record<string, unknown> | null = null;

  try {
    parsedBody = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch (err) {
    // Invalid JSON body - return error early, don't send malformed request
    return {
      success: false,
      errorBody: `Invalid JSON in request body: ${err instanceof Error ? err.message : "parse error"}`,
      errorStatus: 400,
      isProviderError: false,
    };
  }

  // Successfully parsed - transform the request
  if (parsedBody) {
    parsedBody.model = upstream.actualModelId;

    if (Array.isArray(parsedBody.messages)) {
      parsedBody.messages = normalizeMessageRoles(parsedBody.messages as ChatMessage[]);
      parsedBody.messages = sanitizeToolIds(parsedBody.messages as ChatMessage[]);
    }

    if (isGoogleModel(modelId) && Array.isArray(parsedBody.messages)) {
      parsedBody.messages = normalizeMessagesForGoogle(parsedBody.messages as ChatMessage[]);
    }

    if (parsedBody.thinking && Array.isArray(parsedBody.messages)) {
      parsedBody.messages = normalizeMessagesForThinking(parsedBody.messages as ExtendedChatMessage[]);
    }

    if (upstream.provider === "anthropic" && !upstream.viaOpenRouter) {
      const anthropicBody = convertToAnthropicFormat(parsedBody);
      requestBody = Buffer.from(JSON.stringify(anthropicBody));
    } else {
      requestBody = Buffer.from(JSON.stringify(parsedBody));
    }
  }

  const headers = buildProviderHeaders(upstream.provider, upstream.apiKey, upstream.viaOpenRouter);

  try {
    proxyLogger.info?.(
      `→ ${upstream.provider} ${upstream.url} model=${upstream.actualModelId} viaOR=${upstream.viaOpenRouter}`,
    );
    const response = await fetch(upstream.url, {
      method,
      headers,
      body: requestBody.length > 0 ? new Uint8Array(requestBody) : undefined,
      signal,
    });

    if (response.status !== 200) {
      const errorBody = await response.text();
      proxyLogger.info?.(`← ${response.status} ${errorBody.slice(0, 200)}`);
      return {
        success: false,
        errorBody,
        errorStatus: response.status,
        isProviderError: isProviderError(response.status, errorBody),
      };
    }

    return { success: true, response };
  } catch (err) {
    return {
      success: false,
      errorBody: err instanceof Error ? err.message : String(err),
      errorStatus: 500,
      isProviderError: true,
    };
  }
}

async function handleChatCompletion(
  req: Request,
  options: ProxyOptions,
  routerOpts: RouterOptions,
  deduplicator: RequestDeduplicator,
  sessionStore: SessionStore,
): Promise<Response> {
  const startTime = Date.now();
  const requestPath = req.url || "/v1/chat/completions";

  const body = Buffer.from(await req.arrayBuffer());

  let routingDecision: RoutingDecision | undefined;
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  let modifiedBody = body;

  try {
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    isStreaming = parsed.stream === true;
    modelId = (parsed.model as string) || "";
    maxTokens = (parsed.max_tokens as number) || 4096;

    const normalizedModel =
      typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";
    const resolvedModel = resolveModelAlias(normalizedModel);
    const wasAlias = resolvedModel !== normalizedModel;

    const isAutoModel =
      normalizedModel === AUTO_MODEL.toLowerCase() ||
      normalizedModel === AUTO_MODEL_SHORT.toLowerCase() ||
      normalizedModel === "blockrun/auto" ||
      normalizedModel === "coldrouter/auto";

    proxyLogger.info?.(
      `Received model: "${parsed.model}" -> normalized: "${normalizedModel}"${wasAlias ? ` -> alias: "${resolvedModel}"` : ""}, isAuto: ${isAutoModel}`,
    );

    if (wasAlias && !isAutoModel) {
      parsed.model = resolvedModel;
      modelId = resolvedModel;
    }

    if (isAutoModel) {
      const headers = Object.fromEntries(req.headers.entries());
      const sessionId = getSessionId(headers as Record<string, string | string[] | undefined>);
      const existingSession = sessionId ? sessionStore.getSession(sessionId) : undefined;

      if (existingSession) {
        proxyLogger.info?.(
          `Session ${sessionId?.slice(0, 8)}... using pinned model: ${existingSession.model}`,
        );
        parsed.model = existingSession.model;
        modelId = existingSession.model;
        sessionStore.touchSession(sessionId!);
      } else {
        type ContentPart = { type: string; text?: string };
        type Msg = { role: string; content: string | ContentPart[] | null };
        const messages = parsed.messages as Msg[] | undefined;

        function extractText(content: string | ContentPart[] | null | undefined): string {
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            return content
              .filter(
                (p): p is ContentPart & { text: string } =>
                  p.type === "text" && typeof p.text === "string",
              )
              .map((p) => p.text)
              .join("\n");
          }
          return "";
        }

        let lastUserMsg: Msg | undefined;
        if (messages) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") {
              lastUserMsg = messages[i];
              break;
            }
          }
        }
        const systemMsg = messages?.find((m: Msg) => m.role === "system");
        const prompt = extractText(lastUserMsg?.content);
        const systemPrompt = extractText(systemMsg?.content) || undefined;

        routingDecision = route(prompt, systemPrompt, maxTokens, routerOpts);

        if (!isModelAccessible(options.apiKeys, routingDecision.model)) {
          const tierConfig = routerOpts.config.tiers[routingDecision.tier];
          const chain = [tierConfig.primary, ...tierConfig.fallback];
          const available = chain.find((m) => isModelAccessible(options.apiKeys, m));
          if (available) {
            routingDecision = {
              ...routingDecision,
              model: available,
              reasoning: routingDecision.reasoning + ` | rerouted to ${available} (key available)`,
            };
          }
        }

        parsed.model = routingDecision.model;
        modelId = routingDecision.model;

        if (sessionId) {
          sessionStore.setSession(sessionId, routingDecision.model, routingDecision.tier);
        }
        options.onRouted?.(routingDecision);
      }
    }

    modifiedBody = Buffer.from(JSON.stringify(parsed));
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    proxyLogger.error?.(`Routing error: ${errorMsg}`);
    options.onError?.(new Error(`Routing failed: ${errorMsg}`));
  }

  const dedupKey = RequestDeduplicator.hash(modifiedBody);
  const cached = deduplicator.getCached(dedupKey);
  if (cached) {
    return new Response(new Uint8Array(cached.body), {
      status: cached.status,
      headers: cached.headers,
    });
  }
  const inflight = deduplicator.getInflight(dedupKey);
  if (inflight) {
    const result = await inflight;
    return new Response(new Uint8Array(result.body), {
      status: result.status,
      headers: result.headers,
    });
  }
  deduplicator.markInflight(dedupKey);

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let modelsToTry: string[];
    if (routingDecision) {
      const estimatedInputTokens = Math.ceil(modifiedBody.length / 4);
      const estimatedTotalTokens = estimatedInputTokens + maxTokens;
      const useAgenticTiers =
        (routingDecision.isAgentic || routingDecision.reasoning?.includes("agentic")) &&
        routerOpts.config.agenticTiers;
      const tierConfigs = useAgenticTiers
        ? routerOpts.config.agenticTiers!
        : routerOpts.config.tiers;
      const contextFiltered = getFallbackChainFiltered(
        routingDecision.tier,
        tierConfigs,
        estimatedTotalTokens,
        getModelContextWindow,
      );
      modelsToTry = contextFiltered.slice(0, MAX_FALLBACK_ATTEMPTS);
      modelsToTry = modelsToTry.filter((m) => isModelAccessible(options.apiKeys, m));
      modelsToTry = prioritizeNonRateLimited(modelsToTry);
    } else {
      modelsToTry = modelId ? [modelId] : [];
    }

    let upstream: Response | undefined;
    let lastError: { body: string; status: number } | undefined;
    let actualModelUsed = modelId;

    for (let i = 0; i < modelsToTry.length; i++) {
      const tryModel = modelsToTry[i];
      const isLastAttempt = i === modelsToTry.length - 1;
      proxyLogger.info?.(`Trying model ${i + 1}/${modelsToTry.length}: ${tryModel}`);

      const result = await tryModelRequest(
        tryModel,
        requestPath,
        req.method ?? "POST",
        modifiedBody,
        maxTokens,
        options.apiKeys,
        controller.signal,
      );

      if (result.success && result.response) {
        upstream = result.response;
        actualModelUsed = tryModel;
        proxyLogger.info?.(`Success with model: ${tryModel}`);
        break;
      }

      lastError = { body: result.errorBody || "Unknown error", status: result.errorStatus || 500 };
      if (result.isProviderError && !isLastAttempt) {
        if (result.errorStatus === 429) markRateLimited(tryModel);
        proxyLogger.info?.(
          `Provider error from ${tryModel}, trying fallback: ${result.errorBody?.slice(0, 100)}`,
        );
        continue;
      }
      break;
    }

    clearTimeout(timeoutId);

    if (routingDecision && actualModelUsed !== routingDecision.model) {
      routingDecision = {
        ...routingDecision,
        model: actualModelUsed,
        reasoning: `${routingDecision.reasoning} | fallback to ${actualModelUsed}`,
      };
      options.onRouted?.(routingDecision);
    }

    if (!upstream) {
      const errBody = lastError?.body || "All models in fallback chain failed";
      const errStatus = lastError?.status || 502;
      if (isStreaming) {
        const errEvent = `data: ${JSON.stringify({ error: { message: errBody, type: "provider_error", status: errStatus } })}\n\n`;
        deduplicator.complete(dedupKey, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: Buffer.from(errEvent + "data: [DONE]\n\n"),
          completedAt: Date.now(),
        });
        return new Response(errEvent + "data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      } else {
        const errJson = JSON.stringify({ error: { message: errBody, type: "provider_error" } });
        deduplicator.complete(dedupKey, {
          status: errStatus,
          headers: { "content-type": "application/json" },
          body: Buffer.from(errJson),
          completedAt: Date.now(),
        });
        return new Response(errJson, {
          status: errStatus,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const responseChunks: Buffer[] = [];

    if (isStreaming) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      const heartbeatInterval = setInterval(() => {
        if (writer.desiredSize !== null && writer.desiredSize >= 0) {
          writer.write(encoder.encode(": heartbeat\n\n")).catch(() => {});
        }
      }, HEARTBEAT_INTERVAL_MS);

      (async () => {
        try {
          if (upstream.body) {
            const reader = upstream.body.getReader();
            const chunks: Uint8Array[] = [];
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
              }
            } finally {
              reader.releaseLock();
            }

            const jsonBody = Buffer.concat(chunks);
            const jsonStr = jsonBody.toString();

            const isSSE =
              jsonStr.startsWith("data: ") ||
              jsonStr.startsWith("event: ") ||
              jsonStr.startsWith(": ");
            if (isSSE) {
              const cleaned = jsonStr
                .split("\n")
                .filter((line) => {
                  const trimmed = line.trim();
                  if (trimmed === "") return true;
                  if (trimmed === "data: [DONE]") return true;
                  if (trimmed.startsWith("data: {")) return true;
                  return false;
                })
                .join("\n");
              if (cleaned.trim()) {
                await writer.write(encoder.encode(cleaned));
                responseChunks.push(Buffer.from(cleaned));
              }
            } else {
              let responseJson = jsonStr;
              try {
                const rawParsed = JSON.parse(jsonStr);
                if (rawParsed.type === "message" && rawParsed.content) {
                  const converted = convertAnthropicResponseToOpenAI(rawParsed);
                  responseJson = JSON.stringify(converted);
                }
              } catch {
                /* not JSON */
              }
              try {
                const rsp = JSON.parse(responseJson) as {
                  id?: string;
                  created?: number;
                  model?: string;
                  choices?: Array<{
                    index?: number;
                    message?: { role?: string; content?: string; tool_calls?: unknown[] };
                    delta?: { role?: string; content?: string; tool_calls?: unknown[] };
                    finish_reason?: string | null;
                  }>;
                };

                const baseChunk = {
                  id: rsp.id ?? `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: rsp.created ?? Math.floor(Date.now() / 1000),
                  model: rsp.model ?? "unknown",
                  system_fingerprint: null,
                };

                if (rsp.choices && Array.isArray(rsp.choices)) {
                  for (const choice of rsp.choices) {
                    const rawContent = choice.message?.content ?? choice.delta?.content ?? "";
                    const content = stripThinkingTokens(rawContent);
                    const role = choice.message?.role ?? choice.delta?.role ?? "assistant";
                    const index = choice.index ?? 0;

                    const roleData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: { role }, logprobs: null, finish_reason: null }] })}\n\n`;
                    await writer.write(encoder.encode(roleData));
                    responseChunks.push(Buffer.from(roleData));

                    if (content) {
                      const contentData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: { content }, logprobs: null, finish_reason: null }] })}\n\n`;
                      await writer.write(encoder.encode(contentData));
                      responseChunks.push(Buffer.from(contentData));
                    }

                    const toolCalls = choice.message?.tool_calls ?? choice.delta?.tool_calls;
                    if (toolCalls && (toolCalls as unknown[]).length > 0) {
                      const toolCallData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: { tool_calls: toolCalls }, logprobs: null, finish_reason: null }] })}\n\n`;
                      await writer.write(encoder.encode(toolCallData));
                      responseChunks.push(Buffer.from(toolCallData));
                    }

                    const finishData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: {}, logprobs: null, finish_reason: choice.finish_reason ?? "stop" }] })}\n\n`;
                    await writer.write(encoder.encode(finishData));
                    responseChunks.push(Buffer.from(finishData));
                  }
                }
              } catch {
                const sseData = `data: ${jsonStr}\n\n`;
                await writer.write(encoder.encode(sseData));
                responseChunks.push(Buffer.from(sseData));
              }
            }
          }

          await writer.write(encoder.encode("data: [DONE]\n\n"));
          responseChunks.push(Buffer.from("data: [DONE]\n\n"));
        } catch (err) {
          proxyLogger.error?.(
            `Stream error: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          clearInterval(heartbeatInterval);
          deduplicator.complete(dedupKey, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: Buffer.concat(responseChunks),
            completedAt: Date.now(),
          });
          await writer.close().catch(() => {});
        }
      })();

      return new Response(readable, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    } else {
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (key === "transfer-encoding" || key === "connection" || key === "content-encoding")
          return;
        responseHeaders[key] = value;
      });

      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            responseChunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
      }
      let finalBody = Buffer.concat(responseChunks);

      try {
        const rawParsed = JSON.parse(finalBody.toString());
        if (rawParsed.type === "message" && rawParsed.content) {
          const converted = convertAnthropicResponseToOpenAI(rawParsed);
          finalBody = Buffer.from(JSON.stringify(converted));
          responseHeaders["content-type"] = "application/json";
        }
      } catch {
        /* not JSON, pass through */
      }

      deduplicator.complete(dedupKey, {
        status: upstream.status,
        headers: responseHeaders,
        body: finalBody,
        completedAt: Date.now(),
      });
      return new Response(finalBody, { status: upstream.status, headers: responseHeaders });
    }
  } catch (err) {
    clearTimeout(timeoutId);
    deduplicator.removeInflight(dedupKey);
    if (err instanceof Error && err.name === "AbortError")
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw err;
  }
}

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  // Initialize logger from options
  if (options.logger) {
    proxyLogger = options.logger;
  }

  const listenPort = options.port ?? getProxyPort();
  const configuredProviders = getConfiguredProviders(options.apiKeys);

  const existing = await checkExistingProxy(listenPort);
  if (existing) {
    options.onReady?.(listenPort);
    return {
      port: listenPort,
      baseUrl: `http://127.0.0.1:${listenPort}`,
      configuredProviders,
      close: async () => {},
    };
  }

  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts: RouterOptions = { config: routingConfig, modelPricing };
  const deduplicator = new RequestDeduplicator();
  const sessionStore = new SessionStore(options.sessionConfig);

  const server = Bun.serve({
    port: listenPort,
    hostname: "127.0.0.1",
    async fetch(req: Request) {
      try {
        const host = req.headers.get("host") || "localhost:8403";
        const url = new URL(req.url, `http://${host}`);
        const pathname = url.pathname;

        if (pathname === "/health" || pathname.startsWith("/health")) {
          const accessibleProviders = getAccessibleProviders(options.apiKeys);
          return new Response(
            JSON.stringify({
              status: "ok",
              configuredProviders,
              openRouterFallback: hasOpenRouter(options.apiKeys),
              accessibleProviders,
              modelCount: BLOCKRUN_MODELS.filter((m) => {
                if (m.id === "auto") return false;
                const provider = getProviderFromModel(m.id);
                return accessibleProviders.includes(provider);
              }).length,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (pathname === "/stats" || pathname.startsWith("/stats")) {
          try {
            const urlObj = new URL(url);
            const days = parseInt(urlObj.searchParams.get("days") || "7", 10);
            const stats = await getStats(Math.min(days, 30));
            return new Response(JSON.stringify(stats, null, 2), {
              status: 200,
              headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
            });
          } catch (err) {
            return new Response(
              JSON.stringify({
                error: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}`,
              }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        // Claude Code API endpoint
        if (pathname === "/v1/claude/models" && req.method === "GET") {
          const accessibleProviders = getAccessibleProviders(options.apiKeys);
          const models = [
            { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
            { id: "claude-opus-4", name: "Claude Opus 4", provider: "anthropic" },
            { id: "claude-haiku-4", name: "Claude Haiku 4", provider: "anthropic" },
            { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4 (latest)", provider: "anthropic" },
            { id: "claude-opus-4-20250514", name: "Claude Opus 4 (latest)", provider: "anthropic" },
            { id: "claude-haiku-4-20250414", name: "Claude Haiku 4 (latest)", provider: "anthropic" },
          ].filter((m) => {
            // Only show models if the provider is accessible
            if (m.provider === "anthropic") {
              return accessibleProviders.includes("anthropic") || hasOpenRouter(options.apiKeys);
            }
            return true;
          });
          return new Response(JSON.stringify({ object: "list", data: models }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Claude Code completion endpoint
        if (pathname === "/v1/claude/completions" && req.method === "POST") {
          try {
            const body = Buffer.from(await req.arrayBuffer());
            const parsed = JSON.parse(body.toString()) as Record<string, unknown>;

            const model = (parsed.model as string) || "claude-sonnet-4-20250514";
            const messages = parsed.messages as Array<{ role: string; content: string }> || [];
            const stream = parsed.stream === true;

            // Resolve provider access
            const access = resolveProviderAccess(options.apiKeys, `anthropic/${model}`);
            if (!access) {
              return new Response(
                JSON.stringify({ error: { message: "No API key configured for Anthropic", type: "authentication_error" } }),
                { status: 401, headers: { "Content-Type": "application/json" } },
              );
            }

            // Build Anthropic API request
            let systemMessage: string | undefined;
            const nonSystemMessages: Array<{ role: string; content: string }> = [];

            for (const msg of messages) {
              if (msg.role === "system") {
                systemMessage = msg.content;
              } else {
                nonSystemMessages.push({
                  role: msg.role === "assistant" ? "assistant" : "user",
                  content: msg.content,
                });
              }
            }

            const anthropicRequest = {
              model,
              messages: nonSystemMessages,
              max_tokens: (parsed.max_tokens as number) || 4096,
              temperature: parsed.temperature as number | undefined,
              top_p: parsed.top_p as number | undefined,
              ...(systemMessage && { system: systemMessage }),
            };

            const headers: Record<string, string> = {
              "content-type": "application/json",
              "x-api-key": access.apiKey,
              "anthropic-version": "2023-06-01",
              "user-agent": USER_AGENT,
            };

            const response = await fetch(`${access.baseUrl}/messages`, {
              method: "POST",
              headers,
              body: JSON.stringify(anthropicRequest),
              signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
            });

            if (!response.ok) {
              const errorBody = await response.text();
              return new Response(errorBody, {
                status: response.status,
                headers: { "Content-Type": "application/json" },
              });
            }

            if (stream) {
              // Convert Anthropic SSE to OpenAI-compatible format
              const { readable, writable } = new TransformStream();
              const writer = writable.getWriter();
              const encoder = new TextEncoder();

              (async () => {
                try {
                  if (response.body) {
                    const reader = response.body.getReader();
                    const chunks: Uint8Array[] = [];
                    try {
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                      }
                    } finally {
                      reader.releaseLock();
                    }

                    const text = Buffer.concat(chunks).toString();
                    const parsedAnthropic = JSON.parse(text);

                    const content = parsedAnthropic.content?.find((c: { type: string }) => c.type === "text")?.text || "";
                    const usage = parsedAnthropic.usage || {};

                    // Send role
                    await writer.write(encoder.encode(
                      `data: ${JSON.stringify({ id: parsedAnthropic.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`
                    ));

                    // Send content
                    if (content) {
                      await writer.write(encoder.encode(
                        `data: ${JSON.stringify({ id: parsedAnthropic.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
                      ));
                    }

                    // Send stop
                    await writer.write(encoder.encode(
                      `data: ${JSON.stringify({ id: parsedAnthropic.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
                    ));
                    await writer.write(encoder.encode("data: [DONE]\n\n"));
                  }
                } catch (err) {
                  proxyLogger.error?.(`Claude stream error: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                  await writer.close();
                }
              })();

              return new Response(readable, {
                status: 200,
                headers: {
                  "content-type": "text/event-stream",
                  "cache-control": "no-cache",
                },
              });
            } else {
              // Non-streaming response - convert to OpenAI format
              const anthropicResponse = await response.json();
              const textContent = anthropicResponse.content?.find((c: { type: string }) => c.type === "text")?.text || "";

              const openAIResponse = {
                id: anthropicResponse.id,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: anthropicResponse.model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: textContent,
                    },
                    finish_reason: anthropicResponse.stop_reason === "end_turn" ? "stop" : anthropicResponse.stop_reason || "stop",
                  },
                ],
                usage: {
                  prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
                  completion_tokens: anthropicResponse.usage?.output_tokens || 0,
                  total_tokens: (anthropicResponse.usage?.input_tokens || 0) + (anthropicResponse.usage?.output_tokens || 0),
                },
              };

              return new Response(JSON.stringify(openAIResponse), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
          } catch (err) {
            return new Response(
              JSON.stringify({ error: { message: err instanceof Error ? err.message : "Internal error", type: "server_error" } }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        // Anthropic API proxy endpoint
        if (pathname === "/v1/anthropic" && req.method === "POST") {
          // Get API key - prefer direct Anthropic key, fallback to OpenRouter
          let apiKey = options.apiKeys.providers.anthropic?.apiKey;
          let baseUrl = options.apiKeys.providers.anthropic?.baseUrl || "https://api.anthropic.com/v1";
          let viaOpenRouter = false;

          if (!apiKey && options.apiKeys.providers.openrouter?.apiKey) {
            // Fallback to OpenRouter
            apiKey = options.apiKeys.providers.openrouter.apiKey;
            baseUrl = "https://openrouter.ai/api/v1";
            viaOpenRouter = true;
          }

          if (!apiKey) {
            return new Response(
              JSON.stringify({ error: { message: "No API key configured for Anthropic", type: "authentication_error" } }),
              { status: 401, headers: { "Content-Type": "application/json" } },
            );
          }

          try {
            const body = Buffer.from(await req.arrayBuffer());
            const parsed = JSON.parse(body.toString()) as Record<string, unknown>;

            const model = (parsed.model as string) || "claude-sonnet-4-20250514";
            const messages = parsed.messages as Array<{ role: string; content: string | unknown }> || [];
            const stream = parsed.stream === true;

            // Extract system message and build Anthropic format
            let systemMessage: string | undefined;
            const nonSystemMessages: Array<{ role: string; content: string }> = [];

            for (const msg of messages) {
              if (msg.role === "system") {
                systemMessage = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
              } else {
                nonSystemMessages.push({
                  role: msg.role === "assistant" ? "assistant" : "user",
                  content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
                });
              }
            }

            const requestBody = {
              model,
              messages: nonSystemMessages,
              max_tokens: (parsed.max_tokens as number) || 4096,
              temperature: parsed.temperature as number | undefined,
              top_p: parsed.top_p as number | undefined,
              ...(systemMessage && { system: systemMessage }),
            };

            const headers: Record<string, string> = {
              "content-type": "application/json",
              "user-agent": USER_AGENT,
            };

            if (viaOpenRouter) {
              headers["authorization"] = `Bearer ${apiKey}`;
              headers["x-title"] = "ColdRouter";
            } else {
              headers["x-api-key"] = apiKey;
              headers["anthropic-version"] = "2023-06-01";
            }

            const response = await fetch(`${baseUrl}/messages`, {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
              signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
            });

            if (!response.ok) {
              const errorBody = await response.text();
              return new Response(errorBody, {
                status: response.status,
                headers: { "Content-Type": "application/json" },
              });
            }

            // Handle streaming response
            if (stream) {
              const { readable, writable } = new TransformStream();
              const writer = writable.getWriter();
              const encoder = new TextEncoder();

              (async () => {
                try {
                  if (response.body) {
                    const reader = response.body.getReader();
                    let buffer = "";

                    try {
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += new TextDecoder().decode(value);
                        const lines = buffer.split("\n");
                        buffer = lines.pop() || "";

                        for (const line of lines) {
                          const trimmed = line.trim();
                          if (!trimmed || trimmed.startsWith(":")) continue;

                          if (trimmed.startsWith("data: ")) {
                            const data = trimmed.slice(6);
                            if (data === "[DONE]") {
                              await writer.write(encoder.encode("data: [DONE]\n\n"));
                              break;
                            }

                            try {
                              const event = JSON.parse(data);
                              if (event.type === "message_delta") {
                                const delta = event.delta?.text || "";
                                const index = event.index ?? 0;
                                await writer.write(encoder.encode(
                                  `data: ${JSON.stringify({ id: event.message_id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index, delta: { content: delta }, finish_reason: null }] })}\n\n`
                                ));
                              } else if (event.type === "content_block_delta") {
                                const delta = event.delta?.text || "";
                                const index = event.index ?? 0;
                                await writer.write(encoder.encode(
                                  `data: ${JSON.stringify({ id: event.message_id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index, delta: { content: delta }, finish_reason: null }] })}\n\n`
                                ));
                              } else if (event.type === "message_stop") {
                                const index = event.index ?? 0;
                                await writer.write(encoder.encode(
                                  `data: ${JSON.stringify({ id: event.message_id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index, delta: {}, finish_reason: "stop" }] })}\n\n`
                                ));
                              }
                            } catch {
                              // Skip invalid JSON
                            }
                          }
                        }
                      }
                    } finally {
                      reader.releaseLock();
                    }

                    await writer.write(encoder.encode("data: [DONE]\n\n"));
                  }
                } catch (err) {
                  proxyLogger.error?.(`Anthropic stream error: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                  await writer.close();
                }
              })();

              return new Response(readable, {
                status: 200,
                headers: {
                  "content-type": "text/event-stream",
                  "cache-control": "no-cache",
                },
              });
            } else {
              // Non-streaming - return as-is
              const responseBody = await response.text();
              return new Response(responseBody, {
                status: response.status,
                headers: { "Content-Type": "application/json" },
              });
            }
          } catch (err) {
            return new Response(
              JSON.stringify({ error: { message: err instanceof Error ? err.message : "Internal error", type: "server_error" } }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        // ColdRouter AI endpoint for Claude Code
        // Always uses smart routing - ignores the model parameter, uses auto-routing
        if (pathname === "/v1/anthropic" && req.method === "POST") {
          try {
            const body = Buffer.from(await req.arrayBuffer());
            const parsed = JSON.parse(body.toString()) as Record<string, unknown>;

            // Force auto-routing - override the model to use smart routing
            parsed.model = "coldrouter/auto";

            const modifiedReq = new Request(req.url, {
              method: req.method,
              headers: req.headers,
              body: Buffer.from(JSON.stringify(parsed)),
            });

            return handleChatCompletion(modifiedReq, options, routerOpts, deduplicator, sessionStore);
          } catch (err) {
            return new Response(
              JSON.stringify({ error: { message: err instanceof Error ? err.message : "Invalid request", type: "invalid_request_error" } }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        if (pathname === "/v1/models" && req.method === "GET") {
          const accessibleProviders = getAccessibleProviders(options.apiKeys);
          const models = BLOCKRUN_MODELS.filter((m) => {
            if (m.id === "auto") return true;
            const provider = getProviderFromModel(m.id);
            return accessibleProviders.includes(provider);
          }).map((m) => ({
            id: m.id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: m.id.split("/")[0] || "coldrouter",
          }));
          return new Response(JSON.stringify({ object: "list", data: models }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!pathname.startsWith("/v1")) {
          return new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        return handleChatCompletion(req, options, routerOpts, deduplicator, sessionStore);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        options.onError?.(error);
        return new Response(
          JSON.stringify({
            error: { message: `Proxy error: ${error.message}`, type: "proxy_error" },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
    },
    error(err) {
      proxyLogger.error?.(`Server runtime error: ${err.message}`);
      options.onError?.(err);
      return new Response("Internal Server Error", { status: 500 });
    },
  });

  const port = server.port ?? listenPort;
  options.onReady?.(port);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    configuredProviders,
    close: async () => {
      sessionStore.close();
      server.stop();
    },
  };
}
