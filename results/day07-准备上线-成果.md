# Day 7 · 准备上线——把 Agent 封装成服务（P07 实战）

- 日期：10-05
- 章节：《第7章-准备上线-把Agent封装成服务.md》（23,651 字节）
- 实验代码：`L07-streaming/07a-sse-server.ts`（SSE 单接口服务端）+ `public/index.html`（前端）
- 环境：pi 本地开发版 0.0.3（教程标注 v0.83）+ Node v24.19.0

---

## 一、章节核心要点

1. **四种接入方式**：

| 接入方式 | 用法 | 说明 | 跨语言 |
|---|---|---|---|
| 交互模式（TUI） | `pi` | 终端交互，前几章界面 | — |
| 打印模式 | `pi -p "问题"` | 一次性问答，适合脚本/管道 | ✅ |
| RPC 模式 | `pi --mode rpc` | 无头模式，stdin 读 JSON 命令、stdout 出 JSON 事件；官方为"让其他程序驱动 pi"提供 | ✅ |
| 进程内嵌 SDK | `import { createAgentSession }` | 自己的 Node 进程完全控制，本章采用 | ❌ |

2. **Web 集成三步**：① 组装 DataAgent 拿到 `session` → ② `POST /chat` 接口用 session 三能力（`subscribe` 收事件、`prompt` 发消息、`abort` 打断）→ ③ 前端 POST + 读响应流。
3. **SSE = 一个「不关闭」的 HTTP 响应**：发完头后连接挂着，服务器随时可再 write 一段；Agent 逐字回答正好一段段推。判断标准：只需"服务器→客户端"单向推用 SSE，双向互推才用 WebSocket。
4. **事件翻译表**（前端要展示什么 ↔ subscribe 里对应什么）：逐字回答 `message_update.assistantMessageEvent`（`text_delta`/`thinking_delta`，内容在 `.delta`）；工具卡片 `tool_execution_start/end`（`toolCallId` 配对，`result.content[0].text`、`isError`）；结束 `prompt()` 的 finally（比 `agent_end` 可靠——它每轮重试都发且带 `willRetry`）。
5. **本次 demo 数据校验**：华东地区销售额合计 **110,000 元**（4 条明细），与 Day 5 一致。

## 二、运行记录与发现：教程 07a 原版在 Node 18+ 的坑

### 现象
启动 `npm run 07`（教程原版 07a-sse-server.ts）后，用文件传 body 调 `POST /chat`，**整个 SSE 流只有 `done` 一个事件**（无 text/thinking/tool_start/tool_end）。HTTP 200、content-type 正确、服务端无报错。多次复现一致。

### 排查（确定性方法）
- 写临时 diag（同样组装逻辑直接 `session.subscribe` + prompt）：**380 个事件全部收到**，text/tool 均有 → 事件链路本身正常，问题在服务端代码。
- 写 clone 服务器（与 07a 相同组装，唯一差别：**去掉 `req.on("close")` 处理**）：完整收到 **283 个 SSE 帧**（thinking=116、text=164、tool_start=1、tool_end=1、done=1）→ 定位到 `req.on("close")` + `session.abort()`。
- 极简 http 服务实测触发时机：POST body 读完 → **`req 'close'` 立即触发** → 之后才写后续响应。

### 根因
Node 18+ 变更了 `IncomingMessage` 的事件语义：**`req.on("close")` 在请求体被完整接收后即触发**，不再是"底层连接关闭"才触发。教程 07a 的：

```js
req.on("close", () => { off(); if (!settled) session.abort(); });
```

因此在 curl/fetch 发完 body（express.json() 消费完）的瞬间就执行：`off()` 取消订阅 + `session.abort()` 打断 Agent → prompt 被中止，无事件到达前端，finally 只发 `done`。教程按旧版 Node 语义写，行为在 Node 18+ 下失效。

### 修复姿势（报告分析，不改教程文件）
监听**响应侧**的关闭：`res.on("close")`——它在连接真正断开（客户端取消/超时）时才触发，语义正确：

```js
res.on("close", () => { off(); if (!settled) session.abort(); });
```

Day 2 的 03-express-ask.ts 之所以正常，正是因为它没有 `req.on("close")` 处理。

## 三、验证清单（本次实测）

- [x] `npm run 07` 服务启动正常（模型 deepseek-v4-flash、端口 3000）
- [x] 教程原版端到端：只收到 `done`（复现 bug）
- [x] 事件链路独立验证：380 事件全收到（text/tool/thinking 齐全）——机制本身正常
- [x] clone（去 close 处理）端到端：283 帧完整流，text=164/thinking=116/tool_start=1/tool_end=1/done=1
- [x] close 时机实测：Node 24 下 `req 'close'` 在 body 读完即触发（乱序日志确认在写 second 之前）
- [x] SSE 格式验证：`data: {"type":...}\n\n`、text/thinking 逐字、toolCallId 配对
- [x] translateEvent 翻译逻辑验证：message_update 的 thinking_delta/text_delta、tool_execution_start/end 全翻译正确
- [x] 工具端到端：Agent 自动调 query_data（contains 华东，limit=50）→ 4 行 → 合计 110,000 元

## 四、收获与下一步

- Web 集成核心 = `session.subscribe` + `prompt` + `abort`；"前端要展示什么，subscribe 事件里都能找到"是选型地图
- Node 版本升级会改变事件语义（此处是正向改变但教程代码未跟进）——报错先怀疑"教程按旧版本写、运行时按新版本行为"
- 下一阶段：M01–M10 源码精读（10 章，逐章对照本地源码验证重点结论），Day 18 实地验证、Day 19 综合实战（DataAgent：SQL 工具 + 危险 SQL 拦截 + 事件日志，会把 Day 7 的 SSE 服务一并做进去）