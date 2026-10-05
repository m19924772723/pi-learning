/**
 * Day 19 · 单元验证（不依赖模型）— SQL 子集解析 + 危险拦截逻辑
 *
 * 运行：cd pi_sdk_learn/code && npx tsx L08-final/19a-unit-test.ts
 */
import { parseSelect, executeStatement, runSqlTool, SQL_COLUMNS } from "./sql-tool.ts";
import { findDanger } from "./sql-guard.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ── 1. 危险 SQL 拦截（扩展层 findDanger）────────────────
console.log("\n[1] 扩展层 findDanger 拦截");
check("DROP TABLE 被拦截", findDanger("DROP TABLE sales") === "DROP（删表）");
check("DELETE 被拦截", findDanger("DELETE FROM sales") === "DELETE（删行）");
check("分号多语句被拦截", findDanger("SELECT * FROM sales; DROP TABLE sales") === "多语句（分号）");
check("UNION 注入被拦截", findDanger("SELECT * FROM sales UNION SELECT 1,1") === "UNION 注入");
check("正常 SELECT 放行", findDanger("SELECT * FROM sales WHERE 地区 = '华东'") === null);

// ── 2. 解析层（工具内纵深防御）───────────────────────────
console.log("\n[2] 解析层 parseSelect");
const ok1 = parseSelect("SELECT * FROM sales WHERE 地区 = '华东'");
check("合法 SELECT 通过", ok1.ok === true);
check("支持中文列名/字符串", ok1.ok && ok1.stmt.where[0].column === "地区" && ok1.stmt.where[0].value === "华东");
const bad1 = parseSelect("DROP TABLE sales");
check("解析层拒绝 DROP", bad1.ok === false && bad1.reason.includes("只读"));
const bad2 = parseSelect("SELECT * FROM users");
check("解析层拒绝未知表", bad2.ok === false && bad2.reason.includes("未知表"));
const bad3 = parseSelect("SELECT 金额 FROM sales");
check("解析层拒绝未知列", bad3.ok === false && bad3.reason.includes("未知列"));

// ── 3. 执行结果正确性 ───────────────────────────────────
console.log("\n[3] executeStatement 结果");
const content = readFileSync(join(process.cwd(), "shared/data/sales.csv"), "utf-8");
const lines = content.trim().split("\n");
const headers = lines[0].split(",").map((h) => h.trim());
const rows = lines.slice(1).map((l) => {
  const vs = l.split(",").map((v) => v.trim());
  const r: Record<string, string> = {};
  headers.forEach((h, i) => (r[h] = vs[i] ?? ""));
  return r;
});

const q = parseSelect("SELECT * FROM sales WHERE 地区 = '华东'");
if (q.ok) {
  const out = executeStatement(rows, q.stmt);
  check("华东 4 行", out.total === 4, `实际 ${out.total}`);
  check("华东笔记本合计 45000", out.rows.filter((r) => r["产品"] === "笔记本电脑").reduce((s, r) => s + Number(r["销售额"]), 0) === 45000);
} else {
  check("华东查询执行", false, q.reason);
}
const all = executeStatement(rows, { columns: [...SQL_COLUMNS], where: [], limit: undefined });
check("全表 12 行、合计 380000", all.total === 12 && all.rows.reduce((s, r) => s + Number(r["销售额"]), 0) === 380000);

// ── 4. run_sql 工具本体直接执行（绕过 LLM）──────────────
console.log("\n[4] run_sql 工具 execute 直调");
const res = await runSqlTool.execute("test", { sql: "SELECT 产品, 销售额 FROM sales WHERE 地区 = '华东' ORDER BY 销售额 DESC LIMIT 3" });
const text = String(res.content?.[0]?.text ?? "");
check("工具返回含匹配行数", text.includes("匹配 3/4 行"), "实际: " + text.split("\n")[1] ?? "");
check("工具返回含明细", text.includes("45000"));

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed > 0 ? 1 : 0);