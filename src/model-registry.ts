/**
 * Model Registry - Custom Provider Configuration
 *
 * Loads custom model/provider configs from ~/.openclaw/clawrouter/models.json
 * and merges with built-in models. Supports hot reload via file watcher.
 */

import { readFileSync, watchFile, unwatchFile } from "bun:fs";
import { join } from "bun:path";
import { homedir } from "bun:os";
import type {
  ModelRegistryConfig,
  ModelDefinitionCustom,
  ProviderConfigCustom,
  Tier,
} from "./types";
import type { ModelDefinitionConfig } from "./types";

const MODELS_CONFIG_FILE = join(homedir(), ".openclaw", "clawrouter", "models.json");

let cachedConfig: ModelRegistryConfig | null = null;
let fileWatcher: ReturnType<typeof watchFile> | null = null;
type ReloadCallback = (config: ModelRegistryConfig) => void;
const reloadCallbacks: ReloadCallback[] = [];

/**
 * Load and parse the models.json config file.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadModelRegistry(): ModelRegistryConfig | null {
  try {
    const content = readFileSync(MODELS_CONFIG_FILE, "utf-8").trim();
    if (!content) return null;

    const config = JSON.parse(content) as ModelRegistryConfig;

    if (!config.version || !config.models) {
      console.warn("[model-registry] Invalid config: missing version or models");
      return null;
    }

    return config;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
      console.warn(`[model-registry] Failed to load config: ${err.message}`);
    }
    return null;
  }
}

/**
 * Get cached config, loading if necessary.
 */
export function getModelRegistry(): ModelRegistryConfig | null {
  if (!cachedConfig) {
    cachedConfig = loadModelRegistry();
  }
  return cachedConfig;
}

/**
 * Get all enabled custom models.
 */
export function getCustomModels(): ModelDefinitionCustom[] {
  const config = getModelRegistry();
  if (!config) return [];

  return Object.entries(config.models)
    .filter(([, model]) => model.enabled !== false)
    .map(([id, model]) => ({
      id,
      name: model.name ?? id,
      provider: model.provider ?? id.split("/")[0],
      capabilities: model.capabilities ?? {
        vision: false,
        reasoning: false,
        code: false,
        creative: false,
        agentic: false,
      },
      tiers: model.tiers ?? (["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as Tier[]),
      pricing: model.pricing ?? { input: 0, output: 0 },
      limits: model.limits ?? { contextWindow: 128000, maxOutput: 16384 },
      useCases: model.useCases ?? [],
      enabled: model.enabled ?? true,
    }));
}

/**
 * Get a specific custom model by ID.
 */
export function getCustomModel(id: string): ModelDefinitionCustom | undefined {
  const config = getModelRegistry();
  if (!config?.models[id]) return undefined;

  const model = config.models[id];
  return {
    id,
    name: model.name ?? id,
    provider: model.provider ?? id.split("/")[0],
    capabilities: model.capabilities ?? {
      vision: false,
      reasoning: false,
      code: false,
      creative: false,
      agentic: false,
    },
    tiers: model.tiers ?? (["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as Tier[]),
    pricing: model.pricing ?? { input: 0, output: 0 },
    limits: model.limits ?? { contextWindow: 128000, maxOutput: 16384 },
    useCases: model.useCases ?? [],
    enabled: model.enabled ?? true,
  };
}

/**
 * Get a provider config by name.
 */
export function getCustomProvider(providerId: string): ProviderConfigCustom | undefined {
  const config = getModelRegistry();
  return config?.providers[providerId];
}

/**
 * Convert custom model definition to OpenClaw ModelDefinitionConfig format.
 */
export function toOpenClawModel(model: ModelDefinitionCustom): ModelDefinitionConfig {
  const provider = getCustomProvider(model.provider);

  return {
    id: model.id,
    name: model.name,
    api: provider?.apiFormat ?? "openai-completions",
    reasoning: model.capabilities.reasoning,
    input: model.capabilities.vision ? ["text", "image"] : ["text"],
    cost: {
      input: model.pricing.input,
      output: model.pricing.output,
      cacheRead: model.pricing.cacheRead ?? 0,
      cacheWrite: model.pricing.cacheWrite ?? 0,
    },
    contextWindow: model.limits.contextWindow,
    maxTokens: model.limits.maxOutput,
    headers: provider?.headers,
  };
}

/**
 * Check if custom models are configured.
 */
export function hasCustomModels(): boolean {
  const models = getCustomModels();
  return models.length > 0;
}

/**
 * Setup hot reload - watch config file and notify callbacks on change.
 */
export function setupHotReload(callback: ReloadCallback): void {
  reloadCallbacks.push(callback);

  if (!fileWatcher) {
    fileWatcher = watchFile(MODELS_CONFIG_FILE, () => {
      cachedConfig = loadModelRegistry();
      for (const cb of reloadCallbacks) {
        if (cachedConfig) cb(cachedConfig);
      }
    });
  }
}

/**
 * Cleanup hot reload watchers.
 */
export function cleanupHotReload(): void {
  if (fileWatcher) {
    unwatchFile(MODELS_CONFIG_FILE);
    fileWatcher = null;
  }
  reloadCallbacks.length = 0;
}

/**
 * Force reload config (useful for testing).
 */
export function reloadModelRegistry(): ModelRegistryConfig | null {
  cachedConfig = loadModelRegistry();
  return cachedConfig;
}
