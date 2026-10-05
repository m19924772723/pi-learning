# Day 6 · 事件监听——实现你的个性化需求（P06 实战）

- 日期：10-04
- 章节：《第6章-事件监听-实现你的个性化需求.md》（676 行 / 52,825 字节，全部 P 章中最长）
- 实验代码：`L06-extensions/06a-limit-guard.ts`（tool_call 拦截）、`06b-see-all-events.ts`（事件全景打印）
- 环境：pi 本地开发版 0.0.3（教程标注 v0.83，行号有漂移，以符号名为准）

---

## 一、章节核心要点

1. **事件监听的本质**：在 Agent 运行的固定环节挂上自己的代码（扩展 = Extension）。全景图三步：
   ① 决定监听哪个事件 → ② 写处理函数 → ③ 通过 `extensionFactories` 把扩展接进 Agent。
2. **两条监听通道（必须分清）**：

| 对比项 | `pi.on(...)`（扩展层，决策参与者） | `session.subscribe(...)`（外部层，事后旁观者） |
|---|---|---|
| 时机 | 事件**发生前/发生时**，可改内容 | 事件**发生后**，只能看 |
| 同步屏障 | `await handler(event, ctx)`，主循环等它 | 不 await，fire-and-forget |
| 返回值 | **有效**（block/reason、改 messages 等） | **作废**（忽略） |
| 事件覆盖面 | 全 33 个事件 | 漏掉约 21 个 |
| handler 签名 | `(event, ctx)` 双参 | `(event)` 单参 |

3. **5 个决策点事件**（subscribe 静默收不到）：`tool_call` / `tool_result` / `context` / `before_agent_start` / `input`。
4. **实战套路**：`tool_call` 拦截（返回 `{ block, reason }`，LLM 会看到 reason 并修正）、`tool_execution_*` 审计（toolCallId 配对）、`context` 注入偏好。
5. **重要警告**：纯观测/审计活儿（落库、记日志）别塞进 `on`——同步屏障会拖慢主循环。来自 `message_*` / `turn_*` / `tool_execution_*` / `agent_settled` 的用 subscribe，只有 6 个独有决策点必须走 `on` 时再用 fire-and-forget 写法。

## 二、运行记录

### 06a-limit-guard.ts（limit:9999 拦截演示）——跑两次，拦截未触发
- 提示词让 LLM 查"所有销售数据"并**传 limit=9999**（期望触发拦截）。
- 两次运行的 LLM 实际行为：第一次直接查回 12 行共 375,000 元（没传 limit）；第二次连续 `query_data` + bash + write，均未传超大 limit。
- **结论**：教程演示依赖 LLM 行为（不必然说 9999），拦截没触发不代表机制有问题——模型有随机性。

### 06b-see-all-events.ts（事件全景）——一次跑通，事件流完整
实测顺序与教程流程图**完全一致**：
`input → before_agent_start → agent_start → turn_start → message_start/end`（user 消息也触发）
`→ context → before_provider_request → after_provider_response → message_update × N（含 text_delta）`
`→ message_end → turn_end → agent_end → agent_settled`

### 确定性拦截 diag（临时脚本 `_diag-06-block.ts`，跑完已删）
为稳定复现 block 机制，写确定性脚本：提示词强制 LLM 传 `limit=9999`。实测输出：

```
tool_call(query_data, { limit: 9999 })
→ BLOCKED: limit=9999 > 100（handler 返回 { block: true, reason }）
→ LLM 收到 reason 文本（"单次最多返回 100 行，你请求了 9999 行..."）并改口建议用 limit=100
```

细节：被拦的调用**没有**触发 `tool_execution_start`（先执行的是 LLM 先做的一次正常小查询）——拦截发生在工具执行之前，符合设计。

注意：临时脚本放 `code/` 根目录时，相对路径应为 `./shared/lib/tools/query-data.ts`（`../shared/...` 会 ERR_MODULE_NOT_FOUND）。

## 三、源码对照表（本地开发版实际行号）

| 知识点 | 教程标注（v0.83） | 本地开发版（0.0.3） | 确认 |
|---|---|---|---|
| ExtensionAPI / `on()` 重载 | extensions/types.ts:1180、1190-1231 | `core/extensions/types.ts:1252` 起（on 从 :1257） | 有漂移，符号名一致 |
| ToolCallEventResult（block/reason） | :1071-1075 | :1125-1128 | 一致（`{ block, reason }`） |
| ContextEventResult | — | :1119 | — |
| ToolResultEventResult | — | :1144 | — |
| InputEventResult | — | :880 | — |
| on 派发（同步屏障） | extensions/runner.ts:796-826 | runner.ts 派发散落于 :861/:897/:938/:991/:1014/:1045/:1080 等，**全部 `await handler(event, ctx)`** | 一致 |
| emitToolCall | runner.ts:979-1010 | :982-994（await handler，收集 ToolCallEventResult） | 一致 |
| AgentSessionEvent 定义 | agent-session.ts:139-183 | :144-185 | 一致 |
| subscribe 派发（不等） | agent-session.ts:548-552 | `_emit` :586-590：同步 for 循环 `l(event)`，**不 await、返回 void** | 一致 |
| subscribe 注册 | — | agent-session.ts:853 | — |
| AgentEvent（广播通道） | — | packages/agent/src/types.ts:431-446 | 只有生命周期(agent_start/end、turn_start/end、message_start/update/end) + tool_execution_start/update/end |

## 四、事件通道隔离结论（源码确认）

`AgentEvent`（agent/src/types.ts:431-446）只有生命周期 + 消息 + `tool_execution_*` 广播事件，**不含**：
- 决策点 5 件套：tool_call / tool_result / context / before_agent_start / input
- provider 类：before_provider_request / after_provider_response
- 会话类：session_start / session_shutdown / model_select

这些只在 `pi.on` 派发、subscribe 静默收不到。所以：
- 想**干预**（改行为）→ 用 `pi.on` + 返回有效结果
- 想**旁听**（记日志/审计）→ 用 `session.subscribe`，且不进主循环

## 五、验证清单（9 项全过）

- [x] `npm run 06b` 事件全景一次跑通，事件流与教程流程图完全一致
- [x] `npm run 06a` 跑两次：确认 block 演示依赖 LLM 行为（未传 limit 则不会触发）
- [x] 确定性 diag：强制 limit=9999 → `tool_call` 拦截 → block/reason 生效 → LLM 修正为 limit=100
- [x] 被拦截的调用不触发 tool_execution_start（拦截在工具执行之前）
- [x] ExtensionAPI.on 重载与 ToolCallEventResult{block,reason} 类型确认（types.ts:1252+/1125-1128）
- [x] 同步屏障确认：runner.ts 所有派发点都是 `await handler(event, ctx)`
- [x] fire-and-forget 确认：`_emit` 同步 for 循环、不 await、返回 void（agent-session.ts:586-590）
- [x] 决策点 5 事件不在 AgentEvent 广播通道（subscribe 收不到）——源码级隔离确认
- [x] 事件流里 text_delta 挂在 message_update 之下；user 消息也触发 message_start/end

## 六、收获与下一天预告

- 事件监听 = 在固定环节挂代码；先分清"我要干预还是旁听"，再选 `pi.on` 还是 `subscribe`
- 机制类验证优先写**确定性 diag**（教程演示依赖 LLM 行为，不稳定）
- 下一章：P07 准备上线——把 Agent 封装成 Express 服务（23,651 字节），然后进入 M01–M10 源码精读