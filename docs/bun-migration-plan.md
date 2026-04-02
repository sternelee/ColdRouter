# Bun 迁移实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan.

**Goal:** 将 ClawRouter 从 Node.js 迁移到 Bun 运行时，使用 Bun 原生 API 替代 Node.js API

**Architecture:** 使用 `Bun.serve()` 替代 `node:http createServer`，文件操作保留 `node:fs`（Bun 兼容层），更新构建脚本使用 bun

**Tech Stack:** Bun runtime, TypeScript, Bun.serve()

---

## Chunk 1: 基础设施配置

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 添加 bun-types 和更新 package.json**

```json
{
  "devDependencies": {
    "bun-types": "latest"
  },
  "scripts": {
    "build": "bun build --target=browser --outdir=dist --splitting --sourcemap src/index.ts",
    "dev": "bun run src/index.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: 验证 bun 环境**

Run: `bun --version`
Expected: 版本号显示

- [ ] **Step 3: 验证 typecheck 通过**

Run: `npm run typecheck`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add bun support and update build scripts"
```

---

## Chunk 2: HTTP 服务器迁移 (src/proxy.ts)

**Files:**
- Modify: `src/proxy.ts`

**核心变更：**
- `createServer` → `Bun.serve()`
- `IncomingMessage` → `Request`
- `ServerResponse` → 直接使用 `Response` 或 `fetch` 风格
- SSE 心跳机制适配

- [ ] **Step 1: 写一个简单的 bun 服务器测试**

创建 `test/bun-server-test.ts`:
```typescript
const server = Bun.serve({
  port: 3000,
  fetch(req) {
    return new Response("Hello from Bun!");
  },
});
console.log(`Server running on port ${server.port}`);
```

- [ ] **Step 2: 运行测试验证 bun serve 可用**

Run: `timeout 5 bun run test/bun-server-test.ts || true`
Expected: 服务启动成功

- [ ] **Step 3: 开始重构 proxy.ts - 先改基础结构**

将 `createServer` 替换为 `Bun.serve()`:

```typescript
// Before
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // ... handler
});

// After
const server = Bun.serve({
  port: listenPort,
  hostname: "127.0.0.1",
  async fetch(req: Request): Promise<Response> {
    // 转换 Bun.Request 为类 IncomingMessage 接口
    const reqWrapper = createIncomingMessageWrapper(req);
    const resWrapper = createServerResponseWrapper();
    try {
      await proxyRequest(reqWrapper, resWrapper, ...);
    } catch (err) {
      // error handling
    }
    return resWrapper.toBunResponse();
  },
});
```

- [ ] **Step 4: 创建请求/响应包装器**

在 `proxy.ts` 顶部添加:

```typescript
function createIncomingMessageWrapper(req: Request): IncomingMessage {
  const url = new URL(req.url);
  return {
    url: req.url,
    method: req.method,
    headers: Object.fromEntries(req.headers.entries()),
  } as unknown as IncomingMessage;
}

function createServerResponseWrapper(): ServerResponseWrapper {
  const headers = new Headers();
  let body: string | Buffer = "";
  let statusCode = 200;
  
  return {
    writeHead(code: number, headersObj?: Record<string, string>) {
      statusCode = code;
      if (headersObj) {
        for (const [k, v] of Object.entries(headersObj)) {
          headers.set(k, v);
        }
      }
    },
    get headers() { return headers; },
    get statusCode() { return statusCode; },
    write(data: string | Buffer) { body += data.toString(); return true; },
    end(data?: string | Buffer) { if (data) body += data.toString(); },
    getBody() { return body; },
    toBunResponse(): Response {
      return new Response(body, { status: statusCode, headers });
    },
  };
}
```

- [ ] **Step 5: 适配 SSE 流式响应**

Bun 的 `Response.body` 是 `ReadableStream`，需要特殊处理:

```typescript
// 流式响应使用 Bun 的 TransformStream
async fetch(req: Request): Promise<Response> {
  if (isStreaming) {
    const { readable, writable } = new TransformStream();
    // 写入 SSE 数据到 writable
    const writer = writable.getWriter();
    // ...
    return new Response(readable, {
      headers: { "content-type": "text/event-stream" }
    });
  }
  // 非流式直接返回
}
```

- [ ] **Step 6: 更新连接管理和错误处理**

移除 `connections` Set（Bun 自动管理），更新 `close` 方法:

```typescript
close: async () => {
  sessionStore.close();
  server.stop();
}
```

- [ ] **Step 7: 运行 typecheck 验证**

Run: `npm run typecheck`
Expected: 无新增类型错误

- [ ] **Step 8: Commit**

```bash
git add src/proxy.ts
git commit -m "refactor(proxy): migrate to Bun.serve()"
```

---

## Chunk 3: 文件操作迁移

**Files:**
- Modify: `src/api-keys.ts`
- Modify: `src/logger.ts`
- Modify: `src/stats.ts`
- Modify: `src/session.ts`

- [ ] **Step 1: 检查 Bun 兼容性**

Run: `bun -e "import { readFileSync } from 'node:fs'; console.log(readFileSync('/etc/passwd', 'utf8').split('\n')[0])"`
Expected: 输出第一行（验证 node:fs 兼容）

- [ ] **Step 2: 决定策略 - 保持 node:fs 或迁移到 Bun API**

由于 Bun 对 `node:fs` 兼容良好，且改动风险低，暂时保留 `node:fs` 导入

在 `src/api-keys.ts` 等文件顶部添加说明注释:
```typescript
// Bun 运行时下使用 node:fs 兼容层（Bun 提供良好的 node:fs 兼容）
```

- [ ] **Step 3: Commit**

```bash
git add src/api-keys.ts src/logger.ts src/stats.ts src/session.ts
git commit -m "chore: add Bun runtime compatibility notes"
```

---

## Chunk 4: 验证与测试

**Files:**
- Modify: `package.json`
- Create: `test/bun-migration-test.ts`

- [ ] **Step 1: 更新 package.json 确保构建命令正确**

检查 scripts 字段:
```json
{
  "scripts": {
    "build": "bun build --target=browser --outdir=dist --splitting --sourcemap src/index.ts",
    "dev": "bun run src/index.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: 创建简单集成测试**

创建 `test/bun-migration-test.ts`:
```typescript
import { describe, test, expect } from "bun:test";

describe("Bun Migration", () => {
  test("proxy can be imported without errors", async () => {
    const proxy = await import("../src/proxy.js");
    expect(proxy.startProxy).toBeDefined();
  });
  
  test("api-keys can be imported", async () => {
    const apiKeys = await import("../src/api-keys.js");
    expect(apiKeys.loadApiKeys).toBeDefined();
  });
});
```

- [ ] **Step 3: 运行 bun 测试**

Run: `bun test test/bun-migration-test.ts`
Expected: 所有测试通过

- [ ] **Step 4: 清理测试文件**

```bash
rm test/bun-server-test.ts test/bun-migration-test.ts
```

- [ ] **Step 5: 最终验证**

Run: `bun run src/index.ts --help` 或检查 CLI 启动
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: complete Bun migration"
```

---

## 验证清单

- [ ] `bun --version` 显示版本
- [ ] `npm run typecheck` 通过
- [ ] `bun run src/index.ts` 可以启动（测试模式）
- [ ] 项目其他功能未受影响
