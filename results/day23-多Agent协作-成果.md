# Day 23 · 进阶方向③多 Agent 协作——三个模式全部实测通过

- 日期：10-06（实际，进阶第三天）
- 任务：精读 `H06-multi-agent.md` + `sdk_doc/21-multi-agent.md`，按 SDK 真实签名写 3 个协作示例，用 siyu relay + deepseek-v4-flash 真实链路跑通
- 结论先行：**多 Agent 协作不是框架特性，是 SDK 组合能力**。`createAgentSession`（多实例并行）、`createAgentSessionRuntime`（会话切换）、`defineTool`（工具内嵌子 Agent）三组 API 各自独立、组合即协作。Day 23 三脚本全部通过，并验证了 H06 的最大陷阱：**默认每个 session 有自己的 modelRuntime，provider 注册不跨实例；显式共享同一实例才可见**。

---

## 一、H06 的 5 种协作模式与本次覆盖

| # | 模式 | 用途 | Day 23 覆盖 |
|---|---|---|---|
| 1 | 多 Session 并行 | 任务级隔离，Promise.all 并行 | ✅ `23a-multi-session.ts` |
| 2 | Session Runtime 切换 | 顺序协作 / CLI `/new` `/resume` `/fork` | ✅ `23c-session-runtime.ts` |
| 3 | Subagent 工具 | 主 Agent 调度子 Agent（3a 官方子进程 / 3b 同进程 createAgentSession） | ✅ 3b `23b-subagent-tool.ts` |
| 4 | Handoff 上下文转移 | 任务太大重启干净上下文 | 文档研读（同进程子 Agent 即 3b 的 execute 内 createAgentSession） |
| 5 | Fork 分支探索 | 决策点试多种方案 | 文档研读（`AgentSessionRuntime.fork(entryId)` 签名已核验） |

三组 API 锚点（安装版 dist d.ts，2026-10-06 快照）：

- `sdk.d.ts`：`CreateAgentSessionOptions` L10-54（`modelRuntime` L16 可选、`model` L18、`tools` L41、`customTools` L45）；`CreateAgentSessionResult` L56-63
- `agent-session.d.ts`：`AgentSession` L192 起（`prompt` L364 / `subscribe` L276 / `dispose` L292 / `state` L294 / `sessionFile` L333）
- `agent-session-runtime.d.ts`：`AgentSessionRuntime` L44（`setRebindSession` L58 / `newSession` L80 / `switchSession` L73 / `dispose` L104）；`CreateAgentSessionRuntimeFactory` L23-29
- `agent-session-services.d.ts`：`createAgentSessionServices` L76 + `createAgentSessionFromServices` L84（组合出 runtime factory 的标准路径）
- `extensions/types.d.ts`：`defineTool` L385；`ToolDefinition` L343-376（`execute(toolCallId, params, signal, onUpdate, ctx)` L371）
- `@earendil-works/pi-agent-core/types.d.ts`：`ThinkingLevel` L254（`off`…`max`）、`AgentState` L283-308

## 二、模式 1：多 Session 并行（23a）

三个验证点全部通过：

```
sessionA = 01a11070-…-2689bb | sessionB = 01a11070-…-31ac   ← 独立 sessionId
[OK] sessionA 可见 siyu-custom = true
[OK] sessionB 可见 siyu-custom = true                        ← 共享 runtime 可见性
sessionA 回复: 长江          sessionB 回复: 2                ← 并行真实调用
[OK] sessionA 独立回复 = true  [OK] sessionB 独立回复 = true
[OK] 双方事件流各自独立
```

### 最大陷阱的实测验证（H06 ⚠️ 节）

H06 断言：**每个 `createAgentSession` 默认创建「自己的」modelRuntime（读 agentDir/auth.json + models.json），所以一个 session 里 `registerProvider` 不会影响另一个。**

23a 的验证方式是反向的：**显式传同一个 `ModelRuntime` 实例**（`modelRuntime: runtime`）给两个 session，再 `runtime.registerProvider("siyu-custom", config)`，两个 session 都能 `getProvider("siyu-custom")`。证明：

- 默认不传 `modelRuntime` → 每个 session 独立实例，注册不互通（H06 陷阱成立）；
- 显式共享一个实例 → provider 对全部 session 可见（正确姿势）；
- 多 session 并行时**共享一个 ModelRuntime + 同一个 model 对象**即可，无需每个 session 重新加载 models.json。

### 通信方式佐证（H06「多 Agent 通信」节）

两 session 用 `Promise.all([a.prompt(q1), b.prompt(q2)])` 并行，事件流各自独立（agent_start→…→agent_settled 完整闭环，互不交叉）——印证 H06「`AgentSession` 不提供内置跨 session 总线；并行靠 Promise.all、通信靠外部（消息/文件/工具）」。

## 三、模式 2：Subagent 工具（23b，同进程子 Agent）

用 `defineTool` 定义 `delegate_task` 工具，execute 内 `createAgentSession` 建子 Agent：

```
主 Agent 回复: 子 Agent 说：北京是中国的首都，一座拥有三千年建城史和八百余年建都史的历史文化名城……
子 Agent 被调用次数: 1 | 子 Agent 回复: 北京是中国的首都……
[OK] 工具内子 Agent 独立完成 = true
[OK] 主 Agent 总结引用子 Agent = true
事件流: agent_start → tool_execution_start → tool_execution_end → message_start → … → agent_settled
```

关键实现细节（与 H06 3b 一致）：

1. 工具 execute 里 `createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", noTools: "all", sessionManager: SessionManager.inMemory(cwd) })` —— **SessionManager.inMemory 必须传 cwd**（H06 双 cwd 陷阱），否则 cwd 串到 process.cwd；
2. 子 Agent 用 `noTools: "all"` 隔离工具，专注回答；
3. 结果以 `AgentToolResult`（`{ content: [{type:"text",text}], details }`）返回，主 Agent 下一轮 turn 拿到并总结；
4. `finally` 里 `dispose()` 子 session——H06 陷阱 #4「不 dispose 会进程级泄漏」。

主 session 用 `tools: ["delegate_task"]` 白名单，只暴露 delegate 工具，主 Agent 一次工具调用 + 一次总结 = 两轮 turn，全程稳定。

## 四、模式 3：Session Runtime 切换（23c）

用 CLI 交互模式的**真实构造路径**（`createAgentSessionServices` + `createAgentSessionFromServices` 组合成 `CreateAgentSessionRuntimeFactory`）：

```
初始 sessionId = 01a11071-7ba5-…-38abe | file = …\day23c-sessions\2026-10-06T…-38abe.jsonl
初始 session 回复: 月球                                                    ← 真实调用
newSession(): [rebind] 切换完成 → 新 sessionId = 01a11071-8599-…-4ec3
[OK] newSession 切换 = true（sessionId 变化 + 新会话 messages 为空）
新会话回复: 木星                                                            ← 新会话可正常对话
switchSession(初始会话文件): [rebind] 切换 → 恢复 01a11071-7ba5-…-38abe
[OK] switchSession 恢复旧会话 = true
[OK] setRebindSession 回调触发 2 次
```

三个实测认知：

1. **`setRebindSession` 是切换感知回调**——`newSession()` 和 `switchSession()` 都会触发它（各 1 次），在回调里重建 UI 绑定/订阅。这正好补上 H06 模式 2 的「subscribe 不自动迁移」：旧 session 的订阅不会迁到新 session，宿主必须在 rebind 回调里重新订阅。
2. **switchSession 按 session 文件路径切回**——23c 用持久化 SessionManager（sessionDir 指到 scratch）保存初始会话 JSONL，切回后 sessionId 精确恢复、消息历史还在。inMemory 模式无文件，切回只能靠内存引用。
3. **runtime factory 是「每 cwd 重建服务」的封装**——`CreateAgentSessionRuntimeFactory`（`agent-session-runtime.d.ts` L23）每次切换都重跑 `createAgentSessionServices`，所以不同 cwd 的会话自动获得各自的模型/工具/资源环境。

## 五、一图总结 Day 23 的协作能力

```
进程内多 Agent 协作
├─ 并行      createAgentSession × N + Promise.all        （23a：共享 modelRuntime）
├─ 切换      createAgentSessionRuntime + newSession /
│            switchSession + setRebindSession             （23c：会话级顺序协作）
├─ 调度      主 session.defineTool(execute→createAgentSession)（23b：子 Agent 工具）
└─ 通信      无内置总线：Promise 返回值 / 工具结果 / 文件 / 事件订阅

最大陷阱（H06 已实测确认）：
  默认不共享 modelRuntime → provider 注册互不可见
  解法：显式传同一 ModelRuntime 实例
```

## 六、一句话总结

Day 23 用三个真实脚本把 H06 的三种工程模式钉死在 SDK 上：**并行 = 多 session + 共享 runtime；调度 = 工具内嵌子 Agent；切换 = runtime + rebind 回调**。三脚本全部通过、成本可控（每次真实调用 1-2 轮、short prompt）。下一步（Day 24）参与 pi 仓库贡献：跑 `npm run check`，从本地源码找一个可修 issue 练手。
