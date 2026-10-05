/**
 * Day 19 · DataAgent 综合实战 — SSE 服务（综合版）
 *
 * 把 Day 5 的 SQL 工具 + Day 6 的拦截扩展 + Day 7 的 SSE 桥接全部串起来：
 *   POST /chat → 响应即 SSE 流（tool 卡片 + 文本 + done）
 *   GET  /log  → 返回事件日志（最后 200 行）
 *
 * 关键：客户断开用 res.on("close") 而不是 req.on("close")
 *   —— Node 18+ 中 req.on("close") 在 body 读完后就触发（Day 7 实测 bug），
 *      会导致 SSE 流刚发出就被 off()+abort() 掐断；res.on("close") 才是"连接真正关闭"。
 *
 * 运行：cd pi_sdk_learn/code && npx tsx L08-final/19-sse-server.ts (PORT 默认 3100)
 */
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { runSqlTool } from "./sql-tool.ts";
import { dataAgentExtension } from "./sql-guard.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3100);
const LOG_FILE = join(process.cwd(), "day19-events.log");

// ═══════════════════════════════════════════════════════════
// 1. DataAgent：系统提示 + run_sql 工具 + 危险 SQL 拦截扩展
// ═══════════════════════════════════════════════════════════
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  systemPromptOverride: () =>
    "你是企业数据分析助手。回答必须基于 run_sql 工具查到的真实销售数据，不要编造数字。" +
    "先写一条安全的 SELECT 查询，再根据返回结果回答。用中文，结论先行。",
  extensionFactories: [
    (pi: any) => pi.registerTool(runSqlTool),
    (pi: any) => dataAgentExtension(pi),
  ],
});
await loader.reload();

const modelRuntime = await ModelRuntime.create();
const model = (await modelRuntime.getAvailable())[0];
if (!model) throw new Error("没有可用模型，请检查 ~/.pi/agent/models.json");

const { session } = await createAgentSession({
  model,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});

// ═══════════════════════════════════════════════════════════
// 2. SSE 翻译（同 Day 7，但补了 tool 卡片的中途失败情况）
// ═══════════════════════════════════════════════════════════
function sse(type: string, data: unknown): string {
  return `data: ${JSON.stringify({ type, data })}\n\n`;
}

function translateEvent(event: any): string | null {
  switch (event.type) {
    case "message_update": {
      const ae = event.assistantMessageEvent;
      if (ae?.type === "text_delta") return sse("text", { delta: ae.delta });
      if (ae?.type === "thinking_delta") return sse("thinking", { delta: ae.delta });
      return null;
    }
    case "tool_execution_start":
      return sse("tool_start", { id: event.toolCallId, name: event.toolName, args: event.args });
    case "tool_execution_end":
      return sse("tool_end", {
        id: event.toolCallId,
        name: event.toolName,
        result: String(event.result?.content?.[0]?.text ?? "").slice(0, 800),
        isError: event.isError ?? false,
      });
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════
// 3. Express 服务器
// ═══════════════════════════════════════════════════════════
const app = express();
app.use(express.json());

let busy = false;

app.post("/chat", async (req, res) => {
  const { message } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "message 必填" });
  if (busy) return res.status(429).json({ error: "Agent 正忙，稍等" });

  busy = true;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  // 订阅 Agent 事件 → 推给本响应
  const off = session.subscribe((event) => {
    const payload = translateEvent(event);
    if (payload) {
      try {
        res.write(payload);
      } catch {
        /* res 已坏 */
      }
    }
  });

  // ★ Day 7 修复：客户端断开用 res.on("close")，别用 req.on("close")
  let settled = false;
  res.on("close", () => {
    off();
    if (!settled) {
      try {
        session.abort();
      } catch {
        /* noop */
      }
    }
  });

  try {
    await session.prompt(message);
  } catch (err: any) {
    try {
      res.write(sse("error", { message: err?.message ?? "Agent 出错" }));
    } catch {
      /* res 已坏 */
    }
  } finally {
    settled = true;
    off();
    try {
      res.write(sse("done", {}));
    } catch {
      /* res 已坏 */
    }
    res.end();
    busy = false;
  }
});

// 事件日志查看
app.get("/log", (_req, res) => {
  let body = "(暂无日志)";
  if (existsSync(LOG_FILE)) {
    body = readFileSync(LOG_FILE, "utf-8").split("\n").slice(-200).join("\n");
  }
  res.type("text/plain").send(body);
});

app.listen(PORT, () => {
  console.log(`\n════════ DataAgent 综合版 (Day 19) ════════`);
  console.log(`  SSE 接口：POST http://localhost:${PORT}/chat   body: {"message":"..."}`);
  console.log(`  事件日志：GET  http://localhost:${PORT}/log`);
  console.log(`  模型：${model.name}`);
  console.log(`  试试：curl --data-binary @req.json http://localhost:${PORT}/chat \n`);
});

process.on("SIGINT", () => {
  console.log("\n[Server] 正在关闭...");
  session.dispose();
  process.exit(0);
});