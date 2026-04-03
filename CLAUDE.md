# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

```bash
# Install deps (CI uses npm)
npm ci

# Build plugin + CLI to dist/
bun run build

# Run standalone local proxy
bun run dev
# or
npx coldrouter --port 8403

# Typecheck (project uses Bun build as typecheck gate)
bun run typecheck

# Lint (ESLint ignores dist/, node_modules/, test/)
npx eslint src/
npx eslint src/ --fix

# Format check (matches CI)
npx prettier --check .

# Run a single test file
npx tsx test/test-retry.ts
# alternative used in repo docs
bun test/test-retry.ts
```

## Big-Picture Architecture

ColdRouter is an OpenClaw plugin plus a local Bun proxy that exposes OpenAI-compatible endpoints and routes requests to the cheapest capable model using your own provider keys.

### Runtime shape

1. Plugin registers provider + commands in `src/index.ts`.
2. In gateway mode, plugin starts local proxy (`src/proxy.ts`) and injects `coldrouter` provider config into OpenClaw runtime config.
3. Clients hit proxy endpoints (`/v1/chat/completions`, plus Claude-compatible endpoints).
4. Router classifies request complexity, selects tier/model, then proxy forwards to provider API with fallback and stream normalization.

### Main subsystems

- **Plugin lifecycle + registration**: `src/index.ts`
  - Registers provider, `/stats`, `/keys`, and shutdown service.
  - Loads API keys from env/config/plugin config and starts proxy only in gateway mode.
- **HTTP proxy + protocol normalization**: `src/proxy.ts`
  - Bun server entrypoint.
  - Handles health/stats and model listing endpoints.
  - Bridges formats between OpenAI-style input and provider-specific APIs (notably Anthropic/Google handling, streaming/SSE shaping, tool ID sanitization, thinking-token stripping).
  - Implements fallback attempts, rate-limit deprioritization, request deduplication, and session model pinning.
- **Routing engine**: `src/router/index.ts`, `src/router/rules.ts`, `src/router/selector.ts`, `src/router/config.ts`
  - Weighted rule-based classifier (15 dimensions) picks tier with confidence.
  - Applies overrides (large context, structured-output minimum tier, ambiguous default tier).
  - Chooses cheapest model in tier fallback chain with context-window filtering.
  - Supports agentic tier set when agentic signals are strong.
- **Provider/key access policy**: `src/api-keys.ts`
  - Priority: direct provider key when possible; OpenRouter fallback otherwise.
  - Anthropic/Google routes prefer OpenRouter path when available due to API-format differences.
- **Model catalog + extensibility**: `src/models.ts`, `src/model-registry.ts`, `src/openrouter-models.ts`
  - Built-in model pricing/aliases.
  - Optional custom models/providers from `~/.coldrouter/models.json` with hot reload.
  - OpenRouter model-id resolution cache.

## Key Integration Details

- **ESM import rule**: use `.js` extension for local imports.
- **Config/keys locations**:
  - `~/.coldrouter/config.json` (provider keys/base URLs)
  - `~/.coldrouter/models.json` (custom models/providers)
- **Useful proxy endpoints**:
  - `GET /health`
  - `GET /stats?days=N`
  - `GET /v1/models`
  - `GET /v1/claude/models`
  - `POST /v1/chat/completions`
  - `POST /v1/claude/completions`
  - `POST /v1/anthropic`

## CI Expectations

From `.github/workflows/ci.yml`, PRs are expected to pass:

1. `npx prettier --check .`
2. `npx eslint src/`
3. `npm run typecheck`
4. `npm run build`
