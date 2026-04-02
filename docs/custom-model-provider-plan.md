# Custom Model Provider Configuration - Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JSON configuration file support for custom LLM providers and models, allowing users to extend ClawRouter with their own API keys and model configurations.

**Architecture:** New `model-registry.ts` module handles loading/parsing custom model configs from `~/.openclaw/clawrouter/models.json`. Custom models merge with built-in models in `models.ts`. Router integration filters model selection by capability tiers. Hot reload via `fs.watch()`.

**Tech Stack:** TypeScript, Bun fs APIs, JSON Schema validation

---

## Chunk 1: Core Module - model-registry.ts

**Files:**
- Create: `src/model-registry.ts`
- Modify: `src/types.ts` (add new types)
- Test: `test/test-model-registry.ts`

### Task 1: Add types to src/types.ts

- [ ] **Step 1: Add capability and tier types to types.ts**

```typescript
// Add after existing type definitions (around line 100)
export type ModelCapability = "vision" | "reasoning" | "code" | "creative" | "agentic";

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

export type ModelDefinitionCustom = {
  id: string;
  name: string;
  provider: string;
  capabilities: Record<ModelCapability, boolean>;
  tiers: Tier[];
  pricing: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  limits: { contextWindow: number; maxOutput: number };
  useCases: string[];
  enabled: boolean;
};

export type ProviderConfigCustom = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiFormat: "openai-completions" | "anthropic-messages" | "google-generative-ai";
  headers?: Record<string, string>;
};

export type ModelRegistryConfig = {
  version: string;
  providers: Record<string, ProviderConfigCustom>;
  models: Record<string, Partial<ModelDefinitionCustom>>;
};
```

### Task 2: Create src/model-registry.ts

- [ ] **Step 1: Write the model-registry module skeleton**

```typescript
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
  ModelCapability,
  Tier
} from "./types.js";

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
    
    // Basic validation
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
      tiers: model.tiers ?? ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"],
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
    tiers: model.tiers ?? ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"],
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
export function toOpenClawModel(model: ModelDefinitionCustom): import("./types.js").ModelDefinitionConfig {
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
```

### Task 3: Write test for model-registry

- [ ] **Step 1: Create test file with test cases**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "bun:fs";
import { join } from "bun:path";
import { homedir } from "bun:os";

const TEST_CONFIG_DIR = join(homedir(), ".openclaw", "clawrouter");
const TEST_CONFIG_FILE = join(TEST_CONFIG_DIR, "models.json");

// Helper to create test config
function createTestConfig(config: string): void {
  mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  writeFileSync(TEST_CONFIG_FILE, config);
}

// Helper to cleanup test config
function cleanupTestConfig(): void {
  try {
    rmSync(TEST_CONFIG_FILE);
  } catch {
    // ignore
  }
}

describe("loadModelRegistry", () => {
  beforeEach(() => {
    cleanupTestConfig();
  });
  
  afterEach(() => {
    cleanupTestConfig();
  });
  
  test("returns null when file does not exist", async () => {
    const { loadModelRegistry } = await import("../../src/model-registry.js");
    const result = loadModelRegistry();
    expect(result).toBeNull();
  });
  
  test("parses valid config", async () => {
    const config = JSON.stringify({
      version: "1.0",
      providers: {
        "my-provider": {
          name: "My Provider",
          baseUrl: "https://api.my-provider.com/v1",
          apiKey: "sk-test",
          apiFormat: "openai-completions",
        },
      },
      models: {
        "my-provider/custom-model": {
          name: "Custom Model",
          provider: "my-provider",
          capabilities: { vision: false, reasoning: true, code: true, creative: false, agentic: false },
          tiers: ["SIMPLE", "MEDIUM", "COMPLEX"],
          pricing: { input: 0.5, output: 1.5 },
          limits: { contextWindow: 128000, maxOutput: 16384 },
          useCases: ["coding"],
          enabled: true,
        },
      },
    });
    createTestConfig(config);
    
    const { loadModelRegistry, reloadModelRegistry } = await import("../../src/model-registry.js");
    const result = reloadModelRegistry();
    
    expect(result).not.toBeNull();
    expect(result!.providers["my-provider"]).toBeDefined();
    expect(result!.models["my-provider/custom-model"]).toBeDefined();
  });
});

describe("getCustomModels", () => {
  test("returns empty array when no config", async () => {
    cleanupTestConfig();
    const { getCustomModels, reloadModelRegistry } = await import("../../src/model-registry.js");
    reloadModelRegistry();
    const result = getCustomModels();
    expect(result).toEqual([]);
  });
  
  test("returns only enabled models", async () => {
    const config = JSON.stringify({
      version: "1.0",
      models: {
        "provider/model-enabled": {
          name: "Enabled Model",
          enabled: true,
        },
        "provider/model-disabled": {
          name: "Disabled Model",
          enabled: false,
        },
      },
    });
    createTestConfig(config);
    
    const { getCustomModels, reloadModelRegistry } = await import("../../src/model-registry.js");
    const result = reloadModelRegistry();
    const models = getCustomModels();
    
    expect(models.length).toBe(1);
    expect(models[0].id).toBe("provider/model-enabled");
  });
});

describe("toOpenClawModel", () => {
  test("converts custom model to OpenClaw format", async () => {
    const config = JSON.stringify({
      version: "1.0",
      providers: {
        "test-provider": {
          name: "Test Provider",
          baseUrl: "https://api.test.com/v1",
          apiFormat: "openai-completions",
        },
      },
      models: {
        "test-provider/my-model": {
          name: "My Model",
          provider: "test-provider",
          capabilities: { vision: true, reasoning: true, code: false, creative: false, agentic: false },
          pricing: { input: 1.0, output: 2.0 },
          limits: { contextWindow: 100000, maxOutput: 8000 },
        },
      },
    });
    createTestConfig(config);
    
    const { reloadModelRegistry, getCustomModel, toOpenClawModel } = await import("../../src/model-registry.js");
    reloadModelRegistry();
    
    const model = getCustomModel("test-provider/my-model");
    expect(model).toBeDefined();
    
    const openClawModel = toOpenClawModel(model!);
    expect(openClawModel.id).toBe("test-provider/my-model");
    expect(openClawModel.name).toBe("My Model");
    expect(openClawModel.api).toBe("openai-completions");
    expect(openClawModel.reasoning).toBe(true);
    expect(openClawModel.input).toEqual(["text", "image"]);
    expect(openClawModel.cost.input).toBe(1.0);
    expect(openClawModel.cost.output).toBe(2.0);
    expect(openClawModel.contextWindow).toBe(100000);
    expect(openClawModel.maxTokens).toBe(8000);
  });
});
```

---

## Chunk 2: Provider Integration

**Files:**
- Modify: `src/provider.ts`
- Modify: `src/models.ts`

### Task 4: Update provider.ts to merge custom models

- [ ] **Step 1: Modify buildProviderModels to accept custom models**

In `src/provider.ts`, find `buildProviderModels` function and update it to merge custom models:

```typescript
import { getCustomModels, toOpenClawModel } from "./model-registry.js";

// Modify buildProviderModels signature to accept optional custom models
export function buildProviderModels(
  baseUrl: string, 
  customModels?: ModelDefinitionConfig[]  // Add this parameter
): ModelProviderConfig {
  // ... existing code ...
  
  const allModels = [
    ...OPENCLAW_MODELS,  // existing built-in models
    ...(customModels ?? []),  // add custom models
  ];
  
  return {
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    models: allModels,
  };
}
```

- [ ] **Step 2: Update the provider's models getter**

```typescript
// In clawrouterProvider, update the models getter:
get models() {
  if (!activeProxy) {
    return buildProviderModels("http://127.0.0.1:8403", getCustomModels().map(toOpenClawModel));
  }
  return buildProviderModels(activeProxy.baseUrl, getCustomModels().map(toOpenClawModel));
}
```

---

## Chunk 3: Router Integration

**Files:**
- Modify: `src/router/selector.ts`
- Modify: `src/router/types.ts`

### Task 5: Update selector.ts to filter by tier capabilities

- [ ] **Step 1: Update selectModel to filter by model tiers**

In `src/router/selector.ts`, modify `selectModel` to check if a model supports the requested tier:

```typescript
import { getCustomModel } from "../../model-registry.js";

export function selectModel(
  tier: Tier,
  confidence: number,
  method: "rules" | "llm",
  reasoning: string,
  tierConfigs: Record<Tier, TierConfig>,
  modelPricing: Map<string, ModelPricing>,
  estimatedInputTokens: number,
  maxOutputTokens: number,
  allowedModels?: string[],  // Add: models that can be selected
): RoutingDecision {
  // Get the chain for this tier
  const chain = getFallbackChain(tier, tierConfigs);
  
  // Filter chain by allowed models and tier capability
  const filteredChain = chain.filter((modelId) => {
    // Check if model is in allowed list (if provided)
    if (allowedModels && !allowedModels.includes(modelId)) {
      return false;
    }
    
    // Check if model supports this tier
    const customModel = getCustomModel(modelId);
    if (customModel && !customModel.tiers.includes(tier)) {
      return false;
    }
    
    return true;
  });
  
  const model = filteredChain[0] ?? chain[0];  // Fall back to original chain if all filtered
  // ... rest of function unchanged
}
```

### Task 6: Update router/index.ts to pass allowed models

- [ ] **Step 1: Update route function to collect allowed models**

In `src/router/index.ts`:

```typescript
import { getCustomModels } from "../model-registry.js";

export function route(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  options: RouterOptions,
): RoutingDecision {
  // ... existing code until selectModel call ...
  
  // Collect all models that support each tier
  const customModels = getCustomModels();
  const modelsByTier = new Map<Tier, string[]>();
  
  for (const model of customModels) {
    for (const tier of model.tiers) {
      if (!modelsByTier.has(tier)) {
        modelsByTier.set(tier, []);
      }
      modelsByTier.get(tier)!.push(model.id);
    }
  }
  
  const allowedModels = modelsByTier.get(tier);
  
  return selectModel(
    tier,
    confidence,
    method,
    reasoning,
    tierConfigs,
    modelPricing,
    estimatedTokens,
    maxOutputTokens,
    allowedModels,  // Pass allowed models
  );
}
```

---

## Chunk 4: Rules Integration (Optional Enhancement)

**Files:**
- Modify: `src/router/rules.ts`

### Task 7: Add capability-based scoring dimension

- [ ] **Step 1: Add new scoring dimension for capabilities**

In `src/router/rules.ts`, add a new dimension scorer:

```typescript
function scoreCapabilities(
  prompt: string,
  customModels: ModelDefinitionCustom[],
): { dimensionScore: DimensionScore; capabilityScore: number } {
  const promptLower = prompt.toLowerCase();
  let codeScore = 0;
  let creativeScore = 0;
  
  // Find models with specific capabilities
  const codeModels = customModels.filter(m => m.capabilities.code);
  const creativeModels = customModels.filter(m => m.capabilities.creative);
  
  // If user mentions code-related terms and we have code-capable custom models, boost
  const codeKeywords = ["code", "function", "class", "implement", "debug", "api"];
  const creativeKeywords = ["story", "poem", "creative", "write", "compose"];
  
  const codeMatches = codeKeywords.filter(kw => promptLower.includes(kw));
  const creativeMatches = creativeKeywords.filter(kw => promptLower.includes(kw));
  
  if (codeMatches.length > 0 && codeModels.length > 0) {
    codeScore = Math.min(codeMatches.length * 0.3, 1.0);
  }
  if (creativeMatches.length > 0 && creativeModels.length > 0) {
    creativeScore = Math.min(creativeMatches.length * 0.3, 1.0);
  }
  
  const capabilityScore = Math.max(codeScore, creativeScore);
  
  return {
    dimensionScore: {
      name: "customCapabilities",
      score: capabilityScore,
      signal: capabilityScore > 0 
        ? `custom-capability(code=${codeScore.toFixed(1)}, creative=${creativeScore.toFixed(1)})`
        : null,
    },
    capabilityScore,
  };
}
```

---

## Chunk 5: Documentation

**Files:**
- Modify: `docs/configuration.md` (add custom provider section)

### Task 8: Document custom provider configuration

- [ ] **Step 1: Add documentation section**

Add to `docs/configuration.md`:

```markdown
## Custom Model Providers

You can add your own LLM providers and models by creating a configuration file at `~/.openclaw/clawrouter/models.json`.

### Example Configuration

```json
{
  "version": "1.0",
  "providers": {
    "my-provider": {
      "name": "My Custom Provider",
      "baseUrl": "https://api.my-provider.com/v1",
      "apiKey": "sk-xxx",
      "apiFormat": "openai-completions"
    }
  },
  "models": {
    "my-provider/custom-model": {
      "name": "Custom Model",
      "provider": "my-provider",
      "capabilities": {
        "vision": false,
        "reasoning": true,
        "code": true,
        "creative": false,
        "agentic": false
      },
      "tiers": ["SIMPLE", "MEDIUM", "COMPLEX"],
      "pricing": {
        "input": 0.5,
        "output": 1.5
      },
      "limits": {
        "contextWindow": 128000,
        "maxOutput": 16384
      },
      "useCases": ["coding", "analysis"],
      "enabled": true
    }
  }
}
```

### Configuration Fields

#### Provider Fields
- `name`: Display name for the provider
- `baseUrl`: API endpoint base URL
- `apiKey`: Your API key (can also use environment variable)
- `apiFormat`: One of `openai-completions`, `anthropic-messages`, `google-generative-ai`
- `headers`: Optional custom headers

#### Model Fields
- `name`: Display name for the model
- `provider`: Reference to provider defined above
- `capabilities`: Boolean flags for model capabilities
  - `vision`: Supports image input
  - `reasoning`: Has explicit reasoning/thinking capabilities
  - `code`: Optimized for code generation
  - `creative`: Good for creative writing
  - `agentic`: Supports autonomous multi-step tasks
- `tiers`: Which routing tiers this model can handle
- `pricing`: Cost per million tokens (input/output)
- `limits`: Context window and max output tokens
- `useCases`: Array of use case tags for future routing rules
- `enabled`: Set to `false` to disable without removing

### Hot Reload

Changes to `models.json` are applied automatically without restarting OpenClaw.
```

---

## Verification

- [ ] Run `bun run typecheck` - should pass
- [ ] Run `npx eslint src/` - should pass
- [ ] Run `bun test/test-model-registry.ts` - all tests pass
- [ ] Verify built-in models still work (run existing E2E tests if API keys available)

---

**Plan complete.** Ready to execute?
