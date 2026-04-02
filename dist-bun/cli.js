#!/usr/bin/env node
// @bun
var __require = import.meta.require;

// src/api-keys.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var CONFIG_DIR = join(homedir(), ".openclaw", "clawrouter");
var CONFIG_FILE = join(CONFIG_DIR, "config.json");
var PROVIDER_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.cn/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  openrouter: "https://openrouter.ai/api/v1"
};
var OPENAI_COMPATIBLE_PROVIDERS = new Set(["openai", "xai", "deepseek", "moonshot", "nvidia"]);
var ENV_VAR_MAP = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
};
function loadApiKeys(pluginConfig) {
  const config = { providers: {} };
  if (existsSync(CONFIG_FILE)) {
    try {
      const content = readFileSync(CONFIG_FILE, "utf-8").trim();
      if (content) {
        const parsed = JSON.parse(content);
        if (parsed.providers) {
          config.providers = { ...parsed.providers };
        }
      }
    } catch {}
  }
  if (pluginConfig?.providers && typeof pluginConfig.providers === "object") {
    const pluginProviders = pluginConfig.providers;
    for (const [provider, providerConfig] of Object.entries(pluginProviders)) {
      if (providerConfig.apiKey) {
        config.providers[provider] = { ...config.providers[provider], ...providerConfig };
      }
    }
  }
  for (const [provider, envVar] of Object.entries(ENV_VAR_MAP)) {
    const key = process.env[envVar];
    if (key) {
      if (!config.providers[provider]) {
        config.providers[provider] = { apiKey: key };
      } else {
        config.providers[provider].apiKey = key;
      }
    }
  }
  return config;
}
function getConfiguredProviders(config) {
  return Object.keys(config.providers).filter((p) => config.providers[p]?.apiKey);
}
function getApiKey(config, provider) {
  return config.providers[provider]?.apiKey;
}
function getProviderBaseUrl(config, provider) {
  return config.providers[provider]?.baseUrl ?? PROVIDER_ENDPOINTS[provider];
}
function getProviderFromModel(modelId) {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : modelId;
}
function hasOpenRouter(config) {
  return !!config.providers.openrouter?.apiKey;
}
function resolveProviderAccess(config, modelId) {
  const provider = getProviderFromModel(modelId);
  const needsConversion = provider === "anthropic" || provider === "google";
  const orKey = config.providers.openrouter?.apiKey;
  if (needsConversion && orKey) {
    const orUrl = config.providers.openrouter?.baseUrl ?? PROVIDER_ENDPOINTS.openrouter;
    return { apiKey: orKey, baseUrl: orUrl, provider: "openrouter", viaOpenRouter: true };
  }
  const directKey = getApiKey(config, provider);
  const directUrl = getProviderBaseUrl(config, provider);
  if (directKey && directUrl && OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    return { apiKey: directKey, baseUrl: directUrl, provider, viaOpenRouter: false };
  }
  const orFallbackKey = config.providers.openrouter?.apiKey;
  if (orFallbackKey) {
    const orUrl2 = config.providers.openrouter?.baseUrl ?? PROVIDER_ENDPOINTS.openrouter;
    return { apiKey: orFallbackKey, baseUrl: orUrl2, provider: "openrouter", viaOpenRouter: true };
  }
  return;
}
function isModelAccessible(config, modelId) {
  return resolveProviderAccess(config, modelId) !== undefined;
}
function getAccessibleProviders(config) {
  const direct = getConfiguredProviders(config).filter((p) => p !== "openrouter");
  if (hasOpenRouter(config)) {
    return Object.keys(PROVIDER_ENDPOINTS).filter((p) => p !== "openrouter");
  }
  return direct;
}

// src/router/rules.ts
function scoreTokenCount(estimatedTokens, thresholds) {
  if (estimatedTokens < thresholds.simple) {
    return { name: "tokenCount", score: -1, signal: `short (${estimatedTokens} tokens)` };
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: "tokenCount", score: 1, signal: `long (${estimatedTokens} tokens)` };
  }
  return { name: "tokenCount", score: 0, signal: null };
}
function scoreKeywordMatch(text, keywords, name, signalLabel, thresholds, scores) {
  const matches = keywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (matches.length >= thresholds.high) {
    return {
      name,
      score: scores.high,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`
    };
  }
  if (matches.length >= thresholds.low) {
    return {
      name,
      score: scores.low,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`
    };
  }
  return { name, score: scores.none, signal: null };
}
function scoreMultiStep(text) {
  const patterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  const hits = patterns.filter((p) => p.test(text));
  if (hits.length > 0) {
    return { name: "multiStepPatterns", score: 0.5, signal: "multi-step" };
  }
  return { name: "multiStepPatterns", score: 0, signal: null };
}
function scoreQuestionComplexity(prompt) {
  const count = (prompt.match(/\?/g) || []).length;
  if (count > 3) {
    return { name: "questionComplexity", score: 0.5, signal: `${count} questions` };
  }
  return { name: "questionComplexity", score: 0, signal: null };
}
function scoreAgenticTask(text, keywords) {
  let matchCount = 0;
  const signals = [];
  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      matchCount++;
      if (signals.length < 3) {
        signals.push(keyword);
      }
    }
  }
  if (matchCount >= 4) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 1,
        signal: `agentic (${signals.join(", ")})`
      },
      agenticScore: 1
    };
  } else if (matchCount >= 3) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.6,
        signal: `agentic (${signals.join(", ")})`
      },
      agenticScore: 0.6
    };
  } else if (matchCount >= 1) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.2,
        signal: `agentic-light (${signals.join(", ")})`
      },
      agenticScore: 0.2
    };
  }
  return {
    dimensionScore: { name: "agenticTask", score: 0, signal: null },
    agenticScore: 0
  };
}
function classifyByRules(prompt, systemPrompt, estimatedTokens, config) {
  const userText = prompt.toLowerCase();
  const dimensions = [
    scoreTokenCount(estimatedTokens, config.tokenCountThresholds),
    scoreKeywordMatch(userText, config.codeKeywords, "codePresence", "code", { low: 1, high: 2 }, { none: 0, low: 0.5, high: 1 }),
    scoreKeywordMatch(userText, config.reasoningKeywords, "reasoningMarkers", "reasoning", { low: 1, high: 2 }, { none: 0, low: 0.7, high: 1 }),
    scoreKeywordMatch(userText, config.technicalKeywords, "technicalTerms", "technical", { low: 2, high: 4 }, { none: 0, low: 0.5, high: 1 }),
    scoreKeywordMatch(userText, config.creativeKeywords, "creativeMarkers", "creative", { low: 1, high: 2 }, { none: 0, low: 0.5, high: 0.7 }),
    scoreKeywordMatch(userText, config.simpleKeywords, "simpleIndicators", "simple", { low: 1, high: 2 }, { none: 0, low: -1, high: -1 }),
    scoreMultiStep(userText),
    scoreQuestionComplexity(prompt),
    scoreKeywordMatch(userText, config.imperativeVerbs, "imperativeVerbs", "imperative", { low: 1, high: 2 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(userText, config.constraintIndicators, "constraintCount", "constraints", { low: 1, high: 3 }, { none: 0, low: 0.3, high: 0.7 }),
    scoreKeywordMatch(userText, config.outputFormatKeywords, "outputFormat", "format", { low: 1, high: 2 }, { none: 0, low: 0.4, high: 0.7 }),
    scoreKeywordMatch(userText, config.referenceKeywords, "referenceComplexity", "references", { low: 1, high: 2 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(userText, config.negationKeywords, "negationComplexity", "negation", { low: 2, high: 3 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(userText, config.domainSpecificKeywords, "domainSpecificity", "domain-specific", { low: 1, high: 2 }, { none: 0, low: 0.5, high: 0.8 })
  ];
  const agenticResult = scoreAgenticTask(userText, config.agenticTaskKeywords);
  dimensions.push(agenticResult.dimensionScore);
  const agenticScore = agenticResult.agenticScore;
  const signals = dimensions.filter((d) => d.signal !== null).map((d) => d.signal);
  const weights = config.dimensionWeights;
  let weightedScore = 0;
  for (const d of dimensions) {
    const w = weights[d.name] ?? 0;
    weightedScore += d.score * w;
  }
  const reasoningMatches = config.reasoningKeywords.filter((kw) => userText.includes(kw.toLowerCase()));
  if (reasoningMatches.length >= 2) {
    const confidence2 = calibrateConfidence(Math.max(weightedScore, 0.3), config.confidenceSteepness);
    return {
      score: weightedScore,
      tier: "REASONING",
      confidence: Math.max(confidence2, 0.85),
      signals,
      agenticScore
    };
  }
  const { simpleMedium, mediumComplex, complexReasoning } = config.tierBoundaries;
  let tier;
  let distanceFromBoundary;
  if (weightedScore < simpleMedium) {
    tier = "SIMPLE";
    distanceFromBoundary = simpleMedium - weightedScore;
  } else if (weightedScore < mediumComplex) {
    tier = "MEDIUM";
    distanceFromBoundary = Math.min(weightedScore - simpleMedium, mediumComplex - weightedScore);
  } else if (weightedScore < complexReasoning) {
    tier = "COMPLEX";
    distanceFromBoundary = Math.min(weightedScore - mediumComplex, complexReasoning - weightedScore);
  } else {
    tier = "REASONING";
    distanceFromBoundary = weightedScore - complexReasoning;
  }
  const confidence = calibrateConfidence(distanceFromBoundary, config.confidenceSteepness);
  if (confidence < config.confidenceThreshold) {
    return { score: weightedScore, tier: null, confidence, signals, agenticScore };
  }
  return { score: weightedScore, tier, confidence, signals, agenticScore };
}
function calibrateConfidence(distance, steepness) {
  return 1 / (1 + Math.exp(-steepness * distance));
}

// src/router/selector.ts
function selectModel(tier, confidence, method, reasoning, tierConfigs, modelPricing, estimatedInputTokens, maxOutputTokens) {
  const tierConfig = tierConfigs[tier];
  const model = tierConfig.primary;
  const pricing = modelPricing.get(model);
  const inputCost = pricing ? estimatedInputTokens / 1e6 * pricing.inputPrice : 0;
  const outputCost = pricing ? maxOutputTokens / 1e6 * pricing.outputPrice : 0;
  const costEstimate = inputCost + outputCost;
  const opusPricing = modelPricing.get("anthropic/claude-opus-4");
  const baselineInput = opusPricing ? estimatedInputTokens / 1e6 * opusPricing.inputPrice : 0;
  const baselineOutput = opusPricing ? maxOutputTokens / 1e6 * opusPricing.outputPrice : 0;
  const baselineCost = baselineInput + baselineOutput;
  const savings = baselineCost > 0 ? Math.max(0, (baselineCost - costEstimate) / baselineCost) : 0;
  return {
    model,
    tier,
    confidence,
    method,
    reasoning,
    costEstimate,
    baselineCost,
    savings
  };
}
function getFallbackChain(tier, tierConfigs) {
  const config = tierConfigs[tier];
  return [config.primary, ...config.fallback];
}
function getFallbackChainFiltered(tier, tierConfigs, estimatedTotalTokens, getContextWindow) {
  const fullChain = getFallbackChain(tier, tierConfigs);
  const filtered = fullChain.filter((modelId) => {
    const contextWindow = getContextWindow(modelId);
    if (contextWindow === undefined) {
      return true;
    }
    return contextWindow >= estimatedTotalTokens * 1.1;
  });
  if (filtered.length === 0) {
    return fullChain;
  }
  return filtered;
}
// src/router/config.ts
var DEFAULT_ROUTING_CONFIG = {
  version: "2.0",
  classifier: {
    llmModel: "google/gemini-2.5-flash",
    llmMaxTokens: 10,
    llmTemperature: 0,
    promptTruncationChars: 500,
    cacheTtlMs: 3600000
  },
  scoring: {
    tokenCountThresholds: { simple: 50, complex: 500 },
    codeKeywords: [
      "function",
      "class",
      "import",
      "def",
      "SELECT",
      "async",
      "await",
      "const",
      "let",
      "var",
      "return",
      "```",
      "\u51FD\u6570",
      "\u7C7B",
      "\u5BFC\u5165",
      "\u5B9A\u4E49",
      "\u67E5\u8BE2",
      "\u5F02\u6B65",
      "\u7B49\u5F85",
      "\u5E38\u91CF",
      "\u53D8\u91CF",
      "\u8FD4\u56DE",
      "\u95A2\u6570",
      "\u30AF\u30E9\u30B9",
      "\u30A4\u30F3\u30DD\u30FC\u30C8",
      "\u975E\u540C\u671F",
      "\u5B9A\u6570",
      "\u5909\u6570",
      "\u0444\u0443\u043D\u043A\u0446\u0438\u044F",
      "\u043A\u043B\u0430\u0441\u0441",
      "\u0438\u043C\u043F\u043E\u0440\u0442",
      "\u043E\u043F\u0440\u0435\u0434\u0435\u043B",
      "\u0437\u0430\u043F\u0440\u043E\u0441",
      "\u0430\u0441\u0438\u043D\u0445\u0440\u043E\u043D\u043D\u044B\u0439",
      "\u043E\u0436\u0438\u0434\u0430\u0442\u044C",
      "\u043A\u043E\u043D\u0441\u0442\u0430\u043D\u0442\u0430",
      "\u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u0430\u044F",
      "\u0432\u0435\u0440\u043D\u0443\u0442\u044C",
      "funktion",
      "klasse",
      "importieren",
      "definieren",
      "abfrage",
      "asynchron",
      "erwarten",
      "konstante",
      "variable",
      "zur\xFCckgeben"
    ],
    reasoningKeywords: [
      "prove",
      "theorem",
      "derive",
      "step by step",
      "chain of thought",
      "formally",
      "mathematical",
      "proof",
      "logically",
      "\u8BC1\u660E",
      "\u5B9A\u7406",
      "\u63A8\u5BFC",
      "\u9010\u6B65",
      "\u601D\u7EF4\u94FE",
      "\u5F62\u5F0F\u5316",
      "\u6570\u5B66",
      "\u903B\u8F91",
      "\u8A3C\u660E",
      "\u5B9A\u7406",
      "\u5C0E\u51FA",
      "\u30B9\u30C6\u30C3\u30D7\u30D0\u30A4\u30B9\u30C6\u30C3\u30D7",
      "\u8AD6\u7406\u7684",
      "\u0434\u043E\u043A\u0430\u0437\u0430\u0442\u044C",
      "\u0434\u043E\u043A\u0430\u0436\u0438",
      "\u0434\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432",
      "\u0442\u0435\u043E\u0440\u0435\u043C\u0430",
      "\u0432\u044B\u0432\u0435\u0441\u0442\u0438",
      "\u0448\u0430\u0433 \u0437\u0430 \u0448\u0430\u0433\u043E\u043C",
      "\u043F\u043E\u0448\u0430\u0433\u043E\u0432\u043E",
      "\u043F\u043E\u044D\u0442\u0430\u043F\u043D\u043E",
      "\u0446\u0435\u043F\u043E\u0447\u043A\u0430 \u0440\u0430\u0441\u0441\u0443\u0436\u0434\u0435\u043D\u0438\u0439",
      "\u0440\u0430\u0441\u0441\u0443\u0436\u0434\u0435\u043D\u0438",
      "\u0444\u043E\u0440\u043C\u0430\u043B\u044C\u043D\u043E",
      "\u043C\u0430\u0442\u0435\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438",
      "\u043B\u043E\u0433\u0438\u0447\u0435\u0441\u043A\u0438",
      "beweisen",
      "beweis",
      "theorem",
      "ableiten",
      "schritt f\xFCr schritt",
      "gedankenkette",
      "formal",
      "mathematisch",
      "logisch"
    ],
    simpleKeywords: [
      "what is",
      "define",
      "translate",
      "hello",
      "yes or no",
      "capital of",
      "how old",
      "who is",
      "when was",
      "\u4EC0\u4E48\u662F",
      "\u5B9A\u4E49",
      "\u7FFB\u8BD1",
      "\u4F60\u597D",
      "\u662F\u5426",
      "\u9996\u90FD",
      "\u591A\u5927",
      "\u8C01\u662F",
      "\u4F55\u65F6",
      "\u3068\u306F",
      "\u5B9A\u7FA9",
      "\u7FFB\u8A33",
      "\u3053\u3093\u306B\u3061\u306F",
      "\u306F\u3044\u304B\u3044\u3044\u3048",
      "\u9996\u90FD",
      "\u8AB0",
      "\u0447\u0442\u043E \u0442\u0430\u043A\u043E\u0435",
      "\u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0438\u0435",
      "\u043F\u0435\u0440\u0435\u0432\u0435\u0441\u0442\u0438",
      "\u043F\u0435\u0440\u0435\u0432\u0435\u0434\u0438",
      "\u043F\u0440\u0438\u0432\u0435\u0442",
      "\u0434\u0430 \u0438\u043B\u0438 \u043D\u0435\u0442",
      "\u0441\u0442\u043E\u043B\u0438\u0446\u0430",
      "\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043B\u0435\u0442",
      "\u043A\u0442\u043E \u0442\u0430\u043A\u043E\u0439",
      "\u043A\u043E\u0433\u0434\u0430",
      "\u043E\u0431\u044A\u044F\u0441\u043D\u0438",
      "was ist",
      "definiere",
      "\xFCbersetze",
      "hallo",
      "ja oder nein",
      "hauptstadt",
      "wie alt",
      "wer ist",
      "wann",
      "erkl\xE4re"
    ],
    technicalKeywords: [
      "algorithm",
      "optimize",
      "architecture",
      "distributed",
      "kubernetes",
      "microservice",
      "database",
      "infrastructure",
      "\u7B97\u6CD5",
      "\u4F18\u5316",
      "\u67B6\u6784",
      "\u5206\u5E03\u5F0F",
      "\u5FAE\u670D\u52A1",
      "\u6570\u636E\u5E93",
      "\u57FA\u7840\u8BBE\u65BD",
      "\u30A2\u30EB\u30B4\u30EA\u30BA\u30E0",
      "\u6700\u9069\u5316",
      "\u30A2\u30FC\u30AD\u30C6\u30AF\u30C1\u30E3",
      "\u5206\u6563",
      "\u30DE\u30A4\u30AF\u30ED\u30B5\u30FC\u30D3\u30B9",
      "\u30C7\u30FC\u30BF\u30D9\u30FC\u30B9",
      "\u0430\u043B\u0433\u043E\u0440\u0438\u0442\u043C",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0430\u0446\u0438",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0438\u0440\u0443\u0439",
      "\u0430\u0440\u0445\u0438\u0442\u0435\u043A\u0442\u0443\u0440\u0430",
      "\u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D\u043D\u044B\u0439",
      "\u043C\u0438\u043A\u0440\u043E\u0441\u0435\u0440\u0432\u0438\u0441",
      "\u0431\u0430\u0437\u0430 \u0434\u0430\u043D\u043D\u044B\u0445",
      "\u0438\u043D\u0444\u0440\u0430\u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430",
      "algorithmus",
      "optimieren",
      "architektur",
      "verteilt",
      "kubernetes",
      "mikroservice",
      "datenbank",
      "infrastruktur"
    ],
    creativeKeywords: [
      "story",
      "poem",
      "compose",
      "brainstorm",
      "creative",
      "imagine",
      "write a",
      "\u6545\u4E8B",
      "\u8BD7",
      "\u521B\u4F5C",
      "\u5934\u8111\u98CE\u66B4",
      "\u521B\u610F",
      "\u60F3\u8C61",
      "\u5199\u4E00\u4E2A",
      "\u7269\u8A9E",
      "\u8A69",
      "\u4F5C\u66F2",
      "\u30D6\u30EC\u30A4\u30F3\u30B9\u30C8\u30FC\u30E0",
      "\u5275\u9020\u7684",
      "\u60F3\u50CF",
      "\u0438\u0441\u0442\u043E\u0440\u0438\u044F",
      "\u0440\u0430\u0441\u0441\u043A\u0430\u0437",
      "\u0441\u0442\u0438\u0445\u043E\u0442\u0432\u043E\u0440\u0435\u043D\u0438\u0435",
      "\u0441\u043E\u0447\u0438\u043D\u0438\u0442\u044C",
      "\u0441\u043E\u0447\u0438\u043D\u0438",
      "\u043C\u043E\u0437\u0433\u043E\u0432\u043E\u0439 \u0448\u0442\u0443\u0440\u043C",
      "\u0442\u0432\u043E\u0440\u0447\u0435\u0441\u043A\u0438\u0439",
      "\u043F\u0440\u0435\u0434\u0441\u0442\u0430\u0432\u0438\u0442\u044C",
      "\u043F\u0440\u0438\u0434\u0443\u043C\u0430\u0439",
      "\u043D\u0430\u043F\u0438\u0448\u0438",
      "geschichte",
      "gedicht",
      "komponieren",
      "brainstorming",
      "kreativ",
      "vorstellen",
      "schreibe",
      "erz\xE4hlung"
    ],
    imperativeVerbs: [
      "build",
      "create",
      "implement",
      "design",
      "develop",
      "construct",
      "generate",
      "deploy",
      "configure",
      "set up",
      "\u6784\u5EFA",
      "\u521B\u5EFA",
      "\u5B9E\u73B0",
      "\u8BBE\u8BA1",
      "\u5F00\u53D1",
      "\u751F\u6210",
      "\u90E8\u7F72",
      "\u914D\u7F6E",
      "\u8BBE\u7F6E",
      "\u69CB\u7BC9",
      "\u4F5C\u6210",
      "\u5B9F\u88C5",
      "\u8A2D\u8A08",
      "\u958B\u767A",
      "\u751F\u6210",
      "\u30C7\u30D7\u30ED\u30A4",
      "\u8A2D\u5B9A",
      "\u043F\u043E\u0441\u0442\u0440\u043E\u0438\u0442\u044C",
      "\u043F\u043E\u0441\u0442\u0440\u043E\u0439",
      "\u0441\u043E\u0437\u0434\u0430\u0442\u044C",
      "\u0441\u043E\u0437\u0434\u0430\u0439",
      "\u0440\u0435\u0430\u043B\u0438\u0437\u043E\u0432\u0430\u0442\u044C",
      "\u0440\u0435\u0430\u043B\u0438\u0437\u0443\u0439",
      "\u0441\u043F\u0440\u043E\u0435\u043A\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C",
      "\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0430\u0439",
      "\u0441\u043A\u043E\u043D\u0441\u0442\u0440\u0443\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0439",
      "\u0440\u0430\u0437\u0432\u0435\u0440\u043D\u0443\u0442\u044C",
      "\u0440\u0430\u0437\u0432\u0435\u0440\u043D\u0438",
      "\u043D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C",
      "\u043D\u0430\u0441\u0442\u0440\u043E\u0439",
      "erstellen",
      "bauen",
      "implementieren",
      "entwerfen",
      "entwickeln",
      "konstruieren",
      "generieren",
      "bereitstellen",
      "konfigurieren",
      "einrichten"
    ],
    constraintIndicators: [
      "under",
      "at most",
      "at least",
      "within",
      "no more than",
      "o(",
      "maximum",
      "minimum",
      "limit",
      "budget",
      "\u4E0D\u8D85\u8FC7",
      "\u81F3\u5C11",
      "\u6700\u591A",
      "\u5728\u5185",
      "\u6700\u5927",
      "\u6700\u5C0F",
      "\u9650\u5236",
      "\u9884\u7B97",
      "\u4EE5\u4E0B",
      "\u6700\u5927",
      "\u6700\u5C0F",
      "\u5236\u9650",
      "\u4E88\u7B97",
      "\u043D\u0435 \u0431\u043E\u043B\u0435\u0435",
      "\u043D\u0435 \u043C\u0435\u043D\u0435\u0435",
      "\u043A\u0430\u043A \u043C\u0438\u043D\u0438\u043C\u0443\u043C",
      "\u0432 \u043F\u0440\u0435\u0434\u0435\u043B\u0430\u0445",
      "\u043C\u0430\u043A\u0441\u0438\u043C\u0443\u043C",
      "\u043C\u0438\u043D\u0438\u043C\u0443\u043C",
      "\u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435",
      "\u0431\u044E\u0434\u0436\u0435\u0442",
      "h\xF6chstens",
      "mindestens",
      "innerhalb",
      "nicht mehr als",
      "maximal",
      "minimal",
      "grenze",
      "budget"
    ],
    outputFormatKeywords: [
      "json",
      "yaml",
      "xml",
      "table",
      "csv",
      "markdown",
      "schema",
      "format as",
      "structured",
      "\u8868\u683C",
      "\u683C\u5F0F\u5316\u4E3A",
      "\u7ED3\u6784\u5316",
      "\u30C6\u30FC\u30D6\u30EB",
      "\u30D5\u30A9\u30FC\u30DE\u30C3\u30C8",
      "\u69CB\u9020\u5316",
      "\u0442\u0430\u0431\u043B\u0438\u0446\u0430",
      "\u0444\u043E\u0440\u043C\u0430\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043A\u0430\u043A",
      "\u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439",
      "tabelle",
      "formatieren als",
      "strukturiert"
    ],
    referenceKeywords: [
      "above",
      "below",
      "previous",
      "following",
      "the docs",
      "the api",
      "the code",
      "earlier",
      "attached",
      "\u4E0A\u9762",
      "\u4E0B\u9762",
      "\u4E4B\u524D",
      "\u63A5\u4E0B\u6765",
      "\u6587\u6863",
      "\u4EE3\u7801",
      "\u9644\u4EF6",
      "\u4E0A\u8A18",
      "\u4E0B\u8A18",
      "\u524D\u306E",
      "\u6B21\u306E",
      "\u30C9\u30AD\u30E5\u30E1\u30F3\u30C8",
      "\u30B3\u30FC\u30C9",
      "\u0432\u044B\u0448\u0435",
      "\u043D\u0438\u0436\u0435",
      "\u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0439",
      "\u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439",
      "\u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430\u0446\u0438\u044F",
      "\u043A\u043E\u0434",
      "\u0440\u0430\u043D\u0435\u0435",
      "\u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435",
      "oben",
      "unten",
      "vorherige",
      "folgende",
      "dokumentation",
      "der code",
      "fr\xFCher",
      "anhang"
    ],
    negationKeywords: [
      "don't",
      "do not",
      "avoid",
      "never",
      "without",
      "except",
      "exclude",
      "no longer",
      "\u4E0D\u8981",
      "\u907F\u514D",
      "\u4ECE\u4E0D",
      "\u6CA1\u6709",
      "\u9664\u4E86",
      "\u6392\u9664",
      "\u3057\u306A\u3044\u3067",
      "\u907F\u3051\u308B",
      "\u6C7A\u3057\u3066",
      "\u306A\u3057\u3067",
      "\u9664\u304F",
      "\u043D\u0435 \u0434\u0435\u043B\u0430\u0439",
      "\u043D\u0435 \u043D\u0430\u0434\u043E",
      "\u043D\u0435\u043B\u044C\u0437\u044F",
      "\u0438\u0437\u0431\u0435\u0433\u0430\u0442\u044C",
      "\u043D\u0438\u043A\u043E\u0433\u0434\u0430",
      "\u0431\u0435\u0437",
      "\u043A\u0440\u043E\u043C\u0435",
      "\u0438\u0441\u043A\u043B\u044E\u0447\u0438\u0442\u044C",
      "\u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435",
      "nicht",
      "vermeide",
      "niemals",
      "ohne",
      "au\xDFer",
      "ausschlie\xDFen",
      "nicht mehr"
    ],
    domainSpecificKeywords: [
      "quantum",
      "fpga",
      "vlsi",
      "risc-v",
      "asic",
      "photonics",
      "genomics",
      "proteomics",
      "topological",
      "homomorphic",
      "zero-knowledge",
      "lattice-based",
      "\u91CF\u5B50",
      "\u5149\u5B50\u5B66",
      "\u57FA\u56E0\u7EC4\u5B66",
      "\u86CB\u767D\u8D28\u7EC4\u5B66",
      "\u62D3\u6251",
      "\u540C\u6001",
      "\u96F6\u77E5\u8BC6",
      "\u683C\u5BC6\u7801",
      "\u91CF\u5B50",
      "\u30D5\u30A9\u30C8\u30CB\u30AF\u30B9",
      "\u30B2\u30CE\u30DF\u30AF\u30B9",
      "\u30C8\u30DD\u30ED\u30B8\u30AB\u30EB",
      "\u043A\u0432\u0430\u043D\u0442\u043E\u0432\u044B\u0439",
      "\u0444\u043E\u0442\u043E\u043D\u0438\u043A\u0430",
      "\u0433\u0435\u043D\u043E\u043C\u0438\u043A\u0430",
      "\u043F\u0440\u043E\u0442\u0435\u043E\u043C\u0438\u043A\u0430",
      "\u0442\u043E\u043F\u043E\u043B\u043E\u0433\u0438\u0447\u0435\u0441\u043A\u0438\u0439",
      "\u0433\u043E\u043C\u043E\u043C\u043E\u0440\u0444\u043D\u044B\u0439",
      "\u0441 \u043D\u0443\u043B\u0435\u0432\u044B\u043C \u0440\u0430\u0437\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0435\u043C",
      "\u043D\u0430 \u043E\u0441\u043D\u043E\u0432\u0435 \u0440\u0435\u0448\u0451\u0442\u043E\u043A",
      "quanten",
      "photonik",
      "genomik",
      "proteomik",
      "topologisch",
      "homomorph",
      "zero-knowledge",
      "gitterbasiert"
    ],
    agenticTaskKeywords: [
      "read file",
      "read the file",
      "look at",
      "check the",
      "open the",
      "edit",
      "modify",
      "update the",
      "change the",
      "write to",
      "create file",
      "execute",
      "deploy",
      "install",
      "npm",
      "pip",
      "compile",
      "after that",
      "and also",
      "once done",
      "step 1",
      "step 2",
      "fix",
      "debug",
      "until it works",
      "keep trying",
      "iterate",
      "make sure",
      "verify",
      "confirm",
      "\u8BFB\u53D6\u6587\u4EF6",
      "\u67E5\u770B",
      "\u6253\u5F00",
      "\u7F16\u8F91",
      "\u4FEE\u6539",
      "\u66F4\u65B0",
      "\u521B\u5EFA",
      "\u6267\u884C",
      "\u90E8\u7F72",
      "\u5B89\u88C5",
      "\u7B2C\u4E00\u6B65",
      "\u7B2C\u4E8C\u6B65",
      "\u4FEE\u590D",
      "\u8C03\u8BD5",
      "\u76F4\u5230",
      "\u786E\u8BA4",
      "\u9A8C\u8BC1"
    ],
    dimensionWeights: {
      tokenCount: 0.08,
      codePresence: 0.15,
      reasoningMarkers: 0.18,
      technicalTerms: 0.1,
      creativeMarkers: 0.05,
      simpleIndicators: 0.02,
      multiStepPatterns: 0.12,
      questionComplexity: 0.05,
      imperativeVerbs: 0.03,
      constraintCount: 0.04,
      outputFormat: 0.03,
      referenceComplexity: 0.02,
      negationComplexity: 0.01,
      domainSpecificity: 0.02,
      agenticTask: 0.04
    },
    tierBoundaries: {
      simpleMedium: 0,
      mediumComplex: 0.18,
      complexReasoning: 0.4
    },
    confidenceSteepness: 12,
    confidenceThreshold: 0.7
  },
  tiers: {
    SIMPLE: {
      primary: "google/gemini-2.5-flash",
      fallback: ["nvidia/gpt-oss-120b", "deepseek/deepseek-chat", "openai/gpt-4o-mini"]
    },
    MEDIUM: {
      primary: "xai/grok-code-fast-1",
      fallback: [
        "deepseek/deepseek-chat",
        "xai/grok-4-fast-non-reasoning",
        "google/gemini-2.5-flash"
      ]
    },
    COMPLEX: {
      primary: "google/gemini-2.5-pro",
      fallback: ["anthropic/claude-sonnet-4", "xai/grok-4-0709", "openai/gpt-4o"]
    },
    REASONING: {
      primary: "xai/grok-4-fast-reasoning",
      fallback: ["deepseek/deepseek-reasoner", "moonshot/kimi-k2.5", "google/gemini-2.5-pro"]
    }
  },
  agenticTiers: {
    SIMPLE: {
      primary: "anthropic/claude-haiku-4.5",
      fallback: ["moonshot/kimi-k2.5", "xai/grok-4-fast-non-reasoning", "openai/gpt-4o-mini"]
    },
    MEDIUM: {
      primary: "xai/grok-code-fast-1",
      fallback: ["moonshot/kimi-k2.5", "anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4"]
    },
    COMPLEX: {
      primary: "google/gemini-2.5-pro",
      fallback: ["anthropic/claude-sonnet-4", "xai/grok-4-0709", "openai/gpt-4o"]
    },
    REASONING: {
      primary: "anthropic/claude-sonnet-4",
      fallback: ["xai/grok-4-fast-reasoning", "moonshot/kimi-k2.5", "deepseek/deepseek-reasoner"]
    }
  },
  overrides: {
    maxTokensForceComplex: 1e5,
    structuredOutputMinTier: "MEDIUM",
    ambiguousDefaultTier: "MEDIUM",
    agenticMode: false
  }
};

// src/router/index.ts
function route(prompt, systemPrompt, maxOutputTokens, options) {
  const { config, modelPricing } = options;
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const estimatedTokens = Math.ceil(fullText.length / 4);
  const estimatedUserTokens = Math.ceil(prompt.length / 4);
  const ruleResult = classifyByRules(prompt, systemPrompt, estimatedUserTokens, config.scoring);
  const agenticScore = ruleResult.agenticScore ?? 0;
  const isAutoAgentic = agenticScore >= 0.75;
  const isExplicitAgentic = config.overrides.agenticMode ?? false;
  const useAgenticTiers = (isAutoAgentic || isExplicitAgentic) && config.agenticTiers != null;
  const tierConfigs = useAgenticTiers ? config.agenticTiers : config.tiers;
  if (estimatedUserTokens > config.overrides.maxTokensForceComplex) {
    return selectModel("COMPLEX", 0.95, "rules", `Input exceeds ${config.overrides.maxTokensForceComplex} tokens${useAgenticTiers ? " | agentic" : ""}`, tierConfigs, modelPricing, estimatedTokens, maxOutputTokens);
  }
  const hasStructuredOutput = systemPrompt ? /json|structured|schema/i.test(systemPrompt) : false;
  let tier;
  let confidence;
  const method = "rules";
  let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;
  if (ruleResult.tier !== null) {
    tier = ruleResult.tier;
    confidence = ruleResult.confidence;
  } else {
    tier = config.overrides.ambiguousDefaultTier;
    confidence = 0.5;
    reasoning += ` | ambiguous -> default: ${tier}`;
  }
  if (hasStructuredOutput) {
    const tierRank = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
    const minTier = config.overrides.structuredOutputMinTier;
    if (tierRank[tier] < tierRank[minTier]) {
      reasoning += ` | upgraded to ${minTier} (structured output)`;
      tier = minTier;
    }
  }
  if (isAutoAgentic) {
    reasoning += " | auto-agentic";
  } else if (isExplicitAgentic) {
    reasoning += " | agentic";
  }
  return selectModel(tier, confidence, method, reasoning, tierConfigs, modelPricing, estimatedTokens, maxOutputTokens);
}

// src/models.ts
var MODEL_ALIASES = {
  claude: "anthropic/claude-sonnet-4",
  sonnet: "anthropic/claude-sonnet-4",
  opus: "anthropic/claude-opus-4",
  haiku: "anthropic/claude-haiku-4.5",
  gpt: "openai/gpt-4o",
  gpt4: "openai/gpt-4o",
  gpt5: "openai/gpt-5.2",
  mini: "openai/gpt-4o-mini",
  o3: "openai/o3",
  deepseek: "deepseek/deepseek-chat",
  reasoner: "deepseek/deepseek-reasoner",
  kimi: "moonshot/kimi-k2.5",
  gemini: "google/gemini-2.5-pro",
  flash: "google/gemini-2.5-flash",
  grok: "xai/grok-3",
  "grok-fast": "xai/grok-4-fast-reasoning",
  "grok-code": "xai/grok-code-fast-1",
  nvidia: "nvidia/gpt-oss-120b",
  "gpt-120b": "nvidia/gpt-oss-120b",
  "gpt-20b": "nvidia/gpt-oss-20b",
  free: "nvidia/gpt-oss-120b"
};
function resolveModelAlias(model) {
  const normalized = model.trim().toLowerCase();
  const resolved = MODEL_ALIASES[normalized];
  if (resolved)
    return resolved;
  for (const prefix of ["blockrun/", "clawrouter/"]) {
    if (normalized.startsWith(prefix)) {
      const withoutPrefix = normalized.slice(prefix.length);
      const resolvedWithoutPrefix = MODEL_ALIASES[withoutPrefix];
      if (resolvedWithoutPrefix)
        return resolvedWithoutPrefix;
    }
  }
  return model;
}
var BLOCKRUN_MODELS = [
  {
    id: "auto",
    name: "BlockRun Smart Router",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1050000,
    maxOutput: 128000
  },
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    inputPrice: 1.75,
    outputPrice: 14,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    inputPrice: 0.25,
    outputPrice: 2,
    contextWindow: 200000,
    maxOutput: 65536
  },
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5 Nano",
    inputPrice: 0.05,
    outputPrice: 0.4,
    contextWindow: 128000,
    maxOutput: 32768
  },
  {
    id: "openai/gpt-5.2-pro",
    name: "GPT-5.2 Pro",
    inputPrice: 21,
    outputPrice: 168,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true
  },
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    inputPrice: 2,
    outputPrice: 8,
    contextWindow: 128000,
    maxOutput: 16384,
    vision: true
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    inputPrice: 0.4,
    outputPrice: 1.6,
    contextWindow: 128000,
    maxOutput: 16384
  },
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextWindow: 128000,
    maxOutput: 16384
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    inputPrice: 2.5,
    outputPrice: 10,
    contextWindow: 128000,
    maxOutput: 16384,
    vision: true,
    agentic: true
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 128000,
    maxOutput: 16384
  },
  {
    id: "openai/o1",
    name: "o1",
    inputPrice: 15,
    outputPrice: 60,
    contextWindow: 200000,
    maxOutput: 1e5,
    reasoning: true
  },
  {
    id: "openai/o1-mini",
    name: "o1-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true
  },
  {
    id: "openai/o3",
    name: "o3",
    inputPrice: 2,
    outputPrice: 8,
    contextWindow: 200000,
    maxOutput: 1e5,
    reasoning: true
  },
  {
    id: "openai/o3-mini",
    name: "o3-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    inputPrice: 1,
    outputPrice: 5,
    contextWindow: 200000,
    maxOutput: 8192,
    agentic: true
  },
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    inputPrice: 3,
    outputPrice: 15,
    contextWindow: 200000,
    maxOutput: 64000,
    reasoning: true,
    agentic: true
  },
  {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    inputPrice: 15,
    outputPrice: 75,
    contextWindow: 200000,
    maxOutput: 32000,
    reasoning: true,
    agentic: true
  },
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    inputPrice: 5,
    outputPrice: 25,
    contextWindow: 200000,
    maxOutput: 32000,
    reasoning: true,
    agentic: true
  },
  {
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    inputPrice: 2,
    outputPrice: 12,
    contextWindow: 1050000,
    maxOutput: 65536,
    reasoning: true,
    vision: true
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    inputPrice: 1.25,
    outputPrice: 10,
    contextWindow: 1050000,
    maxOutput: 65536,
    reasoning: true,
    vision: true
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 1e6,
    maxOutput: 65536
  },
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3.2 Chat",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128000,
    maxOutput: 8192
  },
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek V3.2 Reasoner",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128000,
    maxOutput: 8192,
    reasoning: true
  },
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    inputPrice: 0.5,
    outputPrice: 2.4,
    contextWindow: 262144,
    maxOutput: 8192,
    reasoning: true,
    vision: true,
    agentic: true
  },
  {
    id: "xai/grok-3",
    name: "Grok 3",
    inputPrice: 3,
    outputPrice: 15,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  {
    id: "xai/grok-3-fast",
    name: "Grok 3 Fast",
    inputPrice: 5,
    outputPrice: 25,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  {
    id: "xai/grok-3-mini",
    name: "Grok 3 Mini",
    inputPrice: 0.3,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384
  },
  {
    id: "xai/grok-4-fast-reasoning",
    name: "Grok 4 Fast Reasoning",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  {
    id: "xai/grok-4-fast-non-reasoning",
    name: "Grok 4 Fast",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384
  },
  {
    id: "xai/grok-4-1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  {
    id: "xai/grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384
  },
  {
    id: "xai/grok-code-fast-1",
    name: "Grok Code Fast",
    inputPrice: 0.2,
    outputPrice: 1.5,
    contextWindow: 131072,
    maxOutput: 16384,
    agentic: true
  },
  {
    id: "xai/grok-4-0709",
    name: "Grok 4 (0709)",
    inputPrice: 3,
    outputPrice: 15,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  {
    id: "xai/grok-2-vision",
    name: "Grok 2 Vision",
    inputPrice: 2,
    outputPrice: 10,
    contextWindow: 131072,
    maxOutput: 16384,
    vision: true
  },
  {
    id: "nvidia/gpt-oss-120b",
    name: "NVIDIA GPT-OSS 120B",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    maxOutput: 16384
  },
  {
    id: "nvidia/gpt-oss-20b",
    name: "NVIDIA GPT-OSS 20B",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    maxOutput: 16384
  },
  {
    id: "nvidia/kimi-k2.5",
    name: "NVIDIA Kimi K2.5",
    inputPrice: 0.001,
    outputPrice: 0.001,
    contextWindow: 262144,
    maxOutput: 16384
  }
];
function toOpenClawModel(m) {
  return {
    id: m.id,
    name: m.name,
    api: "openai-completions",
    reasoning: m.reasoning ?? false,
    input: m.vision ? ["text", "image"] : ["text"],
    cost: {
      input: m.inputPrice,
      output: m.outputPrice,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutput
  };
}
var ALIAS_MODELS = Object.entries(MODEL_ALIASES).map(([alias, targetId]) => {
  const target = BLOCKRUN_MODELS.find((m) => m.id === targetId);
  if (!target)
    return null;
  return toOpenClawModel({ ...target, id: alias, name: `${alias} \u2192 ${target.name}` });
}).filter((m) => m !== null);
var OPENCLAW_MODELS = [
  ...BLOCKRUN_MODELS.map(toOpenClawModel),
  ...ALIAS_MODELS
];
function buildProviderModels(baseUrl) {
  return {
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    models: OPENCLAW_MODELS
  };
}
function isAgenticModel(modelId) {
  const model = BLOCKRUN_MODELS.find((m) => m.id === modelId || m.id === modelId.replace("blockrun/", ""));
  return model?.agentic ?? false;
}
function getAgenticModels() {
  return BLOCKRUN_MODELS.filter((m) => m.agentic).map((m) => m.id);
}
function getModelContextWindow(modelId) {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.contextWindow;
}

// src/stats.ts
import { readFile, readdir } from "fs";
import { join as join2 } from "path";
import { homedir as homedir2 } from "os";
var LOG_DIR = join2(homedir2(), ".openclaw", "clawrouter", "logs");
async function parseLogFile(filePath) {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split(`
`).filter(Boolean);
    return lines.map((line) => {
      const entry = JSON.parse(line);
      return {
        timestamp: entry.timestamp || new Date().toISOString(),
        model: entry.model || "unknown",
        tier: entry.tier || "UNKNOWN",
        cost: entry.cost || 0,
        baselineCost: entry.baselineCost || entry.cost || 0,
        savings: entry.savings || 0,
        latencyMs: entry.latencyMs || 0
      };
    });
  } catch {
    return [];
  }
}
async function getLogFiles() {
  try {
    const files = await readdir(LOG_DIR);
    return files.filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
}
function aggregateDay(date, entries) {
  const byTier = {};
  const byModel = {};
  let totalLatency = 0;
  for (const entry of entries) {
    if (!byTier[entry.tier])
      byTier[entry.tier] = { count: 0, cost: 0 };
    byTier[entry.tier].count++;
    byTier[entry.tier].cost += entry.cost;
    if (!byModel[entry.model])
      byModel[entry.model] = { count: 0, cost: 0 };
    byModel[entry.model].count++;
    byModel[entry.model].cost += entry.cost;
    totalLatency += entry.latencyMs;
  }
  const totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  const totalBaselineCost = entries.reduce((sum, e) => sum + e.baselineCost, 0);
  return {
    date,
    totalRequests: entries.length,
    totalCost,
    totalBaselineCost,
    totalSavings: totalBaselineCost - totalCost,
    avgLatencyMs: entries.length > 0 ? totalLatency / entries.length : 0,
    byTier,
    byModel
  };
}
async function getStats(days = 7) {
  const logFiles = await getLogFiles();
  const filesToRead = logFiles.slice(0, days);
  const dailyBreakdown = [];
  const allByTier = {};
  const allByModel = {};
  let totalRequests = 0;
  let totalCost = 0;
  let totalBaselineCost = 0;
  let totalLatency = 0;
  for (const file of filesToRead) {
    const date = file.replace("usage-", "").replace(".jsonl", "");
    const filePath = join2(LOG_DIR, file);
    const entries = await parseLogFile(filePath);
    if (entries.length === 0)
      continue;
    const dayStats = aggregateDay(date, entries);
    dailyBreakdown.push(dayStats);
    totalRequests += dayStats.totalRequests;
    totalCost += dayStats.totalCost;
    totalBaselineCost += dayStats.totalBaselineCost;
    totalLatency += dayStats.avgLatencyMs * dayStats.totalRequests;
    for (const [tier, stats] of Object.entries(dayStats.byTier)) {
      if (!allByTier[tier])
        allByTier[tier] = { count: 0, cost: 0 };
      allByTier[tier].count += stats.count;
      allByTier[tier].cost += stats.cost;
    }
    for (const [model, stats] of Object.entries(dayStats.byModel)) {
      if (!allByModel[model])
        allByModel[model] = { count: 0, cost: 0 };
      allByModel[model].count += stats.count;
      allByModel[model].cost += stats.cost;
    }
  }
  const byTierWithPercentage = {};
  for (const [tier, stats] of Object.entries(allByTier)) {
    byTierWithPercentage[tier] = {
      ...stats,
      percentage: totalRequests > 0 ? stats.count / totalRequests * 100 : 0
    };
  }
  const byModelWithPercentage = {};
  for (const [model, stats] of Object.entries(allByModel)) {
    byModelWithPercentage[model] = {
      ...stats,
      percentage: totalRequests > 0 ? stats.count / totalRequests * 100 : 0
    };
  }
  const totalSavings = totalBaselineCost - totalCost;
  const savingsPercentage = totalBaselineCost > 0 ? totalSavings / totalBaselineCost * 100 : 0;
  return {
    period: days === 1 ? "today" : `last ${days} days`,
    totalRequests,
    totalCost,
    totalBaselineCost,
    totalSavings,
    savingsPercentage,
    avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
    avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
    byTier: byTierWithPercentage,
    byModel: byModelWithPercentage,
    dailyBreakdown: dailyBreakdown.reverse()
  };
}
function formatStatsAscii(stats) {
  const lines = [];
  lines.push("\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  lines.push("\u2551              ClawRouter Usage Statistics                   \u2551");
  lines.push("\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563");
  lines.push(`\u2551  Period: ${stats.period.padEnd(49)}\u2551`);
  lines.push(`\u2551  Total Requests: ${stats.totalRequests.toString().padEnd(41)}\u2551`);
  lines.push(`\u2551  Total Cost: $${stats.totalCost.toFixed(4).padEnd(43)}\u2551`);
  lines.push(`\u2551  Baseline Cost (Opus): $${stats.totalBaselineCost.toFixed(4).padEnd(33)}\u2551`);
  lines.push(`\u2551  \uD83D\uDCB0 Total Saved: $${stats.totalSavings.toFixed(4)} (${stats.savingsPercentage.toFixed(1)}%)`.padEnd(61) + "\u2551");
  lines.push(`\u2551  Avg Latency: ${stats.avgLatencyMs.toFixed(0)}ms`.padEnd(61) + "\u2551");
  lines.push("\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563");
  lines.push("\u2551  Routing by Tier:                                          \u2551");
  const tierOrder = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
  for (const tier of tierOrder) {
    const data = stats.byTier[tier];
    if (data) {
      const bar = "\u2588".repeat(Math.min(20, Math.round(data.percentage / 5)));
      const line = `\u2551    ${tier.padEnd(10)} ${bar.padEnd(20)} ${data.percentage.toFixed(1).padStart(5)}% (${data.count})`;
      lines.push(line.padEnd(61) + "\u2551");
    }
  }
  lines.push("\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563");
  lines.push("\u2551  Top Models:                                               \u2551");
  const sortedModels = Object.entries(stats.byModel).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  for (const [model, data] of sortedModels) {
    const shortModel = model.length > 25 ? model.slice(0, 22) + "..." : model;
    const line = `\u2551    ${shortModel.padEnd(25)} ${data.count.toString().padStart(5)} reqs  $${data.cost.toFixed(4)}`;
    lines.push(line.padEnd(61) + "\u2551");
  }
  if (stats.dailyBreakdown.length > 0) {
    lines.push("\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563");
    lines.push("\u2551  Daily Breakdown:                                          \u2551");
    lines.push("\u2551    Date        Requests    Cost      Saved                 \u2551");
    for (const day of stats.dailyBreakdown.slice(-7)) {
      const saved = day.totalBaselineCost - day.totalCost;
      const line = `\u2551    ${day.date}   ${day.totalRequests.toString().padStart(6)}    $${day.totalCost.toFixed(4).padStart(8)}  $${saved.toFixed(4)}`;
      lines.push(line.padEnd(61) + "\u2551");
    }
  }
  lines.push("\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D");
  return lines.join(`
`);
}

// src/dedup.ts
import { createHash } from "crypto";
var DEFAULT_TTL_MS = 30000;
var MAX_BODY_SIZE = 1048576;
function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}
var TIMESTAMP_PATTERN = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;
function stripTimestamps(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(stripTimestamps);
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "content" && typeof value === "string") {
      result[key] = value.replace(TIMESTAMP_PATTERN, "");
    } else {
      result[key] = stripTimestamps(value);
    }
  }
  return result;
}

class RequestDeduplicator {
  inflight = new Map;
  completed = new Map;
  ttlMs;
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }
  static hash(body) {
    let content = body;
    try {
      const parsed = JSON.parse(body.toString());
      const stripped = stripTimestamps(parsed);
      const canonical = canonicalize(stripped);
      content = Buffer.from(JSON.stringify(canonical));
    } catch {}
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }
  getCached(key) {
    const entry = this.completed.get(key);
    if (!entry)
      return;
    if (Date.now() - entry.completedAt > this.ttlMs) {
      this.completed.delete(key);
      return;
    }
    return entry;
  }
  getInflight(key) {
    const entry = this.inflight.get(key);
    if (!entry)
      return;
    const promise = new Promise((resolve) => {
      entry.waiters.push(new Promise((r) => {
        const orig = entry.resolve;
        entry.resolve = (result) => {
          orig(result);
          resolve(result);
          r(result);
        };
      }));
    });
    return promise;
  }
  markInflight(key) {
    this.inflight.set(key, {
      resolve: () => {},
      waiters: []
    });
  }
  complete(key, result) {
    if (result.body.length <= MAX_BODY_SIZE) {
      this.completed.set(key, result);
    }
    const entry = this.inflight.get(key);
    if (entry) {
      entry.resolve(result);
      this.inflight.delete(key);
    }
    this.prune();
  }
  removeInflight(key) {
    this.inflight.delete(key);
  }
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.completed) {
      if (now - entry.completedAt > this.ttlMs) {
        this.completed.delete(key);
      }
    }
  }
}

// src/version.ts
import { join as join3, dirname } from "path";
var __filename2 = import.meta.url.replace("file://", "");
var __dirname2 = dirname(__filename2);
var pkgPath = join3(__dirname2, "..", "package.json");
var pkg = await import("fs").then((m) => m.readFileSync(pkgPath, "utf-8")).then(JSON.parse);
var VERSION = pkg.version;
var USER_AGENT = `clawrouter/${VERSION}`;

// src/session.ts
var DEFAULT_SESSION_CONFIG = {
  enabled: false,
  timeoutMs: 30 * 60 * 1000,
  headerName: "x-session-id"
};

class SessionStore {
  sessions = new Map;
  config;
  cleanupInterval = null;
  constructor(config = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
    if (this.config.enabled) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }
  }
  getSession(sessionId) {
    if (!this.config.enabled || !sessionId) {
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }
    const now = Date.now();
    if (now - entry.lastUsedAt > this.config.timeoutMs) {
      this.sessions.delete(sessionId);
      return;
    }
    return entry;
  }
  setSession(sessionId, model, tier) {
    if (!this.config.enabled || !sessionId) {
      return;
    }
    const existing = this.sessions.get(sessionId);
    const now = Date.now();
    if (existing) {
      existing.lastUsedAt = now;
      existing.requestCount++;
      if (existing.model !== model) {
        existing.model = model;
        existing.tier = tier;
      }
    } else {
      this.sessions.set(sessionId, {
        model,
        tier,
        createdAt: now,
        lastUsedAt: now,
        requestCount: 1
      });
    }
  }
  touchSession(sessionId) {
    if (!this.config.enabled || !sessionId) {
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      entry.requestCount++;
    }
  }
  clearSession(sessionId) {
    this.sessions.delete(sessionId);
  }
  clearAll() {
    this.sessions.clear();
  }
  getStats() {
    const now = Date.now();
    const sessions = Array.from(this.sessions.entries()).map(([id, entry]) => ({
      id: id.slice(0, 8) + "...",
      model: entry.model,
      age: Math.round((now - entry.createdAt) / 1000)
    }));
    return { count: this.sessions.size, sessions };
  }
  cleanup() {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsedAt > this.config.timeoutMs) {
        this.sessions.delete(id);
      }
    }
  }
  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
function getSessionId(headers, headerName = DEFAULT_SESSION_CONFIG.headerName) {
  const value = headers[headerName] || headers[headerName.toLowerCase()];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return;
}

// src/openrouter-models.ts
var cache = null;
var cacheTime = 0;
var CACHE_TTL_MS = 3600000;
async function refreshOpenRouterModels(apiKey) {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: {
      authorization: `Bearer ${apiKey}`,
      "user-agent": "ClawRouter"
    }
  });
  if (!response.ok) {
    throw new Error(`OpenRouter /models returned ${response.status}`);
  }
  const json = await response.json();
  const orModels = json.data;
  if (!Array.isArray(orModels)) {
    throw new Error("OpenRouter /models response missing data array");
  }
  const orIdSet = new Set(orModels.map((m) => m.id));
  const nameToOrId = new Map;
  for (const m of orModels) {
    const slash = m.id.indexOf("/");
    if (slash > 0) {
      const namePart = m.id.slice(slash + 1);
      if (!nameToOrId.has(namePart)) {
        nameToOrId.set(namePart, m.id);
      }
    }
  }
  const newCache = new Map;
  for (const model of BLOCKRUN_MODELS) {
    if (model.id === "auto")
      continue;
    if (orIdSet.has(model.id)) {
      newCache.set(model.id, model.id);
      continue;
    }
    const slash = model.id.indexOf("/");
    if (slash > 0) {
      const namePart = model.id.slice(slash + 1);
      const orId = nameToOrId.get(namePart);
      if (orId) {
        newCache.set(model.id, orId);
        continue;
      }
    }
  }
  cache = newCache;
  cacheTime = Date.now();
  const mapped = [...newCache.entries()].filter(([k, v]) => k !== v);
  console.log(`[ClawRouter] Loaded ${orModels.length} OpenRouter models, ${newCache.size} mapped (${mapped.length} remapped)`);
  if (mapped.length > 0) {
    for (const [from, to] of mapped) {
      console.log(`[ClawRouter]   ${from} \u2192 ${to}`);
    }
  }
}
function resolveOpenRouterModelId(clawrouterModelId) {
  if (!cache)
    return clawrouterModelId;
  return cache.get(clawrouterModelId) ?? clawrouterModelId;
}
function isOpenRouterCacheReady() {
  return cache !== null && Date.now() - cacheTime < CACHE_TTL_MS;
}
function ensureOpenRouterCache(apiKey) {
  if (isOpenRouterCacheReady())
    return;
  refreshOpenRouterModels(apiKey).catch((err) => {
    console.error(`[ClawRouter] Background OpenRouter cache refresh failed: ${err.message}`);
  });
}

// src/proxy.ts
var AUTO_MODEL = "clawrouter/auto";
var AUTO_MODEL_SHORT = "auto";
var HEARTBEAT_INTERVAL_MS = 2000;
var DEFAULT_REQUEST_TIMEOUT_MS = 180000;
var DEFAULT_PORT = 8403;
var MAX_FALLBACK_ATTEMPTS = 3;
var HEALTH_CHECK_TIMEOUT_MS = 2000;
var RATE_LIMIT_COOLDOWN_MS = 60000;
var rateLimitedModels = new Map;
function isRateLimited(modelId) {
  const hitTime = rateLimitedModels.get(modelId);
  if (!hitTime)
    return false;
  if (Date.now() - hitTime >= RATE_LIMIT_COOLDOWN_MS) {
    rateLimitedModels.delete(modelId);
    return false;
  }
  return true;
}
function markRateLimited(modelId) {
  rateLimitedModels.set(modelId, Date.now());
  console.log(`[ClawRouter] Model ${modelId} rate-limited, will deprioritize for 60s`);
}
function prioritizeNonRateLimited(models) {
  const available = [];
  const limited = [];
  for (const model of models) {
    (isRateLimited(model) ? limited : available).push(model);
  }
  return [...available, ...limited];
}
function getProxyPort() {
  const envPort = process.env.CLAWROUTER_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536)
      return parsed;
  }
  return DEFAULT_PORT;
}
async function checkExistingProxy(port) {
  const controller = new AbortController;
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      return data.status === "ok";
    }
    return false;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}
var PROVIDER_ERROR_PATTERNS = [
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
  /authentication.*failed/i
];
var FALLBACK_STATUS_CODES = [400, 401, 402, 403, 404, 405, 429, 500, 502, 503, 504];
function isProviderError(status, body) {
  if (!FALLBACK_STATUS_CODES.includes(status))
    return false;
  if (status >= 500)
    return true;
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(body));
}
var VALID_ROLES = new Set(["system", "user", "assistant", "tool", "function"]);
var ROLE_MAPPINGS = { developer: "system", model: "assistant" };
var VALID_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
function sanitizeToolId(id) {
  if (!id || typeof id !== "string")
    return id;
  if (VALID_TOOL_ID_PATTERN.test(id))
    return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function sanitizeToolIds(messages) {
  if (!messages || messages.length === 0)
    return messages;
  let hasChanges = false;
  const sanitized = messages.map((msg) => {
    const typedMsg = msg;
    let msgChanged = false;
    let newMsg = { ...msg };
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
      if (msgChanged)
        newMsg = { ...newMsg, tool_calls: newToolCalls };
    }
    if (typedMsg.tool_call_id && typeof typedMsg.tool_call_id === "string") {
      const s = sanitizeToolId(typedMsg.tool_call_id);
      if (s !== typedMsg.tool_call_id) {
        msgChanged = true;
        newMsg = { ...newMsg, tool_call_id: s };
      }
    }
    if (Array.isArray(typedMsg.content)) {
      const newContent = typedMsg.content.map((block) => {
        if (!block || typeof block !== "object")
          return block;
        let blockChanged = false;
        let newBlock = { ...block };
        if (block.type === "tool_use" && block.id && typeof block.id === "string") {
          const s = sanitizeToolId(block.id);
          if (s !== block.id) {
            blockChanged = true;
            newBlock = { ...newBlock, id: s };
          }
        }
        if (block.type === "tool_result" && block.tool_use_id && typeof block.tool_use_id === "string") {
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
      if (msgChanged)
        newMsg = { ...newMsg, content: newContent };
    }
    if (msgChanged) {
      hasChanges = true;
      return newMsg;
    }
    return msg;
  });
  return hasChanges ? sanitized : messages;
}
function normalizeMessageRoles(messages) {
  if (!messages || messages.length === 0)
    return messages;
  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (VALID_ROLES.has(msg.role))
      return msg;
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
function normalizeMessagesForGoogle(messages) {
  if (!messages || messages.length === 0)
    return messages;
  let firstNonSystemIdx = -1;
  for (let i = 0;i < messages.length; i++) {
    if (messages[i].role !== "system") {
      firstNonSystemIdx = i;
      break;
    }
  }
  if (firstNonSystemIdx === -1)
    return messages;
  const firstRole = messages[firstNonSystemIdx].role;
  if (firstRole === "user")
    return messages;
  if (firstRole === "assistant" || firstRole === "model") {
    const normalized = [...messages];
    normalized.splice(firstNonSystemIdx, 0, { role: "user", content: "(continuing conversation)" });
    return normalized;
  }
  return messages;
}
function isGoogleModel(modelId) {
  return modelId.startsWith("google/") || modelId.startsWith("gemini");
}
function normalizeMessagesForThinking(messages) {
  if (!messages || messages.length === 0)
    return messages;
  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 && msg.reasoning_content === undefined) {
      hasChanges = true;
      return { ...msg, reasoning_content: "" };
    }
    return msg;
  });
  return hasChanges ? normalized : messages;
}
var KIMI_BLOCK_RE = /<[\uFF5C|][^<>]*begin[^<>]*[\uFF5C|]>[\s\S]*?<[\uFF5C|][^<>]*end[^<>]*[\uFF5C|]>/gi;
var KIMI_TOKEN_RE = /<[\uFF5C|][^<>]*[\uFF5C|]>/g;
var THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>/gi;
var THINKING_BLOCK_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
function stripThinkingTokens(content) {
  if (!content)
    return content;
  let cleaned = content.replace(KIMI_BLOCK_RE, "");
  cleaned = cleaned.replace(KIMI_TOKEN_RE, "");
  cleaned = cleaned.replace(THINKING_BLOCK_RE, "");
  cleaned = cleaned.replace(THINKING_TAG_RE, "");
  return cleaned;
}
function convertToAnthropicFormat(parsed) {
  const messages = parsed.messages || [];
  let system;
  const nonSystemMessages = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    } else {
      nonSystemMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content
      });
    }
  }
  const result = {
    model: parsed.model,
    messages: nonSystemMessages,
    max_tokens: parsed.max_tokens || 4096
  };
  if (system)
    result.system = system;
  if (parsed.stream)
    result.stream = true;
  if (parsed.temperature !== undefined)
    result.temperature = parsed.temperature;
  if (parsed.top_p !== undefined)
    result.top_p = parsed.top_p;
  if (parsed.tools)
    result.tools = parsed.tools;
  return result;
}
function convertAnthropicResponseToOpenAI(anthropicData) {
  const content = anthropicData.content;
  const textContent = content?.filter((b) => b.type === "text").map((b) => b.text).join("") || "";
  return {
    id: anthropicData.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropicData.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent
        },
        finish_reason: anthropicData.stop_reason === "end_turn" ? "stop" : anthropicData.stop_reason || "stop"
      }
    ],
    usage: anthropicData.usage ? {
      prompt_tokens: anthropicData.usage.input_tokens || 0,
      completion_tokens: anthropicData.usage.output_tokens || 0,
      total_tokens: (anthropicData.usage.input_tokens || 0) + (anthropicData.usage.output_tokens || 0)
    } : undefined
  };
}
function buildModelPricing() {
  const map = new Map;
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === "auto")
      continue;
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }
  return map;
}
function mergeRoutingConfig(overrides) {
  if (!overrides)
    return DEFAULT_ROUTING_CONFIG;
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...overrides,
    classifier: { ...DEFAULT_ROUTING_CONFIG.classifier, ...overrides.classifier },
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...overrides.scoring },
    tiers: { ...DEFAULT_ROUTING_CONFIG.tiers, ...overrides.tiers },
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...overrides.overrides }
  };
}
function buildUpstreamUrl(modelId, path, apiKeys) {
  const access = resolveProviderAccess(apiKeys, modelId);
  if (!access)
    return;
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
      viaOpenRouter: true
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
      viaOpenRouter: false
    };
  }
  if (provider === "anthropic") {
    const ANTHROPIC_MODEL_MAP = {
      "claude-sonnet-4": "claude-sonnet-4-20250514",
      "claude-opus-4": "claude-opus-4-20250514",
      "claude-opus-4.5": "claude-opus-4-20250514",
      "claude-haiku-4.5": "claude-haiku-4-20250414"
    };
    const mappedModel = ANTHROPIC_MODEL_MAP[actualModelId] || actualModelId;
    return {
      url: `${baseUrl}/messages`,
      provider,
      apiKey,
      actualModelId: mappedModel,
      viaOpenRouter: false
    };
  }
  return {
    url: `${baseUrl}${normalizedPath}`,
    provider,
    apiKey,
    actualModelId,
    viaOpenRouter: false
  };
}
function buildProviderHeaders(provider, apiKey, viaOpenRouter = false) {
  const headers = {
    "content-type": "application/json",
    "user-agent": USER_AGENT
  };
  if (viaOpenRouter) {
    headers["authorization"] = `Bearer ${apiKey}`;
    headers["x-title"] = "ClawRouter";
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
async function tryModelRequest(modelId, path, method, body, maxTokens, apiKeys, signal) {
  const upstream = buildUpstreamUrl(modelId, path, apiKeys);
  if (!upstream) {
    return {
      success: false,
      errorBody: `No API key configured for provider: ${getProviderFromModel(modelId)} (and no OpenRouter fallback)`,
      errorStatus: 401,
      isProviderError: true
    };
  }
  let requestBody = body;
  try {
    const parsed = JSON.parse(body.toString());
    parsed.model = upstream.actualModelId;
    if (Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessageRoles(parsed.messages);
      parsed.messages = sanitizeToolIds(parsed.messages);
    }
    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages);
    }
    if (parsed.thinking && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForThinking(parsed.messages);
    }
    if (upstream.provider === "anthropic" && !upstream.viaOpenRouter) {
      const anthropicBody = convertToAnthropicFormat(parsed);
      requestBody = Buffer.from(JSON.stringify(anthropicBody));
    } else {
      requestBody = Buffer.from(JSON.stringify(parsed));
    }
  } catch {}
  const headers = buildProviderHeaders(upstream.provider, upstream.apiKey, upstream.viaOpenRouter);
  try {
    console.log(`[ClawRouter] \u2192 ${upstream.provider} ${upstream.url} model=${upstream.actualModelId} viaOR=${upstream.viaOpenRouter}`);
    const response = await fetch(upstream.url, {
      method,
      headers,
      body: requestBody.length > 0 ? new Uint8Array(requestBody) : undefined,
      signal
    });
    if (response.status !== 200) {
      const errorBody = await response.text();
      console.log(`[ClawRouter] \u2190 ${response.status} ${errorBody.slice(0, 200)}`);
      return {
        success: false,
        errorBody,
        errorStatus: response.status,
        isProviderError: isProviderError(response.status, errorBody)
      };
    }
    return { success: true, response };
  } catch (err) {
    return {
      success: false,
      errorBody: err instanceof Error ? err.message : String(err),
      errorStatus: 500,
      isProviderError: true
    };
  }
}
async function handleChatCompletion(req, options, routerOpts, deduplicator, sessionStore) {
  const startTime = Date.now();
  const requestPath = req.url || "/v1/chat/completions";
  const body = Buffer.from(await req.arrayBuffer());
  let routingDecision;
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  let modifiedBody = body;
  try {
    const parsed = JSON.parse(body.toString());
    isStreaming = parsed.stream === true;
    modelId = parsed.model || "";
    maxTokens = parsed.max_tokens || 4096;
    const normalizedModel = typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";
    const resolvedModel = resolveModelAlias(normalizedModel);
    const wasAlias = resolvedModel !== normalizedModel;
    const isAutoModel = normalizedModel === AUTO_MODEL.toLowerCase() || normalizedModel === AUTO_MODEL_SHORT.toLowerCase() || normalizedModel === "blockrun/auto" || normalizedModel === "clawrouter/auto";
    console.log(`[ClawRouter] Received model: "${parsed.model}" -> normalized: "${normalizedModel}"${wasAlias ? ` -> alias: "${resolvedModel}"` : ""}, isAuto: ${isAutoModel}`);
    if (wasAlias && !isAutoModel) {
      parsed.model = resolvedModel;
      modelId = resolvedModel;
    }
    if (isAutoModel) {
      const headers = Object.fromEntries(req.headers.entries());
      const sessionId = getSessionId(headers);
      const existingSession = sessionId ? sessionStore.getSession(sessionId) : undefined;
      if (existingSession) {
        console.log(`[ClawRouter] Session ${sessionId?.slice(0, 8)}... using pinned model: ${existingSession.model}`);
        parsed.model = existingSession.model;
        modelId = existingSession.model;
        sessionStore.touchSession(sessionId);
      } else {
        let extractText = function(content) {
          if (typeof content === "string")
            return content;
          if (Array.isArray(content)) {
            return content.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join(`
`);
          }
          return "";
        };
        const messages = parsed.messages;
        let lastUserMsg;
        if (messages) {
          for (let i = messages.length - 1;i >= 0; i--) {
            if (messages[i].role === "user") {
              lastUserMsg = messages[i];
              break;
            }
          }
        }
        const systemMsg = messages?.find((m) => m.role === "system");
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
              reasoning: routingDecision.reasoning + ` | rerouted to ${available} (key available)`
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
    console.error(`[ClawRouter] Routing error: ${errorMsg}`);
    options.onError?.(new Error(`Routing failed: ${errorMsg}`));
  }
  const dedupKey = RequestDeduplicator.hash(modifiedBody);
  const cached = deduplicator.getCached(dedupKey);
  if (cached) {
    return new Response(new Uint8Array(cached.body), {
      status: cached.status,
      headers: cached.headers
    });
  }
  const inflight = deduplicator.getInflight(dedupKey);
  if (inflight) {
    const result = await inflight;
    return new Response(new Uint8Array(result.body), {
      status: result.status,
      headers: result.headers
    });
  }
  deduplicator.markInflight(dedupKey);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let modelsToTry;
    if (routingDecision) {
      const estimatedInputTokens = Math.ceil(modifiedBody.length / 4);
      const estimatedTotalTokens = estimatedInputTokens + maxTokens;
      const useAgenticTiers = routingDecision.reasoning?.includes("agentic") && routerOpts.config.agenticTiers;
      const tierConfigs = useAgenticTiers ? routerOpts.config.agenticTiers : routerOpts.config.tiers;
      const contextFiltered = getFallbackChainFiltered(routingDecision.tier, tierConfigs, estimatedTotalTokens, getModelContextWindow);
      modelsToTry = contextFiltered.slice(0, MAX_FALLBACK_ATTEMPTS);
      modelsToTry = modelsToTry.filter((m) => isModelAccessible(options.apiKeys, m));
      modelsToTry = prioritizeNonRateLimited(modelsToTry);
    } else {
      modelsToTry = modelId ? [modelId] : [];
    }
    let upstream;
    let lastError;
    let actualModelUsed = modelId;
    for (let i = 0;i < modelsToTry.length; i++) {
      const tryModel = modelsToTry[i];
      const isLastAttempt = i === modelsToTry.length - 1;
      console.log(`[ClawRouter] Trying model ${i + 1}/${modelsToTry.length}: ${tryModel}`);
      const result = await tryModelRequest(tryModel, requestPath, req.method ?? "POST", modifiedBody, maxTokens, options.apiKeys, controller.signal);
      if (result.success && result.response) {
        upstream = result.response;
        actualModelUsed = tryModel;
        console.log(`[ClawRouter] Success with model: ${tryModel}`);
        break;
      }
      lastError = { body: result.errorBody || "Unknown error", status: result.errorStatus || 500 };
      if (result.isProviderError && !isLastAttempt) {
        if (result.errorStatus === 429)
          markRateLimited(tryModel);
        console.log(`[ClawRouter] Provider error from ${tryModel}, trying fallback: ${result.errorBody?.slice(0, 100)}`);
        continue;
      }
      break;
    }
    clearTimeout(timeoutId);
    if (routingDecision && actualModelUsed !== routingDecision.model) {
      routingDecision = {
        ...routingDecision,
        model: actualModelUsed,
        reasoning: `${routingDecision.reasoning} | fallback to ${actualModelUsed}`
      };
      options.onRouted?.(routingDecision);
    }
    if (!upstream) {
      const errBody = lastError?.body || "All models in fallback chain failed";
      const errStatus = lastError?.status || 502;
      if (isStreaming) {
        const errEvent = `data: ${JSON.stringify({ error: { message: errBody, type: "provider_error", status: errStatus } })}

`;
        deduplicator.complete(dedupKey, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: Buffer.from(errEvent + `data: [DONE]

`),
          completedAt: Date.now()
        });
        return new Response(errEvent + `data: [DONE]

`, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      } else {
        const errJson = JSON.stringify({ error: { message: errBody, type: "provider_error" } });
        deduplicator.complete(dedupKey, {
          status: errStatus,
          headers: { "content-type": "application/json" },
          body: Buffer.from(errJson),
          completedAt: Date.now()
        });
        return new Response(errJson, {
          status: errStatus,
          headers: { "content-type": "application/json" }
        });
      }
    }
    const responseChunks = [];
    if (isStreaming) {
      const { readable, writable } = new TransformStream;
      const writer = writable.getWriter();
      const encoder = new TextEncoder;
      const heartbeatInterval = setInterval(() => {
        if (writer.desiredSize !== null && writer.desiredSize >= 0) {
          writer.write(encoder.encode(`: heartbeat

`)).catch(() => {});
        }
      }, HEARTBEAT_INTERVAL_MS);
      (async () => {
        try {
          if (upstream.body) {
            const reader = upstream.body.getReader();
            const chunks = [];
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done)
                  break;
                chunks.push(value);
              }
            } finally {
              reader.releaseLock();
            }
            const jsonBody = Buffer.concat(chunks);
            const jsonStr = jsonBody.toString();
            const isSSE = jsonStr.startsWith("data: ") || jsonStr.startsWith("event: ") || jsonStr.startsWith(": ");
            if (isSSE) {
              const cleaned = jsonStr.split(`
`).filter((line) => {
                const trimmed = line.trim();
                if (trimmed === "")
                  return true;
                if (trimmed === "data: [DONE]")
                  return true;
                if (trimmed.startsWith("data: {"))
                  return true;
                return false;
              }).join(`
`);
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
              } catch {}
              try {
                const rsp = JSON.parse(responseJson);
                const baseChunk = {
                  id: rsp.id ?? `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: rsp.created ?? Math.floor(Date.now() / 1000),
                  model: rsp.model ?? "unknown",
                  system_fingerprint: null
                };
                if (rsp.choices && Array.isArray(rsp.choices)) {
                  for (const choice of rsp.choices) {
                    const rawContent = choice.message?.content ?? choice.delta?.content ?? "";
                    const content = stripThinkingTokens(rawContent);
                    const role = choice.message?.role ?? choice.delta?.role ?? "assistant";
                    const index = choice.index ?? 0;
                    const roleData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: { role }, logprobs: null, finish_reason: null }] })}

`;
                    await writer.write(encoder.encode(roleData));
                    responseChunks.push(Buffer.from(roleData));
                    if (content) {
                      const contentData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: { content }, logprobs: null, finish_reason: null }] })}

`;
                      await writer.write(encoder.encode(contentData));
                      responseChunks.push(Buffer.from(contentData));
                    }
                    const toolCalls = choice.message?.tool_calls ?? choice.delta?.tool_calls;
                    if (toolCalls && toolCalls.length > 0) {
                      const toolCallData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: { tool_calls: toolCalls }, logprobs: null, finish_reason: null }] })}

`;
                      await writer.write(encoder.encode(toolCallData));
                      responseChunks.push(Buffer.from(toolCallData));
                    }
                    const finishData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: {}, logprobs: null, finish_reason: choice.finish_reason ?? "stop" }] })}

`;
                    await writer.write(encoder.encode(finishData));
                    responseChunks.push(Buffer.from(finishData));
                  }
                }
              } catch {
                const sseData = `data: ${jsonStr}

`;
                await writer.write(encoder.encode(sseData));
                responseChunks.push(Buffer.from(sseData));
              }
            }
          }
          await writer.write(encoder.encode(`data: [DONE]

`));
          responseChunks.push(Buffer.from(`data: [DONE]

`));
        } catch (err) {
          console.error(`[ClawRouter] Stream error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          clearInterval(heartbeatInterval);
          deduplicator.complete(dedupKey, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: Buffer.concat(responseChunks),
            completedAt: Date.now()
          });
          await writer.close().catch(() => {});
        }
      })();
      return new Response(readable, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        }
      });
    } else {
      const responseHeaders = {};
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
            if (done)
              break;
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
      } catch {}
      deduplicator.complete(dedupKey, {
        status: upstream.status,
        headers: responseHeaders,
        body: finalBody,
        completedAt: Date.now()
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
async function startProxy(options) {
  const listenPort = options.port ?? getProxyPort();
  const configuredProviders = getConfiguredProviders(options.apiKeys);
  const existing = await checkExistingProxy(listenPort);
  if (existing) {
    options.onReady?.(listenPort);
    return {
      port: listenPort,
      baseUrl: `http://127.0.0.1:${listenPort}`,
      configuredProviders,
      close: async () => {}
    };
  }
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts = { config: routingConfig, modelPricing };
  const deduplicator = new RequestDeduplicator;
  const sessionStore = new SessionStore(options.sessionConfig);
  const server = Bun.serve({
    port: listenPort,
    hostname: "127.0.0.1",
    async fetch(req) {
      try {
        const url = req.url || "";
        const pathname = url.includes("?") ? url.split("?")[0] : url;
        if (pathname === "/health" || pathname.startsWith("/health")) {
          const accessibleProviders = getAccessibleProviders(options.apiKeys);
          return new Response(JSON.stringify({
            status: "ok",
            configuredProviders,
            openRouterFallback: hasOpenRouter(options.apiKeys),
            accessibleProviders,
            modelCount: BLOCKRUN_MODELS.filter((m) => {
              if (m.id === "auto")
                return false;
              const provider = getProviderFromModel(m.id);
              return accessibleProviders.includes(provider);
            }).length
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (pathname === "/stats" || pathname.startsWith("/stats")) {
          try {
            const urlObj = new URL(url);
            const days = parseInt(urlObj.searchParams.get("days") || "7", 10);
            const stats = await getStats(Math.min(days, 30));
            return new Response(JSON.stringify(stats, null, 2), {
              status: 200,
              headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" }
            });
          } catch (err) {
            return new Response(JSON.stringify({
              error: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}`
            }), { status: 500, headers: { "Content-Type": "application/json" } });
          }
        }
        if (pathname === "/v1/models" && req.method === "GET") {
          const accessibleProviders = getAccessibleProviders(options.apiKeys);
          const models = BLOCKRUN_MODELS.filter((m) => {
            if (m.id === "auto")
              return true;
            const provider = getProviderFromModel(m.id);
            return accessibleProviders.includes(provider);
          }).map((m) => ({
            id: m.id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: m.id.split("/")[0] || "clawrouter"
          }));
          return new Response(JSON.stringify({ object: "list", data: models }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (!pathname.startsWith("/v1")) {
          return new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
          });
        }
        return handleChatCompletion(req, options, routerOpts, deduplicator, sessionStore);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        options.onError?.(error);
        return new Response(JSON.stringify({
          error: { message: `Proxy error: ${error.message}`, type: "proxy_error" }
        }), { status: 502, headers: { "Content-Type": "application/json" } });
      }
    },
    error(err) {
      console.error(`[ClawRouter] Server runtime error: ${err.message}`);
      options.onError?.(err);
      return new Response("Internal Server Error", { status: 500 });
    }
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
    }
  };
}

// src/cli.ts
function printHelp() {
  console.log(`
ClawRouter v${VERSION} - Smart LLM Router (Direct API Keys)

Usage:
  clawrouter [options]

Options:
  --version, -v     Show version number
  --help, -h        Show this help message
  --port <number>   Port to listen on (default: ${getProxyPort()})

Examples:
  # Set API keys and start
  export OPENAI_API_KEY=sk-...
  export ANTHROPIC_API_KEY=sk-ant-...
  npx clawrouter

  # Custom port
  npx clawrouter --port 9000

Environment Variables:
  OPENROUTER_API_KEY    OpenRouter key (one key \u2192 all models!)
  OPENAI_API_KEY        OpenAI API key (direct, cheaper)
  ANTHROPIC_API_KEY     Anthropic API key (direct, cheaper)
  GOOGLE_API_KEY        Google AI API key (direct, cheaper)
  XAI_API_KEY           xAI/Grok API key (direct, cheaper)
  DEEPSEEK_API_KEY      DeepSeek API key (direct, cheaper)
  MOONSHOT_API_KEY      Moonshot/Kimi API key (direct, cheaper)
  NVIDIA_API_KEY        NVIDIA API key (direct, cheaper)
  CLAWROUTER_PORT       Default proxy port (default: 8403)

  Direct keys take priority over OpenRouter for that provider's models.
`);
}
function parseArgs(args) {
  const result = { version: false, help: false, port: undefined };
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" || arg === "-v")
      result.version = true;
    else if (arg === "--help" || arg === "-h")
      result.help = true;
    else if (arg === "--port" && args[i + 1]) {
      result.port = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return result;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const apiKeys = loadApiKeys();
  const configured = getConfiguredProviders(apiKeys);
  if (configured.length === 0) {
    console.error("[ClawRouter] No API keys configured!");
    console.error("[ClawRouter] Quickest: export OPENROUTER_API_KEY=sk-or-...  (one key \u2192 all models)");
    console.error("[ClawRouter] Or set individual keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.");
    console.error("[ClawRouter] Or edit ~/.openclaw/clawrouter/configon");
    process.exit(1);
  }
  const accessible = getAccessibleProviders(apiKeys);
  const orFallback = hasOpenRouter(apiKeys);
  console.log(`[ClawRouter] Configured providers: ${configured.join(", ")}${orFallback ? " (OpenRouter covers all)" : ""}`);
  console.log(`[ClawRouter] Accessible providers: ${accessible.join(", ")} (${accessible.length} total)`);
  const proxy = await startProxy({
    apiKeys,
    port: args.port,
    onReady: (port) => {
      console.log(`[ClawRouter] Proxy listening on http://127.0.0.1:${port}`);
      console.log(`[ClawRouter] Health check: http://127.0.0.1:${port}/health`);
    },
    onError: (error) => console.error(`[ClawRouter] Error: ${error.message}`),
    onRouted: (decision) => {
      const cost = decision.costEstimate.toFixed(4);
      const saved = (decision.savings * 100).toFixed(0);
      console.log(`[ClawRouter] [${decision.tier}] ${decision.model} ~$${cost} (saved ${saved}%)`);
    }
  });
  console.log(`[ClawRouter] Ready - Ctrl+C to stop`);
  const shutdown = async (signal) => {
    console.log(`
[ClawRouter] Received ${signal}, shutting down...`);
    try {
      await proxy.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  await new Promise(() => {});
}
main().catch((err) => {
  console.error(`[ClawRouter] Fatal: ${err.message}`);
  process.exit(1);
});
