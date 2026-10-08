# Day 24 · 进阶方向④参与 pi 仓库贡献——真实断红 bug 修复全流程

- 日期：10-06（实际，进阶第四天）
- 任务：跑通 `D:\code\pi-agent` 的 `npm run check`，从本地源码找一个可修的 issue 练手，按上游贡献规范完成「发现 → 定位 → 最小复现 → 修复 → 测试 → 验证」闭环
- 结论先行：**在 pi 仓库源码中定位并修复了一个真实断红 bug**——`@google/genai@2.21.0` 的 `FinishReason` 枚举新增 `TOO_MANY_TOOL_CALLS` 成员，但 `packages/ai/src/api/google-shared.ts` 的 `mapStopReason` exhaustive switch 漏配该 case，导致 `_exhaustive: never` 断言在编译期报错（TS2322）、运行时遇到该结束原因直接抛 `Unhandled stop reason` 崩溃。修复后 `npm run check` 全绿（1300 文件）、新增 22 条单测全过。

---

## 一、怎么找到这个 bug（练手路径）

Day 24 的起点就是贡献规范的第一步：**仓库必须是绿的，才有资格谈贡献**。按计划先跑 `npm run check`：

```
> biome check --write --error-on-warnings . && check:pinned-deps && check:runtime-deps
  && check:ts-imports && check:entry-graphs && check:shrinkwrap
  && check:install-lock:coding-agent && tsgo --noEmit && check:browser-smoke
Checked 1299 files in 5s. No fixes applied.   ← biome 全过
... check:runtime-deps / check:ts-imports / check:entry-graphs / check:shrinkwrap
... check:install-lock:coding-agent 全部通过
（tsgo --noEmit 无输出 = 类型检查通过；browser-smoke 通过）
```

关键观察：工作区有一个**未提交的 1 行修改**（`M packages/ai/src/api/google-shared.ts`），是此前学习会话留下的痕迹：

```diff
 	case FinishReason.MALFORMED_FUNCTION_CALL:
 	case FinishReason.UNEXPECTED_TOOL_CALL:
+	case FinishReason.TOO_MANY_TOOL_CALLS:
 	case FinishReason.NO_IMAGE:
 		return "error";
```

不放过它——这行修改指向一个可能被忽略的真实问题，正好作为 Day 24 的练手对象：把它从「可疑残留」升级为「有证据、有测试、有验证的正式修复」。

## 二、定位：为什么这是真实断红 bug

### 2.1 枚举侧（问题来源）

`mapStopReason` 的 switch 是 exhaustive 模式，末尾有：

```ts
default: {
	const _exhaustive: never = reason;   // 断言：所有枚举成员都已覆盖
	throw new Error(`Unhandled stop reason: ${_exhaustive}`);
}
```

TS 会在编译期强制 switch 覆盖 `FinishReason` 的全部成员，否则 `_exhaustive: never = reason` 报错。而 `FinishReason` 来自 `@google/genai`（当前 lockfile 锁定 `2.21.0`），该版本枚举共 17 个成员（`node_modules/@google/genai/dist/genai.d.ts` L5090-5163）：

```
FINISH_REASON_UNSPECIFIED, STOP, MAX_TOKENS, SAFETY, RECITATION, LANGUAGE, OTHER,
BLOCKLIST, PROHIBITED_CONTENT, SPII, MALFORMED_FUNCTION_CALL, IMAGE_SAFETY,
UNEXPECTED_TOOL_CALL, TOO_MANY_TOOL_CALLS,      ← L5146，语义：模型连续调用工具过多，系统终止执行
IMAGE_PROHIBITED_CONTENT, NO_IMAGE, IMAGE_RECITATION, IMAGE_OTHER
```

HEAD 的 `mapStopReason` 覆盖 16/17，**漏了 `TOO_MANY_TOOL_CALLS`**。漏配的后果：
- **编译期**：`_exhaustive: never` 断言失败 → TS2322；
- **运行期**：Gemini 若返回 `TOO_MANY_TOOL_CALLS` 结束原因，`mapStopReason` 会走 default 抛 `Unhandled stop reason: TOO_MANY_TOOL_CALLS`，Agent 调用直接崩溃（而字符串版 `mapStopReasonString` 的 default 是返回 `"error"`，行为不一致）。

### 2.2 双验证（最小复现 + detached worktree 实测）

**验证 A：最小复现**——把同样模式（16/17 覆盖 + `_exhaustive: never`）缩到 10 行，`tsgo --noEmit` 复现报错：

```
error TS2322: Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.
```

**验证 B：detached worktree 实测 HEAD**——不动主工作区，`git worktree add --detach <scratch>/pi-head HEAD` 检出纯 HEAD，链接 node_modules 后跑 `tsgo --noEmit`：

```
packages/ai/src/api/google-shared.ts(402,10): error TS2322:
  Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.
```

（其余报错为 worktree 缺本地生成文件 `models.generated.ts` 所致，与本次修复无关；主工作区含该生成文件时 `npm run check` 全绿。）A/B 双验证与工作区修复后的全绿状态互证：**该 1 行 case 就是修复**。

### 2.3 修复本身

映射语义：`TOO_MANY_TOOL_CALLS` 与 `MALFORMED_FUNCTION_CALL` / `UNEXPECTED_TOOL_CALL` 同类（工具调用异常终止），归入 `"error"` 与字符串版 default 一致。修复仅 1 行（已在 2.1 展示），不改任何既有行为。

## 三、贡献规范：补测试（新文件）

上游 `packages/ai` 用 vitest（4.1.9，package root 依赖）。新增 `packages/ai/test/google-shared-stop-reason.test.ts`（39 行），覆盖：

- `mapStopReason`：**全部 17 个枚举成员**逐一断言映射（`STOP→stop`、`MAX_TOKENS→length`、其余 15 个→`error`，含新增的 `TOO_MANY_TOOL_CALLS→error`）；
- `mapStopReasonString`：`STOP→stop`、`MAX_TOKENS→length`、`TOO_MANY_TOOL_CALLS→error`、未知字符串→`error`。

运行：

```
node node_modules/vitest/dist/cli.js --run test/google-shared-stop-reason.test.ts
Test Files  1 passed (1)
     Tests  22 passed (22)
```

补测试的意义（贡献规范要点）：**枚举驱动修复必须配枚举级全量断言**——`it.each` 遍历全部成员，今后 `@google/genai` 再新增枚举成员时，测试会因漏配 case 而失败，从"编译器报错"升级为"测试也能拦住"，双保险。

## 四、最终验证：npm run check 全绿（1300 文件）

```
Checked 1300 files in 4s. Fixed 1 file.   ← biome 自动格式化新测试文件（tab 缩进风格）
check:pinned-deps / check:runtime-deps / check:ts-imports / check:entry-graphs
check:shrinkwrap / check:install-lock:coding-agent / tsgo --noEmit / check:browser-smoke
→ 全部通过，exit 0
```

工作区最终状态（仅含本次贡献 + 既有未跟踪成果目录）：

```
M  packages/ai/src/api/google-shared.ts                       ← 修复（+1 行）
?? packages/ai/test/google-shared-stop-reason.test.ts          ← 新测试（39 行）
?? .pi/skills/dg-piagent/  ?? file/                            ← 学习材料/成果目录（原有，未动）
```

## 五、若真向上游提 PR，还差什么（流程演练）

本地练手已完成修复与验证。真实贡献到 `earendil-works/pi` 还需：

1. **开 issue**：描述断红现象（`npm run check` 的 `tsgo --noEmit` 报 TS2322，`@google/genai@2.21.0` 枚举新增成员）、影响面（Gemini 工具循环过载时运行时崩溃）、最小复现；
2. **建分支**：`fix/ai-google-map-too-many-tool-calls`，提交「fix(ai): map Google FinishReason.TOO_MANY_TOOL_CALLS to error」；
3. **PR 描述**：贴 check 前后对比 + 测试结果；按 CONTRIBUTING 门禁等 `lgtm`；
4. **变更日志**：按仓库规范在 `packages/ai/CHANGELOG.md` 的 `[Unreleased]` 加 `### Fixed` 条目（本会话在 main 分支练手，按规范未改 CHANGELOG）。

## 六、Day 24 复盘：参与贡献的认知

1. **先跑 check 再谈贡献**：`npm run check` 是仓库健康的唯一入口，绿了才有可信的"我修好了"；
2. **未提交的残留修改可能是金矿**：那 1 行 `TOO_MANY_TOOL_CALLS` case 被 day 18 的学习会话留下，恰好是依赖升级（genai 2.21.0）引入的真实断红——贡献的第一步是"看得见脏 diff"并追问为什么；
3. **exhaustive switch 是天然的安全网**：`_exhaustive: never` 让枚举成员遗漏在编译期现形，配合枚举级 `it.each` 测试后，上游再加枚举成员时我们（及 PR reviewer）都会被提醒；
4. **最小复现 + worktree 实测**是贡献者自证的三板斧：不依赖记忆，编译器和隔离工作区说了算。

一句话总结：Day 24 完成了 pi 仓库贡献的完整练手闭环——从 `npm run check` 发现脏 diff，到最小复现 + worktree 双验证坐实 `TOO_MANY_TOOL_CALLS` 断红，1 行修复 + 39 行枚举级测试，最终 check 全绿。至此 20 天学习计划 + 四个进阶方向全部完成。

---

## 七、更正与收尾（10-07）：上游 main 已包含同一修复

Day 24 的练手闭环在本地成立，但「把它真正提给上游」这一步执行后，必须先说清一个更正：**这个 bug 上游早已修复，我们的 1 行修复对上游没有增量价值**。

### 7.1 实际操作链

1. fork 上游到自己账号（`m19924772723/pi`）；
2. 本地建分支 `fix/ai-google-map-too-many-tool-calls`，只 stage 本次两个文件 → commit `d8e5c38`（2 files changed, 40 insertions）；
3. 按 CONTRIBUTING 门禁，先开 issue 等维护者 `lgtm`，不直接提 PR → issue **#10637**；
4. `git fetch origin main` + `git rebase origin/main`（base 由 `71dca87` 前移到上游 HEAD `1cedd3272`）→ 改写为 `e3efecdcb`，`--force-with-lease` 推到 fork。

### 7.2 修复在 rebase 后「消失」了

rebase 后 `git show --stat e3efecdcb` 只剩 1 个文件：

```
packages/ai/test/google-shared-stop-reason.test.ts | 39 +
```

`google-shared.ts` 的那 1 行修复不在 commit 里——git 判定 same patch already applied，静默跳过。直接查上游源码确认：

```
$ git show origin/main:packages/ai/src/api/google-shared.ts
case FinishReason.MALFORMED_FUNCTION_CALL:
case FinishReason.UNEXPECTED_TOOL_CALL:
case FinishReason.TOO_MANY_TOOL_CALLS:      ← 上游已有，语义与我们的修复逐字相同
case FinishReason.NO_IMAGE:
		return "error";
```

### 7.3 考古结论：本地 clone 的历史恰好停在「坏状态」

- 本地仓库是 **shallow clone**（`git rev-parse --is-shallow-repository` → `true`），`.git/shallow` = `71dca871bc80b6bc97be37f0ca3189399d651fff`；
- `71dca871b "fix(ci): Fix a broken test"` 恰好**删除了** `TOO_MANY_TOOL_CALLS` 这个 case，所以本地 HEAD 上能稳定复现 TS2322；
- 上游随后 `ceea48f5d Revert "fix(ci): Fix a broken test"`（`packages/ai/src/api/google-shared.ts | 1 +`）把它恢复；
- `71dca871b..1cedd3272` 之间还有约 6817 个 commit——本次断红的「证据」来自一段**已被上游回滚的历史**，不是当前上游的缺陷。

### 7.4 收尾

- issue #10637 被上游 issue-gate 自动关闭（新贡献者 issue 默认自动关闭，维护者每日复核后再决定是否 reopen），状态 `CLOSED / NOT_PLANNED`；
- 已在 #10637 追加更正评论：上游 `main` 已含同一修复、撤回提案、不提交重复 PR（重复提案是噪音，且 CONTRIBUTING 禁止未获 `lgtm` 提 PR）；
- fork 分支 `fix/ai-google-map-too-many-tool-calls`（`e3efecdcb`）保留，作为完整流程演练的证据。

### 7.5 仍存在的真实增量（若维护者认可）

上游 `packages/ai/test/google-raw-stop-reason.test.ts` 的 `FinishReason` mock **漏掉了 `TOO_MANY_TOOL_CALLS`**（其余 17 个成员齐全），且没有任何测试断言该成员的映射——这正是 `71dca871b` 删掉该 case 后 CI 仍能通过的原因。可提「仅测试」PR：补 mock 成员 + 一条 `→ error` 断言。按门禁需先获 `lgtm`。

### 7.6 复盘：这一节比修复本身更值钱

1. **先同步上游再判 bug**：任何「我发现了 bug」的结论都必须基于最新 `origin/main`；陈旧或 shallow 的 clone 会把历史上被回滚的状态当成现存缺陷；
2. **本地 HEAD 断红 ≠ 上游断红**：断红必须在目标分支上复现才算数；
3. **rebase 静默跳过相同 patch 是强信号**：commit 里凭空少了一个文件的改动，说明上游已经改过同一处；
4. **按门禁走是先见之明**：因为先开 issue 等 `lgtm`、没有直接提 PR，这次「重复」只停留在一封已自动关闭的提案上，没有占用维护者一次 PR review；
5. **练手结论不变**：`TOO_MANY_TOOL_CALLS` 漏配确实是一类真实断红（exhaustive switch + 依赖枚举新增），只是这次恰好撞上一段已被回滚的上游历史快照。
