# Day 10 · M03 Agent Loop——让模型转动起来的引擎（源码精读）

- 日期：10-08
- 章节：《第3章-Agent-Loop-让模型转动起来的引擎.md》（49,076 字节，912 行）
- 精读方式：explorer 子代理全文精读 + 本地源码逐条对照（只读；agent-loop.ts 803 行全文对照）
- 环境：pi 本地开发版 **0.85.1**（教程标注 v0.83）+ Node v24.19.0

---

## 一、章节核心要点（问题→机制）

1. **为什么需要循环**：LLM 是无状态 token 预测器，一次调用无法完成"读文件→改代码→验证"多步任务；Agent Loop 把步骤流转决策权交给模型输出内容。
2. **Trace 与 Turn 分层**：一 Trace = agent_start→agent_end 全程；一 Turn = 一次模型调用 + 该次触发的一批工具执行，由 turn_start/turn_end 包裹，首轮 turn_start 由入口发出。
3. **stopReason 双来源**：模型 API 返回 `toolUse/stop/length` 三种；`error/aborted` 两种是流式层 catch 块注入的兜底。
4. **循环信号是工具调用而非 stopReason**：`hasMoreToolCalls = toolCalls.length>0 && !executedToolBatch.terminate`；停止规则是人类约定——"输出里没有工具调用就当任务完成"。
5. **终止的保守策略**：terminate 用 `every` 非 `some`（全部工具结果都 terminate 才停）；并行批次任一工具声明 sequential 则整批串行（一票否决）；顺序执行三阶段——准备 + Promise.all 执行 + 按调用顺序返回结果。
6. **流式原地替换**：start 推空壳消息，delta 逐段覆盖 `context.messages[last]`，done 用最终消息替换——UI 实时渲染且消息数不变。
7. **内核 + 叠加架构**：内核是十几行的 while 循环；coding-agent 叠加 steering（紧急插队）、followUp（外层续命）、prepareNextTurn（换模型/压缩）、shouldStopAfterTurn（安全阀）。
8. **两层消息边界**：Agent 内部消息含 bashExecution/compactionSummary 自定义角色，LLM 只认 user/assistant/toolResult，`convertToLlm` 站在边界翻译。

## 二、源码对照表

| 知识点 | 教程标注（v0.83） | 本地实测（0.85.1） | 一致 |
|---|---|---|---|
| runAgentLoop 入口签名 | agent-loop.ts:95-118 | packages/agent/src/agent-loop.ts:96-103 | 是 |
| steering 首次检查 | :167 | agent-loop.ts:168（外层循环前） | 是 |
| 内层循环条件 | while(hasMoreToolCalls\|pendingMessages) | agent-loop.ts:175 | 是 |
| 首轮 turn_start 跳过 | firstTurn 标志 :175-179 | 无 firstTurn，改 `lastCompletedTurn` :166,176-197 | 否（行为等价） |
| error/aborted 硬停止 | :196-200 | agent-loop.ts:215-219 | 是 |
| toolCalls 过滤 + terminate | :202-216 | agent-loop.ts:222-241 | 是 |
| length+toolCall 仍执行工具 | §三明示"仍会执行" | length 时**失败全部** toolCall :230-233,379-404 | **否** |
| 串/并行"一票否决" | §4.6 | agent-loop.ts:417-423 | 是 |
| terminate every 非 some | §4.6 | shouldTerminateToolBatch :589-591 | 是 |
| 流式原地替换 | :313-357 | agent-loop.ts:315-359（事件颗粒更细 + addedPartial 边界） | 是 |
| followUp 续命 | :253 区域 | agent-loop.ts:261-266 | 是 |
| defaultConvertToLlm = .filter | §4.4 阶段B | packages/agent/src/agent.ts:33-37 | 是 |
| cache_control 三位置 | anthropic-messages L922/1157/1208 | packages/ai/src/api/anthropic-messages.ts:1071/1078/1087（系统）、1374-1396（末条 user）、1459（末 tool） | 是（行号漂移） |
| OpenAI prompt_cache_key | openai-completions.ts:554 | packages/ai/src/api/openai-completions.ts:810；applyAnthropicCacheControl:1074 | 是 |
| createContextSnapshot | agent.ts:414-420 | agent.ts:437-443 | 是 |
| PendingMessageQueue/drain | agent.ts:118-152 | agent.ts:125-159（drain :141-154） | 是 |
| stopReason="aborted"/"error" 注入 | streamSimple catch | openai-responses.ts:201、openai-completions.ts:708、mistral-conversations.ts:168、openrouter-images.ts:111 | 是 |

## 三、验证的关键结论

1. **循环只由"工具调用 + terminate"驱动**而非 stopReason：agent-loop.ts:222-241 中 `toolCalls.length>0` 时 `hasMoreToolCalls = !executedToolBatch.terminate`（:235）；error/aborted 在 :215-219 先一步硬退出。"有 toolCall 就转、没有就准备停"成立。
2. **terminate 是 every 非 some**：agent-loop.ts:589-591 `finalizedCalls.length > 0 && finalizedCalls.every(f => f.result.terminate === true)`，比教程还多 length>0 守卫。
3. **流式"空壳→原地替换"存在**：agent-loop.ts:319 start 推空壳、:335 各 delta 覆盖 `context.messages[last]`、:348 done 换最终消息；配合 :317-357 的 message_start/message_update/message_end，UI 实时渲染有据。
4. **并行工具执行 = 顺序准备 + 并行执行 + 有序产出**：agent-loop.ts:497-545 顺序 await prepareToolCall（含验证/beforeToolCall），:547-549 Promise.all 执行，:551-555 按序 createToolResultMessage；beforeToolCall 的 block/terminate 在 :643-653。
5. **error/aborted 是流式层注入而非模型返回**：多个 provider 文件均有 `output.stopReason = options?.signal?.aborted ? "aborted" : "error"`（openai-completions.ts:708、mistral-conversations.ts:168 等）。

## 四、矛盾 / 漂移 / 疑问

- ① **最重要分歧——length 截断行为**：教程断言"stopReason===length 时只要有 toolCall 仍会执行工具"；本地 :230-233 改为 `failToolCallsFromTruncatedMessage`（:379-404），截断消息的 toolCall 全部**报错不执行**（防参数被截断），返回 terminate:false 让循环继续、模型重新发起。本地版本更安全，教程结论在此不成立。
- ② **firstTurn 标志已重构**：v0.83 用 firstTurn 跳过首圈 turn_start；本地改用 `lastCompletedTurn`（:166,176-197）——prepareNextTurn 被挪到下一圈开头（:177）而非 turn_end 之后，steering 在 :194-196 还有加条件补轮询。行为等价、实现差异明显。
- ③ **shouldStopAfterTurn 本地未接线**：全 coding-agent/src grep 0 匹配；"上下文快满"检查已改为 `prepareNextTurnWithContext`（agent-session.ts:557-578）→ `_compactBeforeNextAssistantResponse`（agent-session.ts:538-555，shouldCompact/estimateContextTokens 判定后自动压缩）。教程"用 shouldStopAfterTurn 当安全阀"与本地不符。
- ④ **convertToLlm "默认 filter"仅是 packages/agent 默认值**（agent.ts:33-37）；coding-agent 实际注入 `core/messages.ts:148` 的 switch 翻译版（bashExecution/custom/branchSummary/compactionSummary 转 user），教程未提。
- ⑤ 本地新增：`runAgentLoopContinue`（:121 重试路径）、addedPartial 无 start 事件的边界（:347-351）、reasoning/thinkingLevel 覆盖（:183-188）。另：教程称 stopReason 注入在"streamSimple 内"，实际分散在各 provider 的 flow 处理层。

## 五、一句话总结

教程对 v0.83 的机制刻画（Trace/Turn 嵌套、工具调用驱动循环、内核+叠加、流式原地替换、cache_control 三位置）在本地 0.85.1 全部有对应实现且结论基本成立；三处已演进：length 截断工具改判失败（更安全）、firstTurn 改 lastCompletedTurn、压缩从 shouldStopAfterTurn 迁移到 prepareNextTurn。
