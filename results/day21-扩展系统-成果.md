# Day 21 · 进阶方向①扩展系统——不改源码给 Agent 加能力

- 日期：10-06（实际，进阶第一天）
- 任务：精读 `_chapter-design/第11章-扩展系统-设计文档.md`（TS 版），对照本地 pi 源码验证设计文档引用的关键路径
- 结论先行：**扩展系统不是"魔法注入"，而是 Pi 在工作流关键点 emit 事件，用"约定（事件名 + 返回值协议）"换"灵活（不改源码）"**。三大设计（事件总线 / 两阶段绑定 / 错误隔离+API 门面）在源码里全部落实；设计文档的 9 处锚点行号有漂移，机制全部成立

---

## 一、设计文档精读：三大设计

### 1. 事件总线是核心机制（用约定换灵活）

Pi 不知道你的团队要禁 `rm -rf`，它只负责在**工作流关键点 emit 事件**（"嘿，我要执行工具了，要不要拦？"），扩展写处理器回答"要拦"。

设计文档给出 **4 种事件模式**，决定扩展能以什么方式介入：

| 模式 | 代表事件 | 返回值协议 | 效果 |
|---|---|---|---|
| 通知型（fire-and-forget） | `agent_start` / `turn_end` | 无 | 观察，不影响流程 |
| 取消型（一票否决） | `session_before_switch` 等 | `{cancel: true}` | 任一扩展取消即中止该操作 |
| 修改型（链式传递） | `context` / `tool_result` / `message_end` | 返回新值 | 前一个扩展的输出是后一个的输入 |
| 短路型 | `tool_call` / `user_bash` | `{block: true, reason}` | 立即阻止并返回，不再问后续扩展 |

### 2. 两阶段绑定解决"工厂函数时机矛盾"

扩展的工厂函数在 **Pi 启动加载阶段**执行——那时 Agent 不存在、SessionManager 还没创建。如果这时调 `pi.sendMessage()`，消息发给谁？

Pi 的解法：**throwing stubs + bindCore**。
- 注册阶段（工厂函数执行时）：`pi` 对象上的操作型方法是 throwing stubs，调用即抛错（合理，因为此时调用无意义）
- Agent 启动后：`bindCore()` 把所有 stub 替换为真实实现
- 扩展代码对阶段差异**无感知**——在工厂函数里调会抛错，在事件处理器里调就是真实操作

### 3. 错误隔离 + API 门面（第三方代码不能全信）

- **错误隔离**：所有事件处理器被 try/catch 包裹，扩展崩了只丢弃自己的修改，不影响核心，错误被编码成 `extension_error` 事件
- **API 门面三层**：`ExtensionContext` 只读查询 → `ExtensionCommandContext` 命令特权（newSession/fork/switchSession/reload）→ `ReplacedSessionContext` 会话切换后可写。普通事件处理器拿不到 `forkSession` 这种危险方法（最小权限）

## 二、源码验证（锚点复核，Day 18 方法）

设计文档 9 处引用路径逐一核对（本地 `D:\code\pi-agent`，2026-10-06 快照）：

| # | 设计文档引用 | 实际位置 | 结论 |
|---|---|---|---|
| 1 | `extensions/types.ts:993-1023` 28 个事件类型 | `packages/coding-agent/src/core/extensions/types.ts:1086-1113`（`ExtensionEvent` 联合） | ✅ 机制成立，行号漂移 +93；顶层联合 27 个成员（10 个 `session_*` 子事件并入 `SessionEvent`） |
| 2 | `extensions/runner.ts:736-768` emit（try/catch） | `runner.ts:851-883` | ✅ 漂移 +115；handler 逐个 try/catch，出错走 `emitError` 不中断循环 |
| 3 | `extensions/runner.ts:862-883` tool_call 拦截 | `runner.ts:982-1003` | ✅ 漂移 +120；返回 `{block, reason}` 立即 return（短路） |
| 4 | `extensions/runner.ts:812-860` tool_result 链式 | `runner.ts:927-980` | ✅ 漂移 +115；content/details/isError/usage 逐项覆盖，未修改返回 undefined |
| 5 | `extensions/loader.ts:160-195` throwing stubs | `loader.ts:177-180` | ✅ 基本吻合；`notInitialized = () => { throw new Error("Extension runtime not initialized...") }` |
| 6 | `extensions/runner.ts:307-378` bindCore | `runner.ts:317-409` | ✅ 吻合；把 actions 写入 runtime，并冲刷加载期排队的 provider 注册 |
| 7 | `extensions/runner.ts:573-633` createContext 只读门面 | `runner.ts:723-801` | ✅ 漂移 +150；全部字段用惰性 getter + `assertActive()` 守卫 |
| 8 | `extensions/types.ts:298-327` ExtensionContext | `types.ts:309-349` | ✅ 吻合；`sessionManager` 类型是 `ReadonlySessionManager`（只读） |
| 9 | `examples/extensions/confirm-destructive.ts` | `packages/coding-agent/examples/extensions/confirm-destructive.ts` | ✅ 存在；演示 `session_before_switch/fork` 返回 `{cancel: true}` 一票否决 |

**附加验证（设计文档之外）：**

- `ExtensionAPI` 入口：`types.ts:1252-1382`——`on()` 覆盖 26 种事件 + `registerTool` / `registerCommand` / `registerShortcut` / `registerFlag` / `registerMessageRenderer` / `sendMessage` / `sendUserMessage` / `appendEntry`
- 目录约定三条规则（`loader.ts:669-756`）：
  1. 直接文件：`extensions/*.ts` / `*.js` → 加载
  2. 子目录：`extensions/<dir>/index.ts` 或 `index.js` → 加载
  3. 子目录：`package.json` 带 `pi.extensions` 字段 → 加载声明的路径
  - 不递归超过一层；复杂扩展包必须用 package.json manifest
- 加载位置（`loader.ts:782-788`）：① `cwd/.pi/extensions/`（项目局部）② `agentDir/extensions/`（全局，`~/.pi/agent/extensions`）
- Jiti 加载（`loader.ts:501-513`）：TS 源码运行时用 `tsconfigPaths` + `virtualModules`；编译二进制用 `virtualModules`；非 bundle Node 用 alias——**改了扩展文件重启即生效，不用 build**
- 工具包装（`wrapper.ts:17-37`）：`wrapRegisteredTool` 把扩展注册的工具包装成 AgentTool，统一注入 `runner.createContext()`，工具与事件处理器共享同一套惰性守卫上下文

## 三、与 Day 19 的衔接：从"手动注册"到"目录自动发现"

Day 19 的 DataAgent 其实已经用了扩展系统的 API——`sql-guard.ts` 的 `dataAgentExtension(pi: ExtensionAPI)` 就是一个标准的**扩展工厂函数**，用 `pi.on("tool_call")` 拦截危险 SQL：

```ts
// Day 19（手动注册）                      // Day 21（目录自动发现）
dataAgentExtension(pi)                    // 文件放 .pi/extensions/
                                          // pi 启动时 loader 自动发现并调用 factory
```

差异只在**接入方式**：Day 19 在程序里手动调工厂函数；Day 21 理解到 Pi 会在启动时自动发现 `extensions/` 目录下的 `.ts` 文件并执行工厂函数——同样的代码，换个位置就从"库函数"变成"插件"。这也解释了 Day 19 拦截为何是 `pi.on("tool_call")` 而非 `session.subscribe`：前者是扩展层事件总线（启动时绑定），后者是会话层订阅（会话运行时）。

## 四、一图总结扩展系统

```
┌────────────────────────────────────────────────────────┐
│  扩展生命周期（loader.ts + runner.ts）                    │
│                                                        │
│  启动加载阶段                 Agent 运行阶段             │
│  ┌──────────────┐   bindCore   ┌────────────────────┐  │
│  │ factory(pi)   │ ──────────→ │ 真实 actions 生效    │  │
│  │ pi.* = stubs  │   (runner   │ 事件处理器可调操作型  │  │
│  │ 调用即抛错     │    :317)    │ 方法（sendMessage…） │  │
│  └──────────────┘             └────────────────────┘  │
│                                                        │
│  事件总线（runner.emit :851）                           │
│  8 类介入点 × 4 模式：通知 / 取消 / 修改链 / 短路        │
│  每个 handler try/catch（错误隔离，不拖垮核心）           │
│                                                        │
│  API 门面三层：ExtensionContext(只读)                  │
│  → ExtensionCommandContext(命令特权)                   │
│  → ReplacedSessionContext(切换后可写)                   │
└────────────────────────────────────────────────────────┘
```

## 五、一句话总结

扩展系统把"改核心"变成"写约定"：**Pi 稳定地 emit 事件，扩展自由地消费事件**；两阶段绑定解决了"加载早、运行晚"的时机矛盾，try/catch + 三层门面让第三方代码进得来、翻不了天。Day 19 的 DataAgent 已是这个机制的第一个实践，下一步可把 Day 19 扩展升级为"目录自动发现的扩展包"（进阶方向 ① 的落地）。
