#!/usr/bin/env node
/**
 * ColdRouter CLI — Standalone proxy mode
 *
 * Usage:
 *   npx coldrouter              # Start standalone proxy
 *   npx coldrouter --version    # Show version
 */

import { startProxy, getProxyPort } from "./proxy";
import {
  loadApiKeys,
  getConfiguredProviders,
  hasOpenRouter,
  getAccessibleProviders,
} from "./api-keys";
import { VERSION } from "./version";

function printHelp(): void {
  console.log(`
ColdRouter v${VERSION} - Smart LLM Router (Direct API Keys)

Usage:
  coldrouter [options]

Options:
  --version, -v     Show version number
  --help, -h        Show this help message
  --port <number>   Port to listen on (default: ${getProxyPort()})

Examples:
  # Set API keys and start
  export OPENAI_API_KEY=sk-...
  export ANTHROPIC_API_KEY=sk-ant-...
  npx coldrouter

  # Custom port
  npx coldrouter --port 9000

Environment Variables:
  OPENROUTER_API_KEY    OpenRouter key (one key → all models!)
  OPENAI_API_KEY        OpenAI API key (direct, cheaper)
  ANTHROPIC_API_KEY     Anthropic API key (direct, cheaper)
  GOOGLE_API_KEY        Google AI API key (direct, cheaper)
  XAI_API_KEY           xAI/Grok API key (direct, cheaper)
  DEEPSEEK_API_KEY      DeepSeek API key (direct, cheaper)
  MOONSHOT_API_KEY      Moonshot/Kimi API key (direct, cheaper)
  NVIDIA_API_KEY        NVIDIA API key (direct, cheaper)
  COLDROUTER_PORT       Default proxy port (default: 8403)

  Direct keys take priority over OpenRouter for that provider's models.
`);
}

function parseArgs(args: string[]): { version: boolean; help: boolean; port?: number } {
  const result = { version: false, help: false, port: undefined as number | undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" || arg === "-v") result.version = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--port" && args[i + 1]) {
      result.port = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return result;
}

async function main(): Promise<void> {
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
    console.error("[ColdRouter] No API keys configured!");
    console.error(
      "[ColdRouter] Quickest: export OPENROUTER_API_KEY=sk-or-...  (one key → all models)",
    );
    console.error("[ColdRouter] Or set individual keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.");
    console.error("[ColdRouter] Or edit ~/.openclaw/coldrouter/configon");
    process.exit(1);
  }

  const accessible = getAccessibleProviders(apiKeys);
  const orFallback = hasOpenRouter(apiKeys);
  console.log(
    `[ColdRouter] Configured providers: ${configured.join(", ")}${orFallback ? " (OpenRouter covers all)" : ""}`,
  );
  console.log(
    `[ColdRouter] Accessible providers: ${accessible.join(", ")} (${accessible.length} total)`,
  );

  const proxy = await startProxy({
    apiKeys,
    port: args.port,
    onReady: (port) => {
      console.log(`[ColdRouter] Proxy listening on http://127.0.0.1:${port}`);
      console.log(`[ColdRouter] Health check: http://127.0.0.1:${port}/health`);
    },
    onError: (error) => console.error(`[ColdRouter] Error: ${error.message}`),
    onRouted: (decision) => {
      const cost = decision.costEstimate.toFixed(4);
      const saved = (decision.savings * 100).toFixed(0);
      console.log(`[ColdRouter] [${decision.tier}] ${decision.model} ~$${cost} (saved ${saved}%)`);
    },
  });

  console.log(`[ColdRouter] Ready - Ctrl+C to stop`);

  const shutdown = async (signal: string) => {
    console.log(`\n[ColdRouter] Received ${signal}, shutting down...`);
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
  console.error(`[ColdRouter] Fatal: ${err.message}`);
  process.exit(1);
});
