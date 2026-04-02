# Agent Guidelines for ClawRouter

## Project Overview

ClawRouter is a smart LLM router that routes requests to the cheapest capable model using your own API keys. It's an OpenClaw plugin written in TypeScript with ESM modules.

## Build / Dev / Type Check

```bash
bun run build        # Build src/index.ts + src/cli.ts → dist/
bun run dev          # Run CLI in watch mode (bun run src/cli.ts)
bun run typecheck    # TypeScript type check (no emit)
```

## Lint

```bash
npx eslint src/        # Lint source files
npx eslint src/ --fix  # Auto-fix
```

ESLint uses `typescript-eslint` recommended config, ignores `dist/`, `node_modules/`, `test/`.

## Running Tests

Tests are in `test/` directory. They use simple assertion helpers (no test framework).

**Run a single test:**
```bash
# Using bun (recommended)
bun test/test-retry.ts

# Or compile then run
npx tsup test/e2e.ts --format esm --outDir test/dist --no-dts && node test/dist/e2e.js
```

**Run all tests:**
```bash
bash test/run-docker-test.sh   # Docker-based tests
node test/test-e2e.mjs         # E2E tests
```

Tests require API keys for live testing:
- `OPENROUTER_API_KEY` - OpenRouter fallback key
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. - Direct provider keys

---

## Code Style

### TypeScript & Module Config
- **Strict mode**: `"strict": true` in tsconfig.json
- **ESM modules**: `"type": "module"` in package.json
- **Target**: ES2022, Node.js 20+

### Imports
- Use `import type` for type-only imports
- Order: external packages → internal modules → local files
- Named exports preferred over default exports
- **Always use `.js` extension for local imports** (ESM requirement)

```typescript
import type { RoutingDecision, Tier } from "./types.js";
import { route } from "./router/index.js";
import { readFileSync } from "node:fs";
```

### Naming
| Element | Convention | Example |
|---------|------------|---------|
| Types/Interfaces | PascalCase | `RoutingDecision`, `ApiKeysConfig` |
| Functions | camelCase | `fetchWithRetry`, `loadApiKeys` |
| Constants | SCREAMING_SNAKE_CASE | `DEFAULT_RETRY_CONFIG`, `PROVIDER_ENDPOINTS` |
| Files | kebab-case | `api-keys.ts`, `openrouter-models.ts` |
| Enums | PascalCase members | `Tier.SIMPLE`, `Tier.MEDIUM` |

### Types
- Use `type` for aliases; `interface` when extension needed
- Always export public API types
- Prefer `Record<string, T>` over `{ [key: string]: T }`

```typescript
export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";
export interface RoutingDecision {
  tier: Tier;
  model: string;
  reasoning: string;
}
```

### Error Handling
- Always handle promise rejections
- Use `instanceof Error` checks before accessing `.message`
- Provide meaningful error messages in catch blocks

### Formatting (Prettier)
- Semicolons: required
- Quotes: double quotes
- Trailing commas: all
- Print width: 100, Tab width: 2

---

## Project Structure

```
src/
├── index.ts              # Plugin entry, exports
├── cli.ts                # CLI implementation
├── types.ts              # TypeScript definitions
├── api-keys.ts           # API key management
├── models.ts             # Model definitions & pricing
├── openrouter-models.ts  # OpenRouter model catalog
├── proxy.ts              # Local proxy server
├── provider.ts           # OpenClaw provider definition
├── retry.ts              # Retry with exponential backoff
├── dedup.ts              # Request deduplication
├── session.ts            # Session pinning
├── stats.ts              # Usage statistics
├── logger.ts             # Usage logging
├── version.ts            # Version info
└── router/
    ├── index.ts          # Main routing logic
    ├── config.ts         # Routing configuration
    ├── rules.ts          # Rule-based classifier (15 dimensions)
    ├── selector.ts       # Model selection for tier
    └── llm-classifier.ts # LLM-based fallback classifier
```

---

## Key Patterns

### Plugin Registration
```typescript
const plugin: OpenClawPluginDefinition = {
  id: "clawrouter",
  name: "ClawRouter",
  register(api: OpenClawPluginApi) {
    api.registerProvider(clawrouterProvider);
    api.registerCommand({ name: "stats", handler: async () => ({ text: "..." }) });
    api.registerService({ id: "clawrouter-proxy", start: () => {}, stop: async () => {} });
  },
};
export default plugin;
```

### Routing Flow
1. Check overrides (large context, structured output)
2. Run rule-based classifier (15 weighted dimensions, <1ms)
3. Ambiguous → default to configurable tier (no external API calls)
4. Select model for tier from available providers
5. Return `RoutingDecision` with model, cost, reasoning

### Provider Access Priority
Direct provider key > OpenRouter fallback (OpenAI-compatible). Anthropic/Google always route through OpenRouter.

---

## Gotchas

1. **ESM requires `.js` in imports** — `./foo.js` not `./foo`
2. **Strict mode** — all variables must be typed or have clear inference
3. **Async errors** — never leave promises unhandled
4. **Plugin cleanup** — use `registerService.stop` for shutdown hooks
5. **Peer dependency** — OpenClaw `>=2025.1.0` (optional)
