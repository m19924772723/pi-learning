# Day 5 · 定义工具——给 Agent 一双能干的手（P05 实战）

- 日期：10-03
- 章节：《第5章-定义工具-从功能到交互pi都想到了.md》（28,669 字节）
- 实验代码：`L05-tools/05a-query-data.ts`（教程自带）
- 环境：pi 本地开发版 0.0.3（教程标注 v0.83，行号有漂移，以符号名为准）

---

## 一、章节核心要点

1. **工具系统 5 大设计点**：
   - execute 五参数：`toolCallId` / `params`（已被框架校验）/ `signal`（中止）/ `onUpdate`（流式进度）/ `ctx`（扩展上下文）
   - 参数自动校验：TypeBox schema 定义 `parameters`，LLM 传参非法时框架拦截并给 LLM 报错让其修正
   - 错误兜底：execute 抛异常 → 框架捕获、包装成错误结果、标记 isError → LLM 看到错误信息可自我纠正
   - 事件编排：`tool_execution_start → tool_execution_update → tool_execution_end` 三个事件贯穿工具生命周期
   - 工具管理：注册表 + 白名单（`setActiveToolsByName`）
2. **defineTool 三件套**：① 说明书（name/label/description/parameters）② 干活（execute）③ 注册（customTools 传入 createAgentSession）
3. **内置工具默认开 4 个**：read / bash / write / edit；**默认关 3 个**：grep / find / ls（要开用白名单）

## 二、运行记录（05a-query-data.ts 一次跑通）

提问 `华东地区一共多少销售额？`，Agent 行为：
- 订阅到 `tool_execution_start` → 工具名 `query_data`
- LLM 自行选择参数：`column="地区"`, `operator="="`, `value="华东"`（TypeBox 的 Literal 联合把 operator 限定在 6+1 种）
- 工具按条件过滤 sales.csv，命中 4 行明细
- Agent 汇总输出：**华东销售额合计 110,000 元**（4 条明细求和，无推理错误）

关键点：`params` 已经被框架校验过，execute 内部直接取用，无需自己防御 LLM 传错类型。

## 三、实测：execute 返回值没有 isError 字段（教程 §3.3 验证）

**教程观点**：execute 的返回值（AgentToolResult）**没有 isError 字段**；工具要报错必须 `throw`，框架捕获后自动置错。

**教程内部矛盾点**：教程自己复用的 `shared/lib/tools/query-data.ts:73-78` 却写了
`return { content: [...], isError: true }`——与正文说法冲突。

**实测方法**（临时脚本，跑完已删）：注册两个工具，让 LLM 依次调用，订阅 `tool_execution_end` 比对 isError：

| 工具 | 实现 | tool_execution_end.isError |
|---|---|---|
| soft_fail | `return { content, isError: true }`（过时写法） | **false（字段被静默忽略）** |
| hard_fail | `throw new Error("数据库连接失败：模拟崩溃")` | **true（框架捕获）** |

**结论**：教程正文正确，shared 工具是过时写法（错误不会真正标记，LLM 会拿到"看起来正常"的结果）。正确姿势：业务上可预期但应报错的场景用 `throw`；需要告知 LLM 但不想中断流程的文字放 content 里正常返回。**重要**：永远不要在返回值里写 isError——接口上没有这个字段，写了也不生效（实测铁证）。

## 四、源码对照表（本地开发版实际行号）

| 知识点 | 教程标注（v0.83） | 本地开发版（0.0.3） | 确认 |
|---|---|---|---|
| defineTool 定义 | extensions/types.ts:509-513 | `core/extensions/types.ts:511-515` | 一致 |
| ToolDefinition 接口 / label 必填 | :451 / :453 | :451 / :455 | 一致 |
| execute 五参数签名 | :480-486 | :482-488 | 一致（toolCallId, params, signal, onUpdate, ctx） |
| AgentToolResult 无 isError | agent/src/types.ts:355-369 | :362-376（字段：content/details/usage/addedToolNames/terminate） | 一致 |
| throw→isError 映射 | agent-loop.ts:675-703 / 756-760 | `executePreparedToolCall` :685-718（:707 硬编码 isError:false；:711-713 catch 置 true） | 一致 |
| 白名单 setActiveToolsByName | agent-session.ts:966 | :966-981（只启用注册表内工具、未知名忽略、重建系统提示词） | 一致 |
| 参数校验 | ai/src/utils/validation.ts:278-307 | :317 `validateToolArguments`（structuredClone→normalizeOptionalNulls→Value.Convert 类型转换→Check，失败 throw 带格式化路径错误） | 一致 |

**execute 五参数明细**（extensions/types.ts:482-488）：
1. `toolCallId: string` —— 本次工具调用的唯一 id（与 tool_execution_* 事件对应）
2. `params: Static<TParams>` —— 已校验/类型转换后的参数
3. `signal: AbortSignal | undefined` —— 会话中止信号（长任务要监听，中断时抛 AbortError）
4. `onUpdate: AgentToolUpdateCallback | undefined` —— 流式进度回调（partialResult）
5. `ctx: ExtensionContext` —— 扩展上下文

**错误链路**（agent-loop.ts）：`prepareToolCall`(:607) 校验参数失败即返回 immediate 错误（:668-674 catch）→ `executePreparedToolCall`(:677) 执行，throw 进 catch 转 `createErrorToolResult` + isError:true（:708-714）→ `finalizeExecutedToolCall`(:720) 供 afterToolCall 覆盖 → 最终 `tool_execution_end { isError }`。

## 五、验证清单（9 项全过）

- [x] `npm run 05a` 一次跑通，Agent 自动选参调用 query_data 并正确求和
- [x] TypeBox schema 生效：operator 被 Literal 联合限定，LLM 只能选合法运算符
- [x] defineTool 三件套结构完整（说明书/execute/注册）
- [x] AgentToolResult 接口无 isError 字段（类型层证据）
- [x] 实测 return isError:true → tool_execution_end.isError=false（字段被忽略）
- [x] 实测 throw → tool_execution_end.isError=true（框架捕获）
- [x] 白名单实现确认（setActiveToolsByName 只认注册表内工具）
- [x] 参数校验实现确认（validation.ts:317，带类型转换与格式化报错）
- [x] 教程矛盾点已澄清：shared/query-data.ts 的 return isError 是过时无效写法，示例 05a 的 throw 才是正解

## 六、收获与下一天预告

- 给 Agent 加能力 = 提供「带说明书的可执行函数」，框架负责校验/捕获/编排，省去大量胶水代码
- 工具报错的正确姿势：`throw`（异常）而不是 return 错误标记——这条实测验证过，写进笔记以免将来踩坑
- 下一天：P06 事件监听（最长的一章，52825 字节），把工具生命周期事件用于个性化定制