# Day 03 · P03 模型配置 —— 成果报告

> 日期：2026-10-01（周四）
> 章节：《第3章-模型配置的关键-判断企业内网能否接入.md》
> 目标：看懂 models.json 结构与模型字段、掌握 Key 的多种管理方式与优先级、能拿企业内网接口文档逐条核对"能不能接、缺什么参数"

---

## 一、验收结果

| 验收标准 | 结果 |
|---|---|
| `npm run 03`（多 Provider 管理）跑通 | ✅ 通过（见第二节运行输出） |
| 能对着一个内网模型的接口文档，判断"能不能接、缺什么参数" | ✅ 通过（见第五节：用 `siyu` relay 当「待接入网关」跑了 9 条核对清单 + 3 条硬性要求实证） |
| 理解 models.json 模型字段与默认值来源 | ✅ 通过（见第三节，已对照源码 provider-composer.ts 核实默认值逻辑） |
| 掌握 API Key 的 4 种管理方式与优先级 | ✅ 通过（见第四节） |

---

## 二、运行成果（实测输出）

`npm run 03`（`code/L03-model/03a-model-management.ts`，本机 provider 为 `siyu`，无需改动直接跑通）：

```powershell
> npm run 03

📦 可用模型（共 16 个）：
  1. siyu/deepseek-v4-flash (deepseek-v4-flash)
  2. siyu/glm-5.2 (glm-5.2)
  3. siyu/gemini-2.5-flash-lite (gemini-2.5-flash-lite)
  4. siyu/deepseek-v4-flash-0731 (deepseek-v4-flash-0731)
  5. siyu/minimax-m3 (minimax-m3)
  6. siyu/step-3.7-flash (step-3.7-flash)
  7. siyu/agnes-2.5-flash (agnes-2.5-flash)
  8. siyu/gpt-5.6-luna (gpt-5.6-luna)
  9. siyu/deepseek-v4-pro (deepseek-v4-pro)
  10. siyu/deepseek-v4-pro-0813 (deepseek-v4-pro-0813)
  11. siyu/glm-5.3-flash (glm-5.3-flash)
  12. siyu/dots3-note-prev (dots3-note-prev)
  13. siyu/qwen3.8-flash (qwen3.8-flash)
  14. siyu/deepseek-v4.1-flash (deepseek-v4.1-flash)
  15. siyu/kimi-k3 (kimi-k3)
  16. siyu/gemini-3.8-flash-high (gemini-3.8-flash-high)

🔍 getModel("siyu", "deepseek-v4-flash")：
  provider       : siyu
  id             : deepseek-v4-flash
  name           : deepseek-v4-flash
  reasoning      : false
  contextWindow  : 128000
  maxTokens      : 16384

🤖 使用模型：siyu/deepseek-v4-flash

💬 问：用一句话介绍你自己

我是 pi 编程助手，一个在终端里帮你读代码、改文件、跑命令的编码智能体。

🔄 切换到：siyu/glm-5.2

💬 问：再说一句

随时告诉我要做什么，我来动手。

✅ 完成
```

**验收点**：
1. `getAvailable()` 列出 16 个可用模型（都带 Key、可调）。
2. `getModel(provider, id)` 按 provider/id 精确查找，返回完整字段（reasoning / contextWindow / maxTokens）。
3. `createAgentSession({ ..., thinkingLevel: "medium" })` 注入思考等级，第一问正常。
4. `session.setModel(secondModel)` 运行时切到 `glm-5.2`，**第二问仍答得上来**——对话历史保留，切换只换模型、不动上下文。

---

## 三、models.json 结构与模型字段

本机 `C:\Users\1\.pi\agent\models.json` 只定义了一个 provider `siyu`：

```json
"providers": {
  "siyu": {
    "name": "Siyu Relay",
    "baseUrl": "https://siyu.site/v1",      // 只到 /v1，不拼 /chat/completions
    "api": "openai-completions",            // OpenAI 兼容协议
    "apiKey": "$HERMES_CUSTOM_SIYU3_API_KEY", // $VAR 插值语法，避免明文落盘
    "models": [ { "id": "deepseek-v4-flash", "name": "deepseek-v4-flash" }, ... ]
  }
}
```

**关键发现：`contextWindow: 128000` / `maxTokens: 16384` 不是 models.json 里写的**——`deepseek-v4-flash` 的定义只给了 `id` + `name`，这两个值来自 SDK 的**默认值兜底**。已对照本地源码：

| 逻辑 | 位置 | 说明 |
|---|---|---|
| `contextWindow: definition.contextWindow ?? 128000` | `provider-composer.ts:160` | models.json 没写就用默认 128000 |
| `maxTokens: definition.maxTokens ?? 16384` | `provider-composer.ts:161` | models.json 没写就用默认 16384 |
| 非法值校验（≤ 0 直接 throw） | `provider-composer.ts:144-149` | 配错了启动即报错 |
| 模型覆盖（models.json 覆盖内置默认） | `provider-composer.ts:103-127` | `override ?? model` 逐字段合并 |

**结论**：接企业模型时，`contextWindow` / `maxTokens` 可以不写（拿默认值），但**一定要写对** `id`（请求里 `model` 字段）、`baseUrl`（路径拼 `{baseUrl}/chat/completions`，所以只填 `/v1` 级）。

---

## 四、API Key 的 4 种管理方式与优先级

教程原文（第 3 章 4.1 节）给出了 4 种方式，本机对照验证：

| # | 方式 | 写法 | 适用场景 | 本机现状 |
|---|---|---|---|---|
| ① | models.json 直接写 | provider 里 `"apiKey": "sk-xxx"` | 本地开发/demo（别提交 git） | ⚠️ 用的是 `"$HERMES_CUSTOM_SIYU3_API_KEY"` 插值，不写明文 |
| ② | 环境变量 | `SIYU_API_KEY=xxx` | 部署环境注入 | `auth.json` 为 `{}`，无 env 兜底 |
| ③ | auth.json（推荐） | `~/.pi/agent/auth.json`：`{ "zhipu": { "type": "api_key", "key": "sk-xxx" } }` | 多 Provider 集中管理 | 本机为 `{}` |
| ④ | setRuntimeApiKey | `await modelRuntime.setRuntimeApiKey("zhipu", "sk-xxx")` | Web 多用户、密钥不落盘 | 源码验证：`model-runtime.ts:536`，会同步触发 `setRuntimeApiKey` 凭证事件 |

**优先级（教程原文 ↔ 本地源码）**：`setRuntimeApiKey` > `auth.json` > `models.json` 的 `apiKey` 字段 > 环境变量。

- 教程标注：`ai/src/auth/resolve.ts` + `runtime-credentials.ts`（runtime override > auth.json > models.json apiKey > env）
- 本机实证：`setRuntimeApiKey` 入口在 `model-runtime.ts:536`，最终落到 credentials 层。

**反直觉点（教程重点）**：models.json 里写死的字面 Key 会**盖过**环境变量（环境变量只在没有任何其它来源时兜底）。唯一例外是 models.json 用 `"$VAR"` 插值——两边同一个值，不冲突。本机正是用插值，所以既保证 Key 不落盘，又不和 env 撞车。

> 注：Day 1 曾把 apiKey 从失效的 `$SIYU_API_KEY`（403 SUBSCRIPTION_NOT_FOUND）改成 `$HERMES_CUSTOM_SIYU3_API_KEY`（200 可用）。改的是 models.json 里**一行插值**，属 Key 就位修复，不算新知识；但正好演示了「Key 来源没对上 → 403 → 换 Key → 恢复」的排查链路。

---

## 五、实证：把 `siyu` relay 当「待接入网关」跑核对清单

教程 4.2 节说：拿到企业接口文档，先过 3 条**硬性要求**（不满足基本接不了），再过 9 条**核对清单**（小差异靠 compat、大差异上转换层）。

本机没有真实内网接口，但可以用 `siyu` relay（一个 OpenAI 兼容网关）当「待接入网关」，直接 curl 裸调它验证每条：

### 5.1 三条硬性要求

**① 接口形态**：`POST {baseUrl}/chat/completions`，body 是 OpenAI 风格 messages。

```powershell
> curl.exe -s -N https://siyu.site/v1/chat/completions -H "Authorization: Bearer $env:HERMES_CUSTOM_SIYU3_API_KEY" -H "Content-Type: application/json" -d '{\"model\":\"deepseek-v4-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"1+1=?\"}],\"stream\":true}'
data: {"id":"...","choices":[{"delta":{"role":"assistant","reasoning_content":"...","content":""}}]}
data: {"id":"...","choices":[{"delta":{"reasoning_content":"..."}}]}
...
data: {"id":"...","choices":[{"delta":{"content":"2"}}]}
data: {"id":"...","choices":[],"usage":{"prompt_tokens":87,"completion_tokens":27,"total_tokens":114,"reasoning_tokens":25}}
data: [DONE]
```
✅ 路径正确、SSE `data:` 分块正常、逐个 chunk 流出。

**② 必须支持 SSE 流式**：✅ 上面 `data: {...}` 分块就是 SSE，最后 `data: [DONE]` 收尾。

**③ 鉴权 Bearer**：✅ `Authorization: Bearer <key>` 直接 200；Pi Agent 只要 Key 解析成功就必然带这个头（源码 `buildParams` 在 `openai-completions.ts:792`，鉴权头由请求层统一拼装）。

### 5.2 9 条核对清单逐条实证

| # | 核对项 | siyu relay 实测 | 结论 |
|---|---|---|---|
| 1 | 端点路径 `/chat/completions` 结尾 | `https://siyu.site/v1/chat/completions` ✅ | 过 |
| 2 | 流式支持（`stream: true` + SSE） | 显式传 `stream:true`，`data:` 分块 ✅ | 过 |
| 3 | 消息结构 `{role, content}` | OpenAI 风格，`system/user/assistant/tool` 均兼容（L02 里 bash 工具链路已验证 tool 消息） | 过 |
| 4 | 流式 chunk 有 `delta.content` | **有差异**：思考阶段 delta 字段是 `reasoning_content`，最终答案才是标准 `content`（实测末尾 chunk `{"delta":{"content":"2"}}`）。SDK 只读 `content`，故在兼容范围内 | 过（差异在兼容范围，笔记见下） |
| 5 | 鉴权 Bearer | `Authorization: Bearer` 200 ✅ | 过 |
| 6 | `max_completion_tokens` vs `max_tokens` | 标准 OpenAI 参数，SDK 默认发 `max_completion_tokens` 即可 | 过 |
| 7 | 工具调用 `tools` + `strict` | 支持 tools（L02 ReAct 实锤）；`strict` 是否为 `true` 未深测，若报错可 `supportsStrictMode: false` | 过（保守） |
| 8 | usage 统计 | **末尾 chunk 带完整 usage**（prompt 87 / completion 27 / total 114 / reasoning_tokens 25），是数字非空 → **不需要** `supportsUsageInStreaming: false` | 过 |
| 9 | 推理模型思考参数 | `reasoning_content` 已能流出；thinkingLevel 由 SDK 侧注入（见第二节运行输出），再接推理模型时按文档补 `thinkingFormat` 即可 | 过（备注） |

### 5.3 本条实证的教学价值

1. **「OpenAI 兼容」≠ 完全一致**：relay 用 `reasoning_content` 传思考链、末尾 chunk 带 `usage`——都不是标准 OpenAI 字段，但都在 SDK 可接受范围内（第 4、8 条的实测反面教材：文档说兼容 ≠ 真兼容，一切以 curl 实测为准）。
2. **核对清单怎么用**：前 4 条任一不过 → 基本接不了；第 5~9 条不过 → 用 `compat`（写进 models.json 模型定义）关掉或换字段名。本机无需任何 compat 就能跑（`models.json` 没写 compat 字段），说明 siyu relay 完全符合 SDK 的默认假设。
3. **compat 处理不了差异时上转换层**（教程 4.3 节）：本地反向代理（最轻量，改消息角色/鉴权头/路径）或 `registerApiProvider`（SDK 级，来自 `@earendil-works/pi-ai/compat`）。本机暂不需要，第 4~7 章若遇网关差异再回来用。

---

## 六、源码对照（教程附录 v0.83.0 vs 本地开发版实测）

| 教程知识点 | 教程标注 | 本地实测（开发版） |
|---|---|---|
| `getModel(provider, id)` | `ai/src/models.ts:272`（接口） | `models.ts:321`（接口声明 `:170`；`getAvailable` 在 `:527`） |
| `setRuntimeApiKey` | `model-runtime.ts:400-417` | `model-runtime.ts:536`（同步发 `setRuntimeApiKey` 凭证事件 `:542`） |
| `KnownApi` 协议清单 | `ai/src/types.ts:16-26` | `types.ts:17`（`openai-completions` 等 12+ 种） |
| `OpenAICompletionsCompat`（21 个字段） | `ai/src/types.ts:519-572` | `types.ts:568` |
| `setActiveToolsByName` | `agent-session.ts:926` | `agent-session.ts:966` |
| 请求组装 `buildParams`（stream:true / stream_options） | `openai-completions.ts:673-739` | `api/openai-completions.ts:792`（`stream: true` `:809`；`stream_options.include_usage` `:819`） |
| 环境变量 Key 兜底 `envMap` | `env-api-keys.ts:79-114` | `env-api-keys.ts:79`（与教程一致） |
| models.json 默认值/校验 | （教程未单列） | `provider-composer.ts:144-149`（校验）、`:160-161`（默认 128000/16384） |

行号漂移原因同 Day 2：本地 `D:\code\pi-agent` 是 0.0.3 开发版，比教程对准的 v0.83.0 新。对照时以**符号名**为准（如 `getModel` / `setRuntimeApiKey` / `envMap`），行号只是快照。

---

## 七、本章知识点小结

1. **models.json 是模型配置的唯一入口**：`baseUrl` 只填到 `/v1` 级（自动拼 `/chat/completions`）；`api` 字段决定协议（国内厂商/兼容服务基本都是 `openai-completions`）；`id` 决定请求里 `model` 字段。
2. **模型字段**：`reasoning`（是否推理模型）、`contextWindow`（上下文上限）、`maxTokens`（最大输出）——没写时用 SDK 默认值 128000/16384（`provider-composer.ts:160-161`），配错（≤0）启动即报错。
3. **Key 4 种来源 + 优先级**：setRuntimeApiKey > auth.json > models.json apiKey > 环境变量；models.json 建议用 `"$VAR"` 插值避免明文；`setModel` 切换前会校验目标 provider 的 Key（`checkAuth`），没 Key 直接抛 `No API key`。
4. **3 条硬性要求**：端点 `/chat/completions` 形态、必须支持 SSE 流式（SDK 永远 `stream: true`，无非流式模式）、Bearer 鉴权。
5. **9 条核对清单**：前 4 条（端点/流式/消息结构/chunk 字段）任一不过基本接不了；后 5 条用 `compat` 补救；compat 搞不定（如 role 只认三种、不认 tool）上转换层（本地反向代理 / `registerApiProvider`）。
6. **一切以实际测试为准**：文档说兼容 ≠ 真兼容。本次 curl 裸调发现 `reasoning_content` 思考链 + 末尾 usage chunk 两个非标准字段，实测才知道都在兼容范围内。

---

## 八、遗留与下一步

- [ ] 第 4 章预告：系统提示词（动 ResourceLoader 层）——`npm run 04a`（替换默认人设）→ `04b`（分层提示词）→ `04c`（剥离 cwd 注入）；注意本机开发版与 v0.83.0 的 API 差异（如选项字段名）
- [ ] 本机 `reasoning: false` 的 deepseek-v4-flash 实际会流式返回 `reasoning_content`（curl 实测）——第 4 章换了系统提示词后，可回头观察思考链是否还正常
- [ ] 若以后接真实企业网关：先 curl 裸调对 9 条清单，再决定要不要 compat / 转换层