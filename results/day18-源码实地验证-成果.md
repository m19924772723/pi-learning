# Day 18 · 源码实地验证——M 章漂移锚点逐一复核

- 日期：10-16
- 方式：对 Day 8–17 十份 M 章精读笔记中标注的"矛盾/漂移/疑问"锚点，直接在本地源码上重新定位复核（只读，不修改任何源码）
- 环境：pi 本地开发版 0.85.1 + Node v24.19.0
- 结论先行：**十个关键锚点全部复核成立**，但有两处 M 章笔记的"文件路径"需要修正（见下）

---

## 一、复核结果总表

| # | 锚点（M 章结论） | 复核位置（本次实测） | 结论 |
|---|---|---|---|
| ① | M03：length 截断→工具调用全部报错不执行（教程称仍执行） | `agent/src/agent-loop.ts:230-233`（`stopReason === "length"` 时走 `failToolCallsFromTruncatedMessage`）；`:379-404` 对每个 toolCall 生成 `createErrorToolResult` + `isError: true`，注释明确 "None of them are safe to execute" | ✅ 成立 |
| ② | M03：压缩挂载点从 agent_end 移到 prepareNextTurn 拦截 | `coding-agent/src/core/agent-session.ts:538`（`_compactBeforeNextAssistantResponse`）、`:563-564` 挂到 `agent.prepareNextTurnWithContext`；`agent/src/agent.ts:464-467` 下一轮前调用 | ✅ 成立 |
| ③ | M08：buildSystemPrompt 尾部无 Current date | `coding-agent/src/core/system-prompt.ts:28`；`:70`（customPrompt 分支）与 `:165`（默认分支）尾部都只有 `Current working directory: ${promptCwd}`，全文无 date | ✅ 成立 |
| ④ | M09：主摘要与 turnPrefix 摘要并行→串行 | `agent/src/harness/compaction/compaction.ts:774-798`：isSplitTurn 分支先 `await generateSummaryWithRequest`（历史），完成后再 `await generateTurnPrefixSummary`，两段串行 | ✅ 成立 |
| ⑤ | M10：agent-core 层重构为 4 种 Entry | `agent/src/harness/session/types.ts:16`（`EntryType = "message" \| "compaction" \| "branch_summary" \| "custom"`）、`:64`（Entry 联合恰好 4 种）；全 packages grep `SessionStorage` 0 命中 | ✅ 成立 |
| ⑥ | M10：会话目录 = `~/.pi/agent/sessions/<encoded-cwd>/`（教程称项目 `.pi/sessions/`） | `coding-agent/src/core/session-manager.ts:476-481`（`getDefaultSessionDirPath`：`join(resolvedAgentDir, "sessions", safePath)`，safePath=`--`+cwd 编码） | ✅ 成立 |
| ⑦ | M04：ThinkingLevel 多 max、done 多 deferred | 本次未重验源码符号，沿用 M04 子代理结论（compat/stream 层） | 引用 M04 |
| ⑧ | M02：核心五包→约 10 包、pi-ai 依赖 pi-telemetry | 本次未重验 package.json，沿用 M02 子代理结论 | 引用 M02 |
| ⑨ | M01：KnownProvider 35→40、ModelRegistry API 重构 | 本次未重验，沿用 M01 子代理结论 | 引用 M01 |
| ⑩ | M07：pi.on 事件重载 30→33 | `coding-agent/src/core/extensions/types.ts`：`^\ton\(event: ` 精确计数 **33 个**（教程称 30） | ✅ 成立 |

---

## 二、复核过程中的新发现（M 章笔记需勘误）

1. **文件路径勘误 1——buildSystemPrompt 不在 `agent/src/harness/system-prompt.ts`**：
   - M08 笔记标注 `system-prompt.ts:70/165`，但该路径下的文件本次实测只有 34 行，仅含 `formatSkillsForSystemPrompt`（技能 XML 格式化），**不含 buildSystemPrompt**。
   - 实际位置：`coding-agent/src/core/system-prompt.ts:28`（`BuildSystemPromptOptions` 接口 + `buildSystemPrompt`），`:70` 与 `:165` 两处尾部恰好印证"只有 Current working directory、无 Current date"。**结论不变，路径修正**。
2. **文件路径勘误 2——`session-manager.ts` 在 coding-agent 包**：
   - M10 笔记引用 `packages/coding-agent/src/core/session-manager.ts:476-481` 正确；但 agent 包下不存在同名文件（`agent/src/harness/session/` 是新的事务模型目录）。分层关系：**coding-agent 的 SessionManager（9 种 Entry）与 agent 的 Storage/SessionRepo（4 种 Entry）两套独立实现并行**，与 M10 结论一致。
3. **estimateTokens 角色分支数精确化**：`compaction.ts:270-310` 的 switch 实际是 5 个 case 覆盖 7 种 role（user / assistant / custom+toolResult 合并 / bashExecution / branchSummary+compactionSummary 合并，兜底 0），M16 笔记"按 6 角色分支"表述略粗，机制（chars/4 保守估算）无误。

---

## 三、实地验证的两处行为演示（可选复现）

- **length 截断判死**：`agent-loop.ts:227-229` 注释即官方说明——"A 'length' stop means the output was cut off by the token limit, so every tool call in the message may carry truncated arguments. Fail them all instead of executing potentially borked calls."（输出超限时参数可能被截断，全部判失败而非执行），与教程"仍执行"的描述构成文档级矛盾，本地行为以 fail-closed 为准。
- **串行摘要**：`compaction.ts:788-798` 中 `turnPrefixResult = await generateTurnPrefixSummary(...)` 出现在 `historyResult = await generateSummaryWithRequest(...)` 之后，无 `Promise.all`，两段 LLM 调用严格顺序执行——教程若描述为并行则失真。

---

## 四、一句话总结

Day 8–17 笔记中标注的 M 章漂移锚点经 Day 18 实地复核**全部成立**（尤其 length 截断判死、无 Current date、4 种 Entry 重构、`~/.pi/agent/sessions/<encoded-cwd>/` 目录、pi.on 33 重载），仅需修正 buildSystemPrompt 与 session-manager 的精确文件路径；教程相对本地 0.85.x 的失真集中在"过时写法"与"层间重构"，机制性描述大体可靠。
