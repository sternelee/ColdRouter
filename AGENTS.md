# Agent Guidelines for ClawRouter

## Project Overview

ClawRouter is a smart LLM router that routes requests to the cheapest capable model using your own API keys. It's an OpenClaw plugin written in TypeScript with ESM modules.

## Build / Lint / Test Commands

### Build
```bash
npm run build        # Build with tsup (outputs to dist/)
npm run dev          # Watch mode for development
```

### Type Checking
```bash
npm run typecheck    # TypeScript type checking (no emit)
```

### Linting
```bash
npx eslint src/      # Lint source files
npx eslint src/ --fix  # Auto-fix linting issues
```

### Running Tests

Tests are TypeScript files in `test/` directory. They use native Node.js test patterns with simple assertion helpers (no test framework).

**Run a single test file:**
```bash
# Compile and run with node
npx tsup test/e2e.ts --format esm --outDir test/dist --no-dts && node test/dist/e2e.js

# Or using tsx (if installed)
npx tsx test/test-retry.ts
```

**Run all tests:**
```bash
# Shell scripts in test/
bash test/run-docker-test.sh

# E2E tests
node test/test-e2e.mjs
```

**Note:** Tests require API keys for live tests. Set environment variables:
- `OPENROUTER_API_KEY` - OpenRouter fallback key
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. - Direct provider keys

---

## Code Style Guidelines

### TypeScript Configuration
- **Strict mode enabled** (`"strict": true` in tsconfig.json)
- **ESM modules** (`"type": "module"` in package.json)
- Use `.js` extensions in imports even for local files (required for ESM)

### Imports
- Use `import type` for type-only imports to improve build performance
- Order: external packages → internal modules → local files
- Use named exports over default exports where reasonable
- Always use explicit extension in local imports: `./router/index.js`

**Good:**
```typescript
import type { RoutingDecision, Tier } from "./types.js";
import { route } from "./router/index.js";
import { readFileSync } from "node:fs";
```

**Bad:**
```typescript
import { route, type RoutingDecision } from "./router";  // missing .js
import RoutingDecision from "./types";  // default export
```

### Naming Conventions
| Element | Convention | Example |
|---------|------------|---------|
| Types/Interfaces | PascalCase | `RoutingDecision`, `ApiKeysConfig` |
| Functions | camelCase | `fetchWithRetry`, `loadApiKeys` |
| Constants | SCREAMING_SNAKE_CASE | `DEFAULT_RETRY_CONFIG`, `PROVIDER_ENDPOINTS` |
| Files | kebab-case | `api-keys.ts`, `openrouter-models.ts` |
| Enums | PascalCase members | `Tier.SIMPLE`, `Tier.MEDIUM` |

### Type Definitions
- Use `type` for simple type aliases; use `interface` when extension may be needed
- Always export types that are part of public API
- Use `Record<string, T>` instead of `{ [key: string]: T }` for object types

**Good:**
```typescript
export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";
export interface RoutingDecision {
  tier: Tier;
  model: string;
  reasoning: string;
}
```

### Error Handling
- Use specific error types when possible
- Always handle promise rejections (avoid unhandled rejections)
- For optional operations, use try/catch with meaningful error messages
- Use `instanceof Error` checks before accessing `error.message`

**Good:**
```typescript
try {
  const data = readFileSync(path, "utf-8");
} catch (err) {
  if (err instanceof Error) {
    logger.error(`Failed to read file: ${err.message}`);
  }
  return undefined;
}
```

**Bad:**
```typescript
try {
  const data = readFileSync(path, "utf-8");
} catch {  // silent catch - avoids eslint/no-empty
  return undefined;
}
```

### Async/Await
- Always use `async/await` over raw promises
- Handle async errors with try/catch
- Don't leave promises floating (ensure they're awaited or returned)

### JSDoc Comments
- Use JSDoc for public APIs and exported functions
- Keep comments concise; don't restate what the type signature already tells you
- Include `@example` blocks for complex utility functions

**Good:**
```typescript
/**
 * Route a request to the cheapest capable model.
 * @param prompt - The user prompt
 * @param systemPrompt - Optional system prompt
 * @param maxOutputTokens - Maximum output tokens
 * @returns RoutingDecision with model selection and cost estimates
 */
export function route(prompt: string, systemPrompt: string | undefined, maxOutputTokens: number, options: RouterOptions): RoutingDecision
```

### Formatting (Prettier)
- **Semicolons:** required
- **Single quotes:** disabled (use double quotes)
- **Trailing commas:** all
- **Print width:** 100 characters
- **Tab width:** 2 spaces

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

### ESLint Rules
- Extends `typescript-eslint` recommended config
- Warnings/errors for:
  - No implicit any (`@typescript-eslint/no-explicit-any`)
  - Consistent async/await
  - Properly typed function signatures
- Ignores: `dist/`, `node_modules/`, `test/`

---

## Project Structure

```
src/
├── index.ts          # Plugin entry point, exports
├── api-keys.ts       # API key configuration management
├── cli.ts            # CLI implementation
├── dedup.ts          # Request deduplication
├── logger.ts         # Usage logging
├── models.ts         # Model definitions and pricing
├── openrouter-models.ts  # OpenRouter model catalog
├── proxy.ts          # Local proxy server
├── provider.ts       # OpenClaw provider definition
├── retry.ts          # Retry logic with exponential backoff
├── session.ts        # Session pinning
├── stats.ts          # Usage statistics
├── types.ts          # TypeScript type definitions
├── version.ts        # Version info
└── router/
    ├── index.ts      # Main routing logic
    ├── config.ts     # Routing configuration
    ├── llm-classifier.ts  # LLM-based fallback classifier
    ├── rules.ts      # Rule-based classifier (15 dimensions)
    └── selector.ts   # Model selection for tier

test/
├── e2e.ts            # End-to-end tests
├── test-retry.ts     # Retry logic unit tests
├── types.ts          # Test type utilities
└── *.ts              # Feature-specific tests
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

### Routing Decision Flow
1. Check overrides (large context, structured output)
2. Run rule-based classifier (15 weighted dimensions, <1ms)
3. If ambiguous, default to configurable tier (no external API calls)
4. Select model for tier from available providers
5. Return `RoutingDecision` with model, cost estimates, and reasoning

### Provider Access Resolution
Priority: Direct provider key > OpenRouter fallback (for OpenAI-compatible providers). Anthropic and Google always route through OpenRouter due to API incompatibilities.

---

## Common Issues / Gotchas

1. **ESM imports require `.js` extension** - Always use `./foo.js` not `./foo`
2. **TypeScript strict mode** - All variables must be typed or have clear type inference
3. **Async error handling** - Never leave async operations unhandled
4. **OpenClaw plugin hooks** - Use `registerService` for cleanup on shutdown
5. **Test file location** - Tests are in `test/` but ESLint ignores this directory
6. **Peer dependency** - OpenClaw is a peer dependency (`>=2025.1.0`)
