# Day 04 · P04 系统提示词 —— 成果报告

> 日期：2026-10-02（周五）
> 章节：《第4章-系统提示词-必须覆盖默认Agent人设.md》
> 目标：看懂系统提示词的五段拼装机制，学会换掉默认编程助手人设、做垂直智能体，掌握多来源拼装与 before_agent_start 钩子

---

## 一、验收结果

| 验收标准 | 结果 |
|---|---|
| `npm run 04a`（替换默认人设）跑通 | ✅ 通过（回答口径完全变成"数据分析师"，不再是编程助手口吻） |
| `npm run 04b`（多来源分层提示词）跑通 | ✅ 通过（静态文件 + 用户上下文拼装，Agent 按"销售部王小姐"权限口径回答） |
| `npm run 04c`（剥离 cwd 注入）跑通 | ✅ 通过（before_agent_start 钩子去掉 `Current working directory` 行） |
| 理解系统提示词五段拼装与基础人设三级回退 | ✅ 通过（见第三节，已对照本地源码逐条核实） |
| 写出不"翻车"的系统提示词 | ✅ 通过（见第二节：04a 演示的"先确认已知/未知、不编造数据"规则被 Agent 严格执行） |

---

## 二、运行成果（实测输出）

三个脚本全部一次跑通，本机 provider 为 `siyu`，无需改动：

### 04a：替换默认人设（`L04-prompt/04a-replace-prompt.ts`）

核心两行：`systemPromptOverride` 换人设、`appendSystemPromptOverride: () => []` 清空追加。

```powershell
> npm run 04a
💬 问：上月销售额下降了 15%，可能的原因有哪些？

我先说明一下当前的情况，然后给出分析框架。
## 一、已知 / 未知信息确认
**已知：** 上月销售额同比下降 15%...
**未知（目前我无法确认，需要您补充）：**
- ❌ 没有可用的销售明细数据...
- 比较基准：是环比还是同比？...
> ⚠️ 以下分析基于行业经验给出假设排序，不是基于您真实数据的结论。
## 二、可能原因（按可能性从高到低排序）
① 促销/活动节奏变化… ② 流量下滑… ③ 转化率下降… ④ 客单价下降…
⑤ 季节性/周期性波动… ⑥ 库存/断货影响… ⑦ 价格或产品竞争力变化…
⑧ 老客复购下降… ⑨ 数据口径问题（务必先排除）…
✅ 完成
```

**验收点**：回答结构完全踩中规则——「先确认已知/未知」「按可能性从高到低」「每个原因附验证方法」「未知就说未知（明确说没有销售数据文件）」。这就是覆盖默认人设的效果：换成数据分析师后，模型不再提代码，而是按业务分析流程走。

### 04b：多来源拼装（`L04-prompt/04b-layered-prompt.ts`）

人设/规则/输出格式从 `prompts/analyst/*.md` 读，用户上下文从模拟数据库读，`join` 成完整提示词。

```powershell
> npm run 04b
💬 用户 王小姐（销售部）问：上月销售额下降 15%，可能的原因有哪些？

我先看看当前目录下有没有可用的销售数据...
找到了销售数据文件，我来查看一下数据结构...
## 结论
从您有权访问的销售数据来看，目前无法直接验证"上月下降 15%"这个结论：
现有数据（shared/data/sales.csv）只包含 2024年1月15日–1月26日共12笔订单...
- 维度可用：产品、地区、销售人员、日期
...对照 04a 的"没找到数据"（本人设差异）
✅ 完成
```

**验收点**：Agent 不但按人设回答，还主动用工具找到了 `shared/data/sales.csv` 并读取结构——把"无数据"的 04a 升级成"发现数据文件 + 说明数据边界"的 04b。动态上下文（王小姐/销售部/本部门销售数据）也确实进了回答口径。

### 04c：剥离 cwd 注入（`L04-prompt/04c-strip-cwd.ts`）

```powershell
> npm run 04c
[strip-cwd] 替换前末尾: ng directory: D:/code/dg-ai-notes/pi-agent/pi_sdk_learn/code
[strip-cwd] 替换后末尾: 你是一个企业数据分析助手，帮业务方分析销售数据、定位问题、给出建议。
💬 问：上月销售额下降了 15%，可能的原因有哪些？
...（Agent 照常找到 sales.csv 并完成分析）✅
```

**验收点**：控制台直接打印前后末尾——`Current working directory: ...` 行确实被删掉了。且 Agent 仍能通过工具找到并分析数据文件：**去掉 cwd 行不影响工具实际执行目录**（那由 SDK 按 `cwd` 配置解析），正是教程 §3 ⑤ 强调的。

---

## 三、核心机制（对照本地源码）

### 3.1 系统提示词五段拼装

```
最终提示词 = ① 基础人设 ←（systemPromptOverride > .pi/SYSTEM.md > 硬编码兜底）
           + ② 追加规则 ← .pi/APPEND_SYSTEM.md（项目级/全局级）
           + ③ 项目上下文 ← 从 cwd 向上找 AGENTS.md / CLAUDE.md
           + ④ 技能描述 ← .pi/skills/*/SKILL.md（需工具集里有 read）
           + ⑤ 工作目录 ← SDK 固定追加 "Current working directory: {cwd}"
```

本机实证：`~/.pi/agent/` 下没有 SYSTEM.md / APPEND_SYSTEM.md → ② 系统默认为空；cwd 下没有 AGENTS.md/CLAUDE.md → ③ 为空；但 `.pi/skills/dg-piagent/` 存在 → ④ 有技能注入（前提 read 工具在）。**做垂直智能体只需管 ①，②③④ 不创建文件就是空的，⑤ 基本无害**。

### 3.2 源码对照（教程附录 v0.83.0 vs 本地开发版实测）

| 教程知识点 | 教程标注 | 本地实测（开发版） |
|---|---|---|
| 五段拼装 | `system-prompt.ts:28-72`（customPrompt）; `:74-162`（默认） | `system-prompt.ts:48-70`（customPrompt 路径，`:70` 追 cwd 行）；默认路径 `:165` 追 cwd 行 |
| `systemPromptOverride` | `resource-loader.ts:191,527` | 接口 `:192`；应用 `:528`（`override(baseSystemPrompt) ?? baseSystemPrompt`……实际是 `override ? override(base) : base`） |
| `appendSystemPromptOverride` | `resource-loader.ts:193,539-541` | 接口 `:193`；应用 `:540-541`（返回 [] → append 空） |
| `before_agent_start` 替换本轮 | `extensions/runner.ts:1076-1140`; `agent-session.ts:1247,1069` | `agent-session.ts:1285`（触发钩子）→ `:1308`（`_systemPromptOverride = result.systemPrompt`）→ `:1312`（finally 复位）；`_systemPromptOverride` 定义 `:378`，读点 `:572/:980` |
| SYSTEM.md 三级回退 | `resource-loader.ts:525-527`（override 链）; `:1022-1034`（SYSTEM.md 发现）; `system-prompt.ts:121-138`（硬编码） | 本机没建 SYSTEM.md，走兜底：`systemPromptOverride` 或硬编码编程助手 |

**对照结论**：行号仍有漂移（0.0.3 开发版 vs v0.83.0），以符号名为准；机制完全一致——`systemPromptOverride` 是彻底替换（返回值即人设），`appendSystemPromptOverride` 返回 `[]` 后 join 为空、append 为 undefined，`before_agent_start` 返回 `{ systemPrompt }` 链式覆盖、finally 逐轮复位。

---

## 四、本章知识点小结

1. **五段拼装**：人设 → 追加规则 → 项目上下文 → 技能描述 → cwd。做垂直智能体只动 ①，其余不建文件就是空。
2. **基础人设三级回退**：`systemPromptOverride`（代码层，最高）> `{cwd}/.pi/SYSTEM.md` 或 `~/.pi/agent/SYSTEM.md`（文件层）> 硬编码编程助手（兜底）。**别用全局 `~/.pi/agent/SYSTEM.md`**，会影响所有 pi 项目。
3. **换人设两行**：`systemPromptOverride: () => "人设"` + `appendSystemPromptOverride: () => []`；记得 `await loader.reload()` 让覆盖生效。
4. **多来源拼装**：静态（文件，运营可改）+ 动态（数据库，用户身份/权限）+ 会话状态，运行时 join 成一段。改规则不动用户逻辑，解耦清晰。人设完全不同的场景应拆成多个 Agent 服务，不是塞同一份提示词。
5. **cwd 行无开关**：真要删用扩展 `before_agent_start` 钩子返回 `{ systemPrompt }`（通用方法——任何对最终系统提示词的修改都能用它，第 6 章系统讲扩展）。删了不影响工具实际执行目录。
6. **技能注入有前提**：工具集里要有 `read` 工具，否则技能段不拼（模型读不了 SKILL.md，注了也白注）。
7. **实测心得**：04a→04b 的差异直观展示了人设和数据的作用——同一个问题，无人设 + 无数据 = 框架性回答；有人设 + 有数据 = 数据边界 + 可执行分析。系统提示词值得花时间写好。

---

## 五、遗留与下一步

- [ ] 第 5 章预告：定义工具——给 Agent 加 SQL 查询工具（动 Tool 层），学会把报错原因+解决办法封装回结果
- [ ] 04b 里 Agent 已能自己找到 `shared/data/sales.csv`——第 5 章会把这个"找数据→查数据"的过程固化成自定义工具
- [ ] 第 6 章会系统讲扩展（before_agent_start 只是其中一个钩子），届时回来把钩子全家桶过一遍