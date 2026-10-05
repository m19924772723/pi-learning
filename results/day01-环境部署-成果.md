# Day 01 · P01 环境部署 —— 成果报告

> 日期：2026-09-29（周二）
> 章节：《第1章-环境部署-10分钟跑通第一个Agent.md》
> 目标：搭好环境，让第一个 pi-agent 在终端里开口说话

---

## 一、验收结果

| 验收标准 | 结果 |
|---|---|
| 控制台看到 Agent 完整回复一轮对话 | ✅ 通过（见下方运行输出） |
| 能在 models.json 里切模型并重启生效 | ✅ 通过（deepseek-v4-flash → glm-5.2 切换演示） |
| Node.js ≥ 22.19 | ✅ v24.19.0 |
| 教程配套代码 npm install 成功 | ✅ 317 个包，24s |

---

## 二、环境验证

```powershell
> node --version
v24.19.0            # 满足 SDK engines.node >=22.19

> cd D:\code\dg-ai-notes\pi-agent\pi_sdk_learn\code
> npm install
added 317 packages in 24s
```

`~/.pi/agent/models.json` 已配置 Provider `siyu`（OpenAI 兼容接口 `https://siyu.site/v1`），模型列表 16 个。

---

## 三、运行成果

### 1. 默认模型 deepseek-v4-flash（首次跑通）

```powershell
> npm run 01
🤖 使用模型：siyu/deepseek-v4-flash

我是运行在 pi 编码代理环境中的 AI 编程助手，可以帮你读写代码、执行命令、浏览项目文件并完成各类开发任务。
```

### 2. 模型切换演示（验收第二项）

修改 `models.json` 中 models 数组顺序（把目标模型提到首位）→ 重启运行：

```powershell
# 切到 glm-5.2
> npm run 01
🤖 使用模型：siyu/glm-5.2

我是 pi 编程助手，可以帮你读取文件、执行命令、编辑代码和创建文件来解决编程任务。
```

**结论**：`models.json` 是启动时读取的配置，改模型后重启进程立即生效。

> 注意：`gemini-2.5-flash-lite` 切换后返回空回复——该模型不在当前订阅的可用模型列表内（`GET /v1/models` 里没有它）。models.json 里的模型 id 是否真能用，以上游 `/v1/models` 返回为准。

---

## 四、问题排查记录（重要学习素材）

### 问题 1：模型全部返回空回复（无 text_delta 事件）

**现象**：`npm run 01` 打印模型名后无任何文字；诊断脚本显示事件流只有
`agent_start → turn_start → message_start → message_end → turn_end → agent_end → agent_settled`，没有 `message_update/text_delta`。

**排查**：裸调上游接口（绕过 SDK）：
```bash
curl -H "Authorization: Bearer $SIYU_API_KEY" https://siyu.site/v1/models
# → {"code":"SUBSCRIPTION_NOT_FOUND","message":"No active subscription found for this group"}
curl -X POST https://siyu.site/v1/chat/completions ... # 同样 403 SUBSCRIPTION_NOT_FOUND
```

**根因**：`~/.pi/agent/models.json` 里引用的环境变量 `SIYU_API_KEY` 已失效（订阅过期/被禁），API 返回 403。SDK 把这层错误吞掉，表现为空回复。

**解决**：测试本机其他 Key，`HERMES_CUSTOM_SIYU3_API_KEY` 在该 relay 返回 200，chat completion 实测正常；把 `models.json` 的 apiKey 改为 `$HERMES_CUSTOM_SIYU3_API_KEY`。

**经验**：Agent 空回复 ≠ 环境搭错，先用 curl 裸调上游接口把「SDK 问题」和「上游问题」切分开。

### 问题 2：改配置后「没找到可用模型」

**现象**：`getAvailable()` 返回空数组，`01-hello.ts` 打印 `❌ 没找到可用模型`。

**排查**：检查文件字节发现头部是 `EF BB BF`——**PowerShell `[System.Text.Encoding]::UTF8` 写文件会带 BOM**。Node 的 `JSON.parse` 不剥离 BOM，直接报 `Unexpected token`，整个配置解析失败 → 无 Provider → 无模型。

**解决**：用 `New-Object System.Text.UTF8Encoding($false)` 重写文件（无 BOM），并 `TrimStart([char]0xFEFF)` 去掉已有 BOM。

**经验**：在 Windows PowerShell 里写 JSON 配置文件，务必用无 BOM 的 UTF8 编码；JSON.parse 对 BOM 是严格拒绝的。

---

## 五、本章知识点小结

1. **`ModelRuntime.create()`**：读 `~/.pi/agent/` 下的 models.json + auth.json，合并内置 Provider，列出可用模型。apiKey 支持 `$ENV_VAR` / `${ENV_VAR}` / `!命令` 三种取值方式（源码：`resolve-config-value.ts`）。
2. **`getAvailable()`**：过滤逻辑在 `packages/ai/src/models.ts`——Provider 没配 Key 就返回空数组。
3. **`createAgentSession({ model, modelRuntime })`**：创建会话，内部自动注册工具、加载资源、连 LLM。返回对象解构取 `session`。
4. **`session.subscribe(cb)`**：订阅事件流。文字增量事件是 `message_update` 类型下的 `assistantMessageEvent.type === "text_delta"`，字段名 `delta`。
5. **`session.prompt(msg)`**：发问并阻塞到答完；**`session.dispose()`**：释放资源（try/finally 保证）。
6. **事件流观测**（本次实测）：`agent_start → turn_start → message_start → [text_delta…] → message_end → turn_end → agent_end → agent_settled`。
7. **配置目录可迁移**：受限环境用 `PI_CODING_AGENT_DIR` 环境变量或 `createAgentSession({ agentDir })` 把配置放到项目内（源码：`core/config.ts:495,515`）。

---

## 六、源码对照（v0.83.0，行号以安装版为准）

| 知识点 | 源码位置 | 说明 |
|---|---|---|
| 配置目录 `~/.pi/agent/` | `packages/coding-agent/src/core/config.ts:515` | `getAgentDir() = join(homedir(),".pi","agent")` |
| `PI_CODING_AGENT_DIR` | `config.ts:495,515` | 设了它配置目录就改 |
| `ModelRuntime.create()` 读什么 | `model-runtime.ts:136-139` | auth.json + models.json，默认不联网 |
| `getAvailable()` 过滤 | `packages/ai/src/models.ts:394-409` | 没配 Key 的 Provider 不返回 |
| `$VAR` 插值 | `resolve-config-value.ts` | 支持 `$VAR`、`${VAR}`、`!cmd` |
| 事件 `text_delta` / `.delta` | `agent-session.ts:740-746`；`ai/src/types.ts:504` | 流式文本字段名 |

（本地源码树：`D:\code\pi-agent`）

---

## 七、遗留与下一步

- [ ] 记下本次实际可用模型（已实测：`deepseek-v4-flash`、`glm-5.2`；订阅模型列表以 `GET /v1/models` 为准）
- [ ] 第 2 章预告：`createAgentSession` 内部做了什么、subscribe 里那串判断的含义——逐行讲清
- [ ] 后续章节运行命令均在 `pi_sdk_learn/code/` 下执行，依赖已就绪
