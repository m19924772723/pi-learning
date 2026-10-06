/**
 * Day 23 · 进阶③ 多 Agent 协作 —— 模式 2：Subagent 工具（工具内嵌子 Agent）
 *
 * 目标：验证「主 Agent 通过工具调用子 Agent」的协作模式。这是 H06 中
 * 最重要的一种：主 session 注册一个 delegate 工具，工具执行时内部创建
 * 一个全新的 AgentSession（子 agent）去完成子任务，再把结果文本返回给
 * 主 agent。
 *
 * 流程：
 *  1. 建共享 ModelRuntime + model（siyu relay / deepseek-v4-flash）
 *  2. 用 defineTool 定义 delegate_task 工具：execute 里 createAgentSession
 *     建子 session → prompt 子任务 → 收集最后 assistant 文本 → dispose
 *     子 session → 把结果作为 AgentToolResult 返回
 *  3. 主 session 注册 customTools=[delegate]，tools 白名单只留 delegate，
 *     prompt 让主 agent 调用该工具完成任务
 *  4. 断言：工具被执行、子 agent 有独立回复、主 agent 最终回复引用它
 */
import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
  defineTool,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

function section(title: string) {
  console.log(`\n===== ${title} =====`);
}

/** 从消息列表里取最后一条 assistant 文本。 */
function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = (m.content ?? [])
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
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
  const model = runtime.getModel("siyu", "deepseek-v4-flash");
  if (!model) throw new Error("siyu/deepseek-v4-flash 不存在");
  console.log("model =", model.id);

  const agentDir = process.env["USERPROFILE"] + "\\.pi\\agent";
  const cwd = process.cwd();

  // 子 agent 执行统计（验证只建了一次）
  let subAgentCalls = 0;
  let lastSubReply = "";

  // ---------- 2. delegate 工具 ----------
  section("2. 定义 delegate_task 工具");
  const delegateTool = defineTool({
    name: "delegate_task",
    label: "委派子任务",
    description:
      "把一段子任务委派给一个独立的子 Agent 完成，返回子 Agent 的完整回答。适合需要独立上下文的任务。",
    parameters: Type.Object({
      task: Type.String({ description: "要委派给子 Agent 的任务" }),
    }),
    execute: async (_toolCallId, params) => {
      subAgentCalls += 1;
      const sub = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: runtime,
        model,
        thinkingLevel: "off",
        noTools: "all",
        sessionManager: SessionManager.inMemory(cwd),
      });
      try {
        await sub.session.prompt(params.task);
        lastSubReply = lastAssistantText(sub.session.state.messages);
        return {
          content: [
            { type: "text" as const, text: `子 Agent 回复：${lastSubReply}` },
          ],
          details: { task: params.task, reply: lastSubReply },
        } satisfies AgentToolResult<{ task: string; reply: string }>;
      } finally {
        sub.session.dispose();
      }
    },
  });
  console.log("defineTool OK, name =", delegateTool.name);

  // ---------- 3. 主 session 使用 delegate ----------
  section("3. 主 session 调用 delegate 工具");
  const main = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    tools: ["delegate_task"], // 白名单：只允许 delegate 工具
    customTools: [delegateTool],
    sessionManager: SessionManager.inMemory(cwd),
  });

  const mainEvents: string[] = [];
  main.session.subscribe((ev) => mainEvents.push(ev.type));

  await main.session.prompt(
    "请调用 delegate_task 工具，让子 Agent 用一句话介绍北京。工具返回后，请用一行总结子 Agent 的回答，开头写「子 Agent 说：」。",
  );

  const mainReply = lastAssistantText(main.session.state.messages);
  console.log("主 Agent 回复:", mainReply);
  console.log("子 Agent 被调用次数:", subAgentCalls, "| 子 Agent 回复:", lastSubReply);
  console.log("事件流:", mainEvents.join(","));

  const okSub = subAgentCalls === 1 && lastSubReply.length > 0 && lastSubReply !== "(无 assistant 文本)";
  const okMain = mainReply.includes("子 Agent 说") && mainReply.includes("北京");
  console.log(`[${okSub ? "OK" : "FAIL"}] 工具内子 Agent 独立完成 = ${okSub}`);
  console.log(`[${okMain ? "OK" : "FAIL"}] 主 Agent 总结引用子 Agent = ${okMain}`);

  main.session.dispose();
  console.log("\n===== Day 23 · 模式 2 完成 =====");
}

main().catch((err) => {
  console.error("脚本失败:", err);
  process.exitCode = 1;
});
