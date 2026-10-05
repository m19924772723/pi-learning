# Day 02 · P02 先看全貌 —— 成果报告

> 日期：2026-09-30（周三）
> 章节：《第2章-先看全貌-搞懂pi-agent工作机制.md》
> 目标：读懂 12 行最小示例的每一行，跑通「Express 调用 Agent」服务，对照源码建立 Session / Runtime / Tool 三层架构直觉

---

## 一、验收结果

| 验收标准 | 结果 |
|---|---|
| `npm run 02` 启动 Express 服务，`/ask` 接口正常应答 | ✅ 通过（见下方运行输出） |
| 能讲清 `createAgentSession` 内部做的五件事 | ✅ 通过（见第三节，已对照本地源码逐条核实） |
| 能讲清一次请求的完整链路 | ✅ 通过（见第四节事件流） |
| 能画出三层架构图并说清每层职责 | ✅ 通过（见第二节） |

---

## 二、三层核心抽象（第 2 章第三节）

```
┌──────────────────────────────────────────────────┐
│ Session（会话）                                   │
│   你和 Agent 的一次对话上下文                      │
│   API: prompt() / subscribe() / dispose()        │
└──────────────────────┬───────────────────────────┘
                       │ 依赖（创建时注入）
        ┌──────────────▼──────────────┐
        │ Runtime（运行时）            │
        │  启动时加载的四个基础设施：   │
        │   - ModelRuntime  管 LLM/Key │
        │   - ResourceLoader 加载资源  │
        │   - SessionManager 管持久化  │
        │   - SettingsManager 管配置   │
        └──────────────┬──────────────┘
                       │ ResourceLoader 加载的扩展，在这里运行
        ┌──────────────▼──────────────┐
        │ ExtensionRuntime（扩展运行时）│
        │   - pi.on(): 挂钩子          │
        │   - pi.registerTool(): 注册工具│
        └──────────────┬──────────────┘
                       │ 工具汇聚到 Agent
        ┌──────────────▼──────────────┐
        │ Tool（工具）                 │
        │   - 内置默认: read/bash/edit/write │
        │   - customTools: 直接传入    │
        │   - 扩展注册: pi.registerTool │
        └─────────────────────────────┘
```

**各层职责一句话**：

- **Session**：唯一直接操作的一层，只有三个方法——`prompt`（发消息）、`subscribe`（看过程）、`dispose`（收摊）。一次 Session = 一段独立对话，多轮记忆靠同一个 Session 持续；不同 Session 互不相干（Web 服务里一个用户配一个 Session）。
- **Runtime**：Session 背后的四个基础设施——ModelRuntime（用哪个 LLM/哪把 Key）、ResourceLoader（读系统提示词/扩展/skills/AGENTS.md）、SessionManager（对话持久化，默认落盘 `~/.pi/agent/sessions/<encoded-cwd>/`，Web 场景应换 `inMemory()` + 自己存）、SettingsManager（读 `settings.json`：默认模型/重试/压缩/thinking level）。
- **ExtensionRuntime**：扩展引擎，两个能力——`pi.on()` 挂钩子（第 6 章）、`pi.registerTool()` 注册工具（第 5 章）。
- **Tool**：Agent 调外部世界的桥梁，三个来源（内置默认 / customTools / 扩展注册）。**用哪个工具由 Agent 自己决定**（ReAct 循环），工具定义了 Agent 的能力边界。

**导航图（后面每章动哪层）**：第 3 章动 ModelRuntime，第 4 章动 ResourceLoader 的系统提示词，第 5、6 章都靠 ExtensionRuntime（一个注册工具、一个挂钩子），第 7 章把 subscribe 接到浏览器。

---

## 三、createAgentSession 内部五件事（源码对照）

第 2 章 2.4 节清单，已对照本地仓库 `D:\code\pi-agent`（开发版，行号与 v0.83.0 略有漂移，以符号名为准）：

```
createAgentSession() 内部（packages/coding-agent/src/core/sdk.ts:173 起）：
├── 1. 加载 ModelRuntime（读 auth.json / models.json，合并内置 Provider）   sdk.ts:180
├── 2. 初始化 SettingsManager（读 ~/.pi/agent/settings.json）               sdk.ts:182
├── 3. 初始化 SessionManager（默认落盘 ~/.pi/agent/sessions/<encoded-cwd>/） sdk.ts:183
├── 4. 加载 DefaultResourceLoader（发现 skills / extensions / AGENTS.md）   sdk.ts:185-189
└── 5. 创建 Agent 实例，默认启用四个内置工具 read/bash/edit/write          sdk.ts:306, sdk.ts:256
```

**对照结论**（教程附录 vs 本地源码实测）：

| 教程知识点 | 教程标注（v0.83.0） | 本地实测（开发版） |
|---|---|---|
| `createAgentSession` 入口 | `sdk.ts:170-390` | `sdk.ts:173` |
| 返回结构 | `sdk.ts:88-95,393-397` | `sdk.ts:90-98,405-409`：`{ session, extensionsResult, modelFallbackMessage }` |
| 默认激活工具 | `sdk.ts:245` | `sdk.ts:256`：`["read","bash","edit","write"]`（grep/find/ls 内置但不默认激活） |
| `ModelRuntime` 类 | `model-runtime.ts:135-173` | `model-runtime.ts:130`，`create()` 在 `:172`，`getAvailable()` 在 `:404` |
| `AgentSession` 类 | `agent-session.ts` | `agent-session.ts:306`；`subscribe()` `:853`；`dispose()` `:877`；`prompt()` `:1175` |

第 5 件事的关键源码：`new Agent({ initialState: { systemPrompt: "", model, thinkingLevel, tools: [] }, streamFn, ... })`——`streamFn` 最终调到 `modelRuntime.streamSimple(model, context, options)`（`sdk.ts:324`），并叠加重试/超时/扩展头钩子。`Agent.prompt` 在 `packages/agent/src/agent.ts:350` 实现 ReAct 循环。

---

## 四、一次请求完整链路（Express 版实测）

`npm run 02`（`code/L02-arch/03-express-ask.ts`）启动的服务，一次 `POST /ask` 的链路：

```
POST http://localhost:3000/ask  { question: "..." }
  → 校验 question 参数（缺了返回 400）
  → createAgentSession({ model, modelRuntime })  新建 session（演示用，生产不能这样）
  → session.subscribe(回调)                       注册事件监听（不阻塞）
  → session.prompt(question)                      阻塞：触发 ReAct 循环
       Agent 思考 → 决定调 bash 工具 → 工具返回 → 再思考 → 生成文字
       （过程中订阅回调收到事件，只挑 message_update/text_delta 拼 answer）
  → res.json({ answer })                          返回完整回答
  → finally: session.dispose()                    释放资源（即使 prompt 抛异常也执行）
```

**事件层实测**（第 2 章「自己动手」实验，第 1 章已观测到同样序列）：`agent_start → turn_start → message_start → message_update(text_delta…) → message_end → turn_end → agent_end → agent_settled`；调用工具时会插入 `tool_execution_start → tool_execution_end`。

**三个容易混淆的点**（教程重点强调）：
1. `subscribe` 只是注册回调、**不阻塞**；真正执行在 `prompt()` 里。
2. `prompt()` 是**阻塞**的——内部跑完 ReAct 循环才 resolve。
3. `dispose()` 不能省：中止后台任务（重试/压缩/bash）、注销监听、失效扩展上下文；用 `try/finally` 保证异常也能清理。

---

## 五、运行成果（实测输出）

本机 provider 是 `siyu`，而 L02 教程代码写死了 `find(m => m.provider === "zhipu")`，直接跑会 throw「没有可用模型」。已改为：先找 `zhipu`，找不到就**落回第一个可用模型**（`all.find(...) ?? all[0]`），保留教程语义、兼容本机配置。

```powershell
> npm run 02
✅ Agent 服务启动：http://localhost:3000/ask   # 端口 3000 监听

> POST /ask  {"question":"一句话介绍你是谁，并列出当前项目里能看到哪些目录"}
STATUS: OK
ANSWER: 我是 pi，一个能读写文件、执行命令的编程助手。
当前项目（D:/code/dg-ai-notes/pi-agent/pi_sdk_learn/code）里能看到以下目录：
- L01-env / L02-arch / L03-model / L04-prompt / L05-tools / L06-extensions / L07-streaming
- node_modules / prompts / shared
另外还有 README.md、package.json、package-lock.json 等文件。
```

**验收点**：Agent 答出了项目目录结构——说明这次问答真的走了「LLM 思考 → 调 bash 工具（ls/读目录）→ 基于工具结果回答」的 ReAct 链路，而不只是模型瞎猜。Express 层（请求/响应、400 校验、JSON 应答、try/finally 清理）全部工作正常。

> 服务进程测试后已停掉（端口 3000 无残留监听，无遗留 node 进程）。

---

## 六、问题排查记录

### 问题：L02 教程代码硬编码 `provider === "zhipu"`，本机是 `siyu`

**现象**：`ModelRuntime.getAvailable()` 返回的模型 provider 全是 `siyu`，`.find(m => m.provider === "zhipu")` 找不到 → `throw new Error("没有可用模型")`，服务起不来。

**解决**：教程代码意图是「演示怎么从可用模型列表里挑一个」，具体挑哪个是本机差异。改为 `all.find(m => m.provider === "zhipu") ?? all[0]`——有 zhipu 环境照旧选 zhipu，没有就落回第一个可用模型（本机为 `siyu/deepseek-v4-flash`）。

**经验**：教程演示代码常写死作者本机环境；跑课前先读一遍，把「环境相关的硬编码」和「SDK 机制本身」分开，前者按本机配置微调即可。

### 问题：Express 服务后台启动后进程被连带杀掉

**现象**：`Start-Process` 起服务后再单独发命令测试，发现端口没监听、进程消失。

**原因**：工具调用结束时会清理本次调用派生的子进程树。

**解决**：把「启动服务 → 等待监听 → POST 测试 → 停掉服务」放进**同一条命令**里一次完成（本机实测：监听 2s 内就绪）。

---

## 七、本章知识点小结

1. **12 行最小示例拆解**：`ModelRuntime.create()` 加载配置 → `getAvailable()` 选模型 → `createAgentSession({model, modelRuntime})` 建会话 → `subscribe` 注册监听 → `prompt` 发问 → `dispose` 收摊。每行职责清晰。
2. **三层抽象**：Session（三方法）/ Runtime（四件套）/ ExtensionRuntime（on + registerTool）/ Tool（Agent 的能力边界）。
3. **五件事顺序**：modelRuntime → settingsManager → sessionManager → resourceLoader → Agent（默认 4 工具），与源码逐条对应。
4. **ReAct 循环**：思考 → 行动（调工具）→ 观察 → 再思考；`prompt()` 阻塞跑完整循环，事件全部推给 subscribe。
5. **Web 化要点**：每个请求新建 session 是演示用的反面教材；正确做法是「一个用户复用同一个 session」；持久化默认落盘是 CLI 设定，Web 要 `SessionManager.inMemory()` + 自己存数据库。
6. **事件驱动**：Agent 每一步都发事件；做 Web 服务时用 `subscribe` 流式转发（第 7 章 SSE 主场）。

---

## 八、遗留与下一步

- [ ] 第 3 章预告：动手配模型（动 ModelRuntime 层）——本机 `siyu` provider 与教程的 zhipu/anthropic 不同，运行时注意模型名映射
- [ ] 后续运行命令仍在 `pi_sdk_learn/code/` 下执行；L02 已改动（zhipu 落回 all[0]），若以后教程更新记得比对
- [ ] 第 4 章将动 ResourceLoader 的系统提示词——注意本机开发版与 v0.83.0 的 API 差异（如个别选项字段名）
