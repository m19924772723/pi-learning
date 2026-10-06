# Day 22 · 进阶方向②自定义 Provider——不靠魔法，靠 registerProvider

- 日期：10-06（实际，进阶第二天）
- 任务：精读 `H02-custom-provider.md` + `sdk_doc/16-custom-provider.md`，对照本地 pi 源码核验 `registerProvider` 的真实行为，并用 `ModelRuntime` 实测五种模式 + 三类校验规则
- 结论先行：**自定义 Provider = 在"内置目录（builtins）+ models.json + 扩展注册"三层之上再叠一层**。`registerProvider(providerId, config)` 不是魔法——它有明确的组合规则（覆盖/替换/兜底）、明确的校验时机（结构错误同步抛、认证缺失延迟到调用期）、以及明确的清理路径（unregisterProvider）。Day 22 实测 6 段脚本全部通过，并纠正了两个此前凭文档猜测的断言

---

## 一、核心机制：三层来源如何叠成一个 Provider

pi 的 provider 由三层配置组合（`provider-composer.ts`）：

```
第 1 层  builtins（内置目录，40 个内置 provider：openai/anthropic/siyu…）
第 2 层  models.json（用户配置文件，~/.pi/agent/models.json）
第 3 层  扩展注册（registerProvider 写入的 ProviderConfigInput）
        ↓
composeModelProvider(providerId, base, modelConfig, extension)
        ↓
组合后的 Provider：id/name/baseUrl/headers/auth/getModels/stream/streamSimple
```

关键源码锚点（`D:\code\pi-agent\packages\coding-agent\src\core\provider-composer.ts`，2026-10-06 快照）：

| # | 机制 | 位置 | 行为 |
|---|---|---|---|
| 1 | `ProviderConfigInput` 类型（可写字段） | L46-70 | `api`/`baseUrl`/`apiKey`/`models`/`streamSimple`/`oauth`/`authHeader` 等 |
| 2 | `applyExtension` 模型合并 | L217-244 | **override-only 分支 L223-225**：`!config.models && baseUrl` 时只覆盖 baseUrl，保留内置 16 个模型，不清空 |
| 3 | `validateExtensionProvider` 结构校验 | L416-426 | 同步抛错：`streamSimple 无 api`（L422-424）；models 缺 baseUrl（经 applyExtension L235） |
| 4 | `composeModelProvider` 组合 | L429-518 | auth 校验 L460（见下）；streamSimple 分派 L470-482；getApiProvider 兜底 L478-479 |
| 5 | `withConfiguredAuth` | L267-279 | `authHeader: true` 要求已解析的 apiKey（L275），否则抛错 |
| 6 | `composeApiKeyAuth` | L310-360 | **永远合成一个带 login 提示兜底的 ApiKeyAuth**——这是"无认证不报错"的根本原因（见第四节） |

## 二、实测证据（ModelRuntime 等价验证）

> 说明：`pi.registerProvider` 是扩展 API，本脚本用其实现层 `ModelRuntime.registerProvider(providerId, config)`（`model-runtime.ts:750-786`）做等价验证；真实调用走 `completeSimple()`，与 agent loop 同一条流式路径。

### 模式 1a：注册 OpenAI 兼容网关（siyu relay）

```
getProvider('siyu-custom') = siyu-custom | name = Siyu Relay (自定义)
模型数 = 1 | ids = deepseek-v4-flash
模型 baseUrl = https://siyu.site/v1 | api = openai-completions
```

### 真实链路：注册后用 completeSimple 调 deepseek-v4-flash（真实网络请求）

```
回复: 我是通过自定义 Provider 提供服务的 AI 测试助手，正在协助您完成第 22 天的学习任务。
usage: {"input":114,"output":42,"cacheRead":0,"cacheWrite":0,"reasoning":17,"totalTokens":156}
stopReason: stop
```

自定义 Provider 与内置 provider 走完全相同的调用路径，一次成功。

### 模式 4：覆盖已有 provider 的 baseUrl（override-only 分支）

```
覆盖前 siyu 模型数 = 16
覆盖后 siyu 模型数 = 16 （模型未被清空，符合 override-only）
baseUrl 生效 = true
```

`applyExtension` 的 L223-225 分支：只传 baseUrl 不传 models → 16 个内置模型全部保留、baseUrl 替换，而不是替换成空模型列表。**这是扩展最常用的场景：把内置 provider 的流量指到自己的网关。**

### 模式 2：streamSimple 自定义协议（本地 mock，不发网络请求）

```
自定义协议输出: [mock-echo] 你好，自定义协议
stopReason: stop
验证通过：streamSimple 事件序列被框架正确消费
```

自定义 api 字符串（`mock-echo-v1`）+ 自写 `streamSimple`（返回 `createAssistantMessageEventStream()`），按协议 push `start → text_start → text_delta* → text_end → done → end`，框架 `completeSimple` 正确消费并返回最终 AssistantMessage。证明**非标准 API（如企业内部私有协议）可以直接以 JS 函数形式接入**，事件协议与内置 API 完全一致。

### unregisterProvider 清理

```
清理后 getProvider('siyu-custom') = undefined（已移除）
```

## 三、校验规则：三类非法注册的真实行为

| 用例 | 配置 | 真实行为 | 源码依据 |
|---|---|---|---|
| bad-1 | `streamSimple` 无 `api` | **注册时同步抛错** `Provider bad-1: "api" is required when registering streamSimple.` | `validateExtensionProvider` L422-424 |
| bad-2 | models 无 `baseUrl` | **注册时同步抛错** `Provider bad-2: "baseUrl" is required when defining custom models.` | `applyExtension` L235 |
| bad-3 | 无 apiKey / 无 oauth | **注册不抛错**；调用期失败 `Provider is not configured: bad-3`（stopReason=error）；`getProviderAuthStatus = {"configured":false}` | `composeApiKeyAuth` L310-360 + `prepareRequest` L588 |

## 四、两个被纠正的认知（文档 vs 源码实测）

### 1. "无认证注册应报错" → 错，认证是延迟校验

读文档时以为"无认证 = 注册即抛 `no authentication method configured`"。实测发现：

- `composeModelProvider` L460 的抛错（`if (!apiKey && !oauth) throw`）**只在 composeApiKeyAuth 返回 undefined 时触发**；
- 而 `composeApiKeyAuth`（L310-360）几乎总是返回一个 ApiKeyAuth 对象——因为它带一个 `login` 兜底方法（L325-330），交互式 CLI 可以在运行时提示用户输入 API key；
- 只有 OAuth-only provider（`!inherited && rawKey === undefined && oauth`，L320）才返回 undefined 触发 L460 抛错。

所以正确的心智模型是：**结构错误（缺 api / 缺 baseUrl）注册期同步抛；认证缺失注册期放行（login 兜底），调用期经 `prepareRequest → getAuth` 报 `Provider is not configured`**。`getError()` 是组合期错误报告，bad-3 没有组合错误所以为空——不是 bug，是设计。

### 2. "调用应抛 JS 异常" → 错，lazyStream 把 throw 转成 error 结果

读源码以为 `streamWith` 的兜底 `getApiProvider` 未命中会 `throw`（L479）。实测发现 `completeSimple` **不抛 JS 异常**，而是 resolve 出一个 `stopReason: "error"`、`errorMessage: "No API provider registered for api: mock-echo-v1"` 的 AssistantMessage：

```
[OK] 调用失败并报告: error - No API provider registered for api: mock-echo-v1
```

原因：`streamWith` 的返回值包在 `lazyStream` 里（`model-runtime.ts:636-641`），同步 throw 被转换成 error 事件流，`.result()` 正常 resolve。**流式 API 的错误不是 throw，而是 error 结果消息**——这解释了为什么 agent loop 能优雅处理模型错误而不崩。

## 五、一图总结自定义 Provider 接入

```
内置目录(40) ──┐
models.json ──┤ composeModelProvider ──→ 组合 Provider
registerProvider ┘  (provider-composer.ts:429)
                        │
        校验时机：结构错误注册期同步抛（validateExtensionProvider）
                  认证缺失调用期报错（prepareRequest/getAuth）
                        │
        分派顺序（streamWith :463）：
          1. extension.streamSimple（自定义协议，api 匹配）→ 最高优先
          2. base 支持该 api → 走内置 stream/streamSimple
          3. getApiProvider(api) 兜底 → 未命中报 No API provider registered
```

## 六、一句话总结

自定义 Provider 的接入点就一个 `registerProvider`，但它背后是**明确的三层组合规则、两段校验时机、三条分派顺序**。Day 22 用 6 段脚本（注册/真实调用/override-only/streamSimple/三类校验/unregister）把它全部钉死在源码上，并修正了两处文档误导。下一步（Day 23）用多 Agent 协作把 Provider 的成果串进真实的多会话场景。
