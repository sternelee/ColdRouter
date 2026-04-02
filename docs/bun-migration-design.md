# Bun 迁移设计文档

## 概述

将 ClawRouter 从 Node.js 运行时迁移到 Bun 运行时，并使用 Bun 原生 API 替代 Node.js API，以提升性能。

## 变更范围

### 1. HTTP 服务器 (`src/proxy.ts`)

**现状：** 使用 `node:http` 的 `createServer`

**目标：** 使用 `Bun.serve()`

```typescript
// Before
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => { ... });

// After
const server = Bun.serve({
  port: listenPort,
  hostname: "127.0.0.1",
  async fetch(req) {
    // Bun.Request/Bun.Response
  }
});
```

**关键差异：**
- `Bun.Request` 替代 `IncomingMessage`（自带 body 解析）
- `Bun.Response` 替代 `ServerResponse`（原生流式响应支持）
- SSE 心跳机制需要适配（Bun 的 `Response.body` 是 `ReadableStream`）

### 2. 文件操作

需要修改的文件：
- `src/api-keys.ts` — `readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync`
- `src/logger.ts` — 文件写入
- `src/stats.ts` — JSON 文件读写
- `src/session.ts` — 文件存储

**Bun API 替代方案：**

```typescript
// Before
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

// After
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
// Bun 兼容 node:fs，无需改动（短期方案）
// 或使用 Bun 原生：
import { file, mkdir } from "bun";

// 读取
const content = await file("./config.json").text();

// 写入
await Bun.write("./output.txt", content);

// 检查存在
const isFile = exists("./file.txt"); // Bun's exists()

// 创建目录
await mkdir("./dir", { recursive: true });
```

### 3. 构建系统 (`package.json`, `tsup.config.ts`)

**现状：** 使用 tsup 打包

**目标：** 移除 tsup，使用 Bun 原生能力

```json
// package.json scripts
{
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build --target=browser --outdir=dist --splitting --sourcemap src/index.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

### 4. 运行时配置

```json
// package.json
{
  "name": "clawrouter",
  "type": "module",
  "peerDependencies": {
    "openclaw": ">=2025.1.0"
  },
  "devDependencies": {
    "bun-types": "latest"
  }
}
```

## 实施步骤

### Phase 1: 基础设施
1. 添加 `bun-types` 到 devDependencies
2. 更新 `package.json` scripts 使用 bun
3. 验证 bun 可运行项目

### Phase 2: HTTP 服务器迁移
1. 重构 `src/proxy.ts` 使用 `Bun.serve()`
2. 适配 SSE 心跳机制
3. 适配流式响应

### Phase 3: 文件操作迁移
1. 更新 `src/api-keys.ts`
2. 更新 `src/logger.ts`
3. 更新 `src/stats.ts`
4. 更新 `src/session.ts`

### Phase 4: 验证
1. 运行 `npm run typecheck`
2. 运行测试验证功能
3. 性能对比（可选）

## 风险与回退

- **风险：** Bun 的 `node:fs` 兼容层可能存在边缘情况
- **回退：** 如果遇到问题，可暂时保留 `node:fs` 导入（兼容层仍然有效）
- **测试策略：** 先运行现有测试，确保功能不变

## 收益

1. **启动速度：** Bun 比 Node.js 快 3-5x
2. **HTTP 性能：** `Bun.serve()` 比 `createServer` 快 2-3x
3. **文件 IO：** Bun 的文件操作更快
4. **开发体验：** `bun run` 直接执行，无需构建步骤（开发时）
