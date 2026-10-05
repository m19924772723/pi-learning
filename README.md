# Pi-Agent 学习成果（20 天双轨）

> 基于 [dg-ai-notes](https://github.com/buchidonggua/dg-ai-notes) 双轨教程：**实战上手 P01–P07 + 源码精读 M01–M10**，配本地 pi 源码（`packages/agent`、`packages/coding-agent`）逐行对照。
>
> 学习周期：20 天（每天约 1.5–2 小时），本仓库收录全部成果与最终自研交付物。

## 仓库内容

| 目录 / 文件 | 说明 |
|---|---|
| `每日学习计划.md` | 20 天打卡表（Day 1–20 全部 ✅），含命令速查与学习原则 |
| `results/day01–day07-*.md` | 实战上手 P01–P07 每日成果 |
| `results/day08–day18-*.md` | 源码精读 M01–M10 + 源码实地验证每日成果 |
| `results/day19-综合实战-成果.md` | 自研 DataAgent 交付报告（单元 15/15 + 真实链路 + SSE 端到端） |
| `results/day20-回顾与进阶-成果.md` | 两次架构图对比 + 20 天总览 + 进阶方向 |
| `code/L08-final/` | **Day 19 自研交付物**：DataAgent（SQL 工具 + 危险拦截 + 事件日志 + SSE 服务） |

## 学习路线

1. **第 1 周（Day 1–7）实战上手**：环境部署 → 机制全貌 → 模型配置 → 系统提示词 → 定义工具 → 事件监听 → 上线封装（SSE），搭出 DataAgent 雏形。
2. **第 2 周（Day 8–14）源码精读（上）**：M01 总览 → M02 三层架构 → M03 Agent Loop → M04 模型调用 → M05 工具系统 → M06 消息系统 → M07 事件驱动。
3. **第 3 周（Day 15–20）源码精读（下）+ 综合实践**：M08 上下文工程 → M09 上下文压缩 → M10 会话管理 → Day 18 源码实地验证（10 个漂移锚点全部复核成立）→ Day 19 自研 DataAgent → Day 20 复盘。

## Day 19 自研交付物：DataAgent

带 SQL 工具 + 危险 SQL 拦截 + 事件日志的数据助手，三层防线全部实测通过：

1. **人设兜底**：系统提示与工具描述让模型不写危险 SQL（真实链路实测：诱导 DROP TABLE 时模型直接拒绝）。
2. **扩展层拦截**：`pi.on("tool_call")` 在工具执行前拦截危险模式（DROP/DELETE/分号多语句/UNION/注释绕过等）。
3. **解析层拒绝**：`parseSelect` 只接受 SELECT 白名单子集（白名单表/列/运算符），写操作、多语句、未知表列一律失败。

验证结果：单元 15/15 通过；真实链路（deepseek-v4-flash）正常查询数字正确、危险诱导被拒；SSE 服务（POST /chat + GET /log）端到端事件流完整（thinking → tool_start → tool_end → text → done）。

```bash
# 运行 Day 19 交付物（在 pi_sdk_learn/code 目录下）
npx tsx L08-final/19a-unit-test.ts     # 单元验证（不依赖模型，15 项断言）
npx tsx L08-final/19b-live-test.ts     # 真实链路（需要 models.json 配好模型）
npx tsx L08-final/19-sse-server.ts     # SSE 服务（POST :3100/chat, GET :3100/log）
```

## 源码精读关键结论（本地 0.85.x 实测）

- **Agent Loop**：`stopReason` 流转分支；length 截断时工具调用 fail-closed（`agent-loop.ts:230-233`）。
- **上下文注入**：`buildSystemPrompt` 尾部只有 Current working directory、无 Current date（`coding-agent/src/core/system-prompt.ts:28`）。
- **上下文压缩**：主摘要与 turnPrefix 摘要串行执行（`compaction.ts:774-798`）。
- **会话管理**：agent-core 层 4 种 Entry 与 coding-agent 层 9 种 Entry 两套实现并行（`agent/src/harness/session/types.ts:16`）。
- **会话存储位置**：`~/.pi/agent/sessions/<encoded-cwd>/`（`session-manager.ts:476-481`）。

## 进阶方向（Day 20 整理）

- 扩展系统深挖：`_chapter-design/第11章-扩展系统-设计文档.md`
- 自定义 Provider / 企业内网接入：skill 场景 H02、H07
- 多 Agent 协作：skill 场景 H06、sdk_doc `21-multi-agent.md`
- 参与 pi 仓库贡献：跑通 `npm run check`，从修 issue 开始