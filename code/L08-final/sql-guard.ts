/**
 * Day 19 · DataAgent 综合实战 — 危险 SQL 拦截 + 事件日志（扩展层）
 *
 * 第二道防线：就算 LLM 直接写了危险 SQL（DROP TABLE 等），run_sql 解析层会拒绝；
 * 但更早在扩展层就用 pi.on("tool_call") 拦截掉，把 reason 喂回给 LLM——
 * 拦截发生在"工具真正执行之前"，不浪费一次工具调用。
 *
 * 同时演示事件日志：subscribe 收外部层事件、decode 记录到控制台与文件。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 危险模式：只读工具禁止出现写操作 / 多语句 / 注入向量 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // 多语句（分号）风险最高（可拼接任意后续语句），必须最先命中
  { pattern: /;/, label: "多语句（分号）" },
  { pattern: /\bDROP\b/i, label: "DROP（删表）" },
  { pattern: /\bDELETE\b/i, label: "DELETE（删行）" },
  { pattern: /\bUPDATE\b/i, label: "UPDATE（改行）" },
  { pattern: /\bINSERT\s+INTO\b/i, label: "INSERT（插行）" },
  { pattern: /\bALTER\b/i, label: "ALTER（改表结构）" },
  { pattern: /\bTRUNCATE\b/i, label: "TRUNCATE（清表）" },
  { pattern: /--|\/\*|\*\//, label: "注释绕过" },
  { pattern: /\bUNION\b/i, label: "UNION 注入" },
  { pattern: /OR\s+1\s*=\s*1\b/i, label: "OR 1=1 恒真条件" },
];

/** 判断一条 SQL 是否危险：命中任一模式即判危险，并返回命中的标签 */
export function findDanger(sql: string): string | null {
  for (const d of DANGEROUS_PATTERNS) {
    if (d.pattern.test(sql)) return d.label;
  }
  return null;
}

/**
 * 组装扩展：注册 run_sql 工具 + tool_call 拦截 + 事件日志。
 * 事件日志写到 day19-events.log（追加），方便事后审计整轮事件流。
 */
export function dataAgentExtension(pi: ExtensionAPI, logFilePath?: string) {
  const logPath = logFilePath ?? join(process.cwd(), "day19-events.log");

  const writeLog = (line: string) => {
    try {
      mkdirSync(join(process.cwd(), ""), { recursive: true });
      appendFileSync(logPath, `${line}\n`, "utf-8");
    } catch {
      /* 日志失败不影响主流程 */
    }
    console.log(`    📡 ${line}`);
  };

  // ── 工具调用前拦截：危险 SQL 直接 block ────────────────
  pi.on("tool_call", async (event: any) => {
    if (event.toolName !== "run_sql") return undefined;
    const sql: string = String(event.input?.sql ?? "");
    const danger = findDanger(sql);
    if (danger) {
      writeLog(`🚫 拦截 run_sql：命中危险模式 [${danger}] SQL=${sql}`);
      return {
        block: true,
        reason: `危险 SQL 已被拦截（命中：${danger}）。run_sql 是只读工具，只允许 SELECT 白名单子集。请改写为安全的 SELECT 再重试。`,
      };
    }
    return undefined; // 放行
  });

  // ── 工具执行开始：记录调用参数 ─────────────────────────
  pi.on("tool_execution_start", (event: any) => {
    if (event.toolName === "run_sql") {
      writeLog(`🔧 run_sql 执行：${String(event.args?.sql ?? "")}`);
    }
  });

  // ── 工具执行结束：记录结果（截断）──────────────────────
  pi.on("tool_execution_end", (event: any) => {
    if (event.toolName === "run_sql") {
      const text = String(event.result?.content?.[0]?.text ?? "");
      writeLog(`✅ run_sql 完成：${text.slice(0, 120).replace(/\n/g, " ")}${text.length > 120 ? "..." : ""}`);
    }
  });

  // ── 轮次边界：记录每轮是否调用工具 ─────────────────────
  pi.on("turn_end", () => writeLog("—— turn_end ——"));
  pi.on("agent_settled", () => writeLog("✅ agent_settled（一次 prompt 彻底完成）"));
}