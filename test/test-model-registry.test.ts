import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "bun:fs";
import { join } from "bun:path";
import { homedir } from "bun:os";

const TEST_CONFIG_DIR = join(homedir(), ".coldrouter");
const TEST_CONFIG_FILE = join(TEST_CONFIG_DIR, "models.json");
const LEGACY_TEST_CONFIG_DIR = join(homedir(), ".openclaw", "clawrouter");
const LEGACY_TEST_CONFIG_FILE = join(LEGACY_TEST_CONFIG_DIR, "models.json");

function createTestConfig(config: string): void {
  mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  writeFileSync(TEST_CONFIG_FILE, config);
}

function createLegacyTestConfig(config: string): void {
  mkdirSync(LEGACY_TEST_CONFIG_DIR, { recursive: true });
  writeFileSync(LEGACY_TEST_CONFIG_FILE, config);
}

function cleanupTestConfig(): void {
  try {
    rmSync(TEST_CONFIG_FILE);
  } catch {
    // ignore
  }
  try {
    rmSync(LEGACY_TEST_CONFIG_FILE);
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
    const { loadModelRegistry } = await import("../src/model-registry.js");
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

    const { loadModelRegistry, reloadModelRegistry } = await import("../src/model-registry.js");
    const result = reloadModelRegistry();

    expect(result).not.toBeNull();
    expect(result!.providers["my-provider"]).toBeDefined();
    expect(result!.models["my-provider/custom-model"]).toBeDefined();
  });
});

describe("getCustomModels", () => {
  test("returns empty array when no config", async () => {
    cleanupTestConfig();
    const { getCustomModels, reloadModelRegistry } = await import("../src/model-registry.js");
    reloadModelRegistry();
    const result = getCustomModels();
    expect(result).toEqual([]);
  });

  test("falls back to legacy config when new path is missing", async () => {
    cleanupTestConfig();
    const config = JSON.stringify({
      version: "1.0",
      models: {
        "legacy/provider-model": {
          name: "Legacy Model",
          provider: "legacy",
          tiers: ["SIMPLE"],
          pricing: { input: 0.1, output: 0.2 },
          limits: { contextWindow: 8192, maxOutput: 2048 },
          enabled: true,
        },
      },
    });
    createLegacyTestConfig(config);

    const { getCustomModels, reloadModelRegistry } = await import("../src/model-registry.js");
    reloadModelRegistry();
    const models = getCustomModels();

    expect(models.length).toBe(1);
    expect(models[0].id).toBe("legacy/provider-model");
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
          tiers: ["MEDIUM", "COMPLEX"],
          pricing: { input: 1.0, output: 2.0 },
          limits: { contextWindow: 100000, maxOutput: 8000 },
        },
      },
    });
    createTestConfig(config);

    const { reloadModelRegistry, getCustomModel, toOpenClawModel } = await import("../src/model-registry.js");
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
