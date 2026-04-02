# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Commands

```bash
# Build
bun run build        # Build src/index.ts + src/cli.ts → dist/

# Dev
bun run dev          # Run CLI in watch mode (bun run src/cli.ts)

# Type check
bun run typecheck    # TypeScript type check (no emit)

# Lint
npx eslint src/      # Lint source files
npx eslint src/ --fix  # Auto-fix

# Run a single test
bun test/test-retry.ts
```

## Architecture Overview

ColdRouter is a smart LLM router plugin that routes requests to the cheapest capable model using your own API keys.

### Core Flow

```
Client → ColdRouter Proxy (localhost) → Provider API (OpenAI/Anthropic/Google/etc.)
                    ↓
            ┌────── Router ──────┐
            │ 15-dim classifier  │ → determines tier (SIMPLE/MEDIUM/COMPLEX/REASONING)
            │ (runs locally)     │
            └────────────────────┘
```

### Key Components

- **`src/proxy.ts`**: Local HTTP proxy using Bun.serve, handles OpenAI-compatible `/v1/chat/completions` endpoints
- **`src/router/index.ts`**: Main routing entry point — runs rule-based classifier, selects model
- **`src/router/rules.ts`**: 15-dimension weighted scorer for request classification (<1ms, zero API cost)
- **`src/router/selector.ts`**: Tier → model selection with fallback chains
- **`src/api-keys.ts`**: API key management, provider priority (direct key > OpenRouter fallback)
- **`src/model-registry.ts`**: Custom provider/model support (recently added)

### Routing Tiers

| Tier | Use Case | Default Model |
|------|----------|---------------|
| SIMPLE | Facts, translations | Gemini 2.5 Flash |
| MEDIUM | Code, summaries | Grok Code Fast |
| COMPLEX | System design | Gemini 2.5 Pro |
| REASONING | Proofs, logic | Grok 4 Fast Reasoning |

### Provider Priority

Direct provider key (`OPENAI_API_KEY`) > OpenRouter fallback (`OPENROUTER_API_KEY`). One OpenRouter key covers all 30+ models.

### Plugin Registration Pattern

```typescript
const plugin: OpenClawPluginDefinition = {
  id: "coldrouter",
  register(api: OpenClawPluginApi) {
    api.registerProvider(coldrouterProvider);
    api.registerCommand({ name: "stats", handler: async () => ({ text: "..." }) });
    api.registerService({ id: "coldrouter-proxy", start: () => {}, stop: async () => {} });
  },
};
```

## Key Patterns

### ESM Imports

Always use `.js` extension for local imports (ESM requirement):
```typescript
import { route } from "./router/index.js";
```

### Routing Flow

1. Check overrides (large context → COMPLEX, structured output → min MEDIUM)
2. Run rule-based classifier (15 weighted dimensions)
3. Ambiguous → default to configurable tier (no external API calls)
4. Select model for tier from available providers
5. Return `RoutingDecision` with model, cost, reasoning

### Provider Access

- `getConfiguredProviders()` — keys actually configured
- `getAccessibleProviders()` — keys with valid API access (includes OpenRouter fallback)
- Models without accessible API key are automatically skipped from selection

## Environment Variables

| Variable | Provider |
|----------|----------|
| `OPENROUTER_API_KEY` | OpenRouter (covers all models) |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GOOGLE_API_KEY` | Google |
| `XAI_API_KEY` | xAI (Grok) |
| `DEEPSEEK_API_KEY` | DeepSeek |

## Recent Changes

- Migrated to Bun runtime with native APIs (commit 5e002ba)
- Added model registry and custom provider support (commit eedae4a)
- Migrated from node:http to Bun.serve() (commit 0c4e9ab)