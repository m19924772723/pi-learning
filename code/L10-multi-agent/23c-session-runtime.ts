/**
 * Day 23 · 进阶③ 多 Agent 协作 —— 模式 3：AgentSessionRuntime 切换
 *
 * 目标：验证 H06 中的「宿主管理多个会话」模式 —— 用
 * createAgentSessionRuntime 持有当前 AgentSession，通过 newSession /
 * switchSession 在同一进程里替换会话，并由 setRebindSession 回调感知切换。
 *
 * 流程：
 *  1. 建共享 ModelRuntime + model（siyu relay / deepseek-v4-flash）
 *  2. createAgentSessionServices + createAgentSessionFromServices 组合成
 *     CreateAgentSessionRuntimeFactory（CLI 交互模式的真实构造方式）
 *  3. createAgentSessionRuntime 拿到 runtime，初始 session prompt 一次（真实链路）
 *  4. setRebindSession 挂回调；newSession() 创建新会话 → 断言 sessionId 变化、
 *     回调触发、新会话可正常对话
 *  5. switchSession(旧会话文件) 切回 → 断言恢复旧 sessionId
 *  6. dispose 清理
 */
import {
  ModelRuntime,
  SessionManager,
  createAgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

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
  // 真实持久化会话目录放到 scratch，避免污染学习代码目录
  const cwd = process.cwd();
  const sessionDir = process.env["PI_SCRATCH_DIR"] + "\\day23c-sessions";
  const sessionManager = SessionManager.create(cwd, sessionDir);

  // ---------- 2. Runtime factory ----------
  section("2. CreateAgentSessionRuntimeFactory");
  const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir,
      modelRuntime: runtime,
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      model,
      thinkingLevel: "off",
      noTools: "all",
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  console.log("factory OK");

  // ---------- 3. 创建 runtime + 初始会话真实对话 ----------
  section("3. 初始 session prompt");
  const ar = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
  const initialId = ar.session.sessionId;
  const initialFile = ar.session.sessionFile;
  console.log("初始 sessionId =", initialId, "| file =", initialFile ?? "(无)");

  let rebindCount = 0;
  ar.setRebindSession((session) => {
    rebindCount += 1;
    console.log(`[rebind] 切换完成 → 新 sessionId = ${session.sessionId}`);
  });

  const events: string[] = [];
  ar.session.subscribe((ev) => events.push(ev.type));
  await ar.session.prompt("用一句话回答：地球的卫星叫什么？只说名字。");
  const r1 = lastAssistantText(ar.session.state.messages);
  console.log("初始 session 回复:", r1);
  const okInit = r1.length > 0 && r1 !== "(无 assistant 文本)";

  // ---------- 4. newSession 切换 ----------
  section("4. newSession() 创建新会话");
  const beforeId = ar.session.sessionId;
  await ar.newSession();
  const afterId = ar.session.sessionId;
  console.log("切换前 =", beforeId, "→ 切换后 =", afterId);
  const okNew = afterId !== beforeId && ar.session.state.messages.length === 0;

  // 新会话再真实对话一次
  await ar.session.prompt("用一句话回答：太阳系最大的行星叫什么？只说名字。");
  const r2 = lastAssistantText(ar.session.state.messages);
  console.log("新会话回复:", r2);
  const okNewTalk = r2.length > 0 && r2 !== "(无 assistant 文本)";
  console.log(`[${okNew ? "OK" : "FAIL"}] newSession 切换 = ${okNew}`);
  console.log(`[${okNewTalk ? "OK" : "FAIL"}] 新会话可对话 = ${okNewTalk}`);

  // ---------- 5. switchSession 切回旧会话 ----------
  section("5. switchSession(初始会话文件)");
  if (initialFile) {
    await ar.switchSession(initialFile);
    const backId = ar.session.sessionId;
    console.log("切回后 sessionId =", backId, "（期望 =", initialId, "）");
    const okBack = backId === initialId;
    console.log(`[${okBack ? "OK" : "FAIL"}] switchSession 恢复旧会话 = ${okBack}`);
  } else {
    console.log("初始会话无文件，跳过 switchSession 验证");
  }

  // ---------- 6. 清理 ----------
  section("6. 清理");
  const okRebind = rebindCount >= 1;
  console.log(`[${okRebind ? "OK" : "FAIL"}] setRebindSession 回调触发 ${rebindCount} 次`);
  await ar.dispose();
  console.log("dispose 完成");
  console.log("[OK] 全程 OK =", okInit && okNew && okNewTalk && okRebind);

  console.log("\n===== Day 23 · 模式 3 完成 =====");
}

main().catch((err) => {
  console.error("脚本失败:", err);
  process.exitCode = 1;
});
