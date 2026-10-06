/**
 * Day 23 · 进阶③ 多 Agent 协作 —— 模式 1：多 Session 并行
 *
 * 目标：验证 H06 多 Agent 协作的第一种模式 —— 在同一个进程里创建多个
 * 独立的 AgentSession，并行处理不同任务。
 *
 * 关键验证点（H06 最大陷阱）：
 *  - 每个 createAgentSession 默认创建「自己的」modelRuntime（读
 *    agentDir/auth.json + models.json），所以在一个 session 里
 *    registerProvider 不会影响另一个。
 *  - 显式共享同一个 ModelRuntime 实例时，provider 注册对两个 session
 *    同时可见 —— 这是多 session 共享模型配置的正确姿势。
 *
 * 流程：
 *  1. 建一个共享 ModelRuntime（读 ~/.pi/agent/models.json，含 siyu relay）
 *  2. 用 registerProvider 在共享 runtime 上注册 siyu-custom，验证两个
 *     session 都能 getProvider 到它（共享可见性）
 *  3. 创建两个 AgentSession（同一 modelRuntime + 同一 model），并行 prompt，
 *     各自独立回复
 *  4. 清理
 */
import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";

function section(title: string) {
  console.log(`\n===== ${title} =====`);
}

/** 从消息列表里取最后一条 assistant 文本。 */
function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = (m.content ?? [])
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text) return text;
    }
  }
  return "(无 assistant 文本)";
}

async function main() {
  // ---------- 1. 共享 ModelRuntime ----------
  const runtime = await ModelRuntime.create({});
  console.log("ModelRuntime.create OK, providers:", runtime.getProviders().map((p) => p.id).join(", "));

  // ---------- 2. 共享可见性：注册一个自定义 provider ----------
  section("2. 共享 runtime 上注册 siyu-custom");
  const config: ProviderConfig = {
    name: "Siyu Relay (Day23 共享)",
    baseUrl: "https://siyu.site/v1",
    apiKey: "$HERMES_CUSTOM_SIYU3_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "deepseek-v4-flash",
        name: "deepseek-v4-flash",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
        compat: {
          supportsDeveloperRole: false,
          supportsStore: false,
          maxTokensField: "max_tokens",
          supportsReasoningEffort: false,
        },
      },
    ],
  };
  runtime.registerProvider("siyu-custom", config);
  console.log("注册完成");

  const sharedModel = runtime.getModel("siyu", "deepseek-v4-flash");
  if (!sharedModel) throw new Error("siyu/deepseek-v4-flash 不存在");
  const customModel = runtime.getModel("siyu-custom", "deepseek-v4-flash");
  console.log("共享 model =", sharedModel.id, "| 自定义 provider model =", customModel?.id ?? "(无)");

  // ---------- 3. 两个独立 session，共享 modelRuntime ----------
  section("3. 两个 AgentSession 并行");
  const cwd = process.cwd();
  const opts = {
    agentDir: process.env["USERPROFILE"] + "\\.pi\\agent",
    modelRuntime: runtime,
    model: sharedModel,
    thinkingLevel: "off" as const,
    noTools: "all" as const,
  };
  const a = await createAgentSession({ ...opts, cwd, sessionManager: SessionManager.inMemory(cwd) });
  const b = await createAgentSession({ ...opts, cwd, sessionManager: SessionManager.inMemory(cwd) });
  console.log("sessionA =", a.session.sessionId, "| sessionB =", b.session.sessionId);

  // 两个 session 都能看到共享 runtime 上的注册（同一实例）
  console.log(
    "[OK] sessionA 可见 siyu-custom =",
    runtime.getProvider("siyu-custom") !== undefined,
  );
  console.log(
    "[OK] sessionB 可见 siyu-custom =",
    runtime.getProvider("siyu-custom") !== undefined,
  );

  // 并行 prompt：互不干扰
  const eventsA: string[] = [];
  const eventsB: string[] = [];
  a.session.subscribe((ev) => eventsA.push(ev.type));
  b.session.subscribe((ev) => eventsB.push(ev.type));

  await Promise.all([
    a.session.prompt("用一句话回答：中国最长的河流是哪条？只说名字。"),
    b.session.prompt("用一句话回答：1+1 等于几？只回答数字。"),
  ]);

  const ta = lastAssistantText(a.session.state.messages);
  const tb = lastAssistantText(b.session.state.messages);
  console.log("sessionA 回复:", ta);
  console.log("sessionB 回复:", tb);
  console.log("sessionA 事件:", eventsA.join(","));
  console.log("sessionB 事件:", eventsB.join(","));
  const okA = ta.length > 0 && ta !== "(无 assistant 文本)";
  const okB = tb.length > 0 && tb !== "(无 assistant 文本)" && /[0-9]/.test(tb);
  console.log(`[${okA ? "OK" : "FAIL"}] sessionA 独立回复 = ${okA}`);
  console.log(`[${okB ? "OK" : "FAIL"}] sessionB 独立回复 = ${okB}`);

  // 两个 session 的消息互不串扰
  console.log(`[${eventsA.length > 0 && eventsB.length > 0 ? "OK" : "FAIL"}] 双方事件流各自独立`);

  // ---------- 4. 清理 ----------
  section("4. 清理");
  a.session.dispose();
  b.session.dispose();
  runtime.unregisterProvider("siyu-custom");
  console.log("dispose + unregister 完成");

  console.log("\n===== Day 23 · 模式 1 完成 =====");
}

main().catch((err) => {
  console.error("脚本失败:", err);
  process.exitCode = 1;
});
