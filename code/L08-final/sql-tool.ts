/**
 * Day 19 · DataAgent 综合实战 — SQL 工具（安全子集）
 *
 * 在 sales.csv 之上提供一把"看起来像 SQL"的只读查询工具 run_sql。
 * 只接受 SELECT 白名单子集，任何写操作关键字、多语句、注释绕过都在
 * 解析层直接判失败（纵深防御的第一层；扩展层还有第二层拦截，见 sql-guard.ts）。
 *
 * 支持的子集：
 *   SELECT <列1>[, <列2>... ] FROM sales
 *   [WHERE <列> <op> <值> [AND <列> <op> <值> ...]]
 *   [ORDER BY <列> ASC|DESC]
 *   [LIMIT <正整数>]
 *
 * 子集之外的任何输入 → 返回错误（含"拒绝原因"），绝不会执行写操作。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── 白名单 ────────────────────────────────────────────────
export const SQL_COLUMNS = ["日期", "产品", "地区", "销售额", "数量", "销售人员"] as const;
export const SQL_TABLES = ["sales"] as const;

// 断言：还原行时应先检查 *BEFORE* 转换（避免 Number("") === 0 这类语义污染）
function loadSales(): { headers: readonly string[]; rows: Record<string, string>[] } {
  const filePath = join(process.cwd(), "shared/data/sales.csv");
  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = values[i] ?? ""));
    return row;
  });
  return { headers, rows };
}

export interface SqlCondition {
  column: string;
  op: "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains";
  value: string;
}

export interface SqlStatement {
  columns: string[];
  where: SqlCondition[];
  orderBy?: { column: string; desc: boolean };
  limit?: number;
}

/** 简单词法切分：关键字/标识符/数字/逗号/括号独立成 token，保留字符串。 */
function tokenize(sql: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let inQuote: string | null = null;
  for (const ch of sql) {
    if (inQuote) {
      buf += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      inQuote = ch;
      buf += ch;
      continue;
    }
    if (/[a-zA-Z0-9_\u4e00-\u9fff]/.test(ch)) {
      buf += ch;
    } else {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      if (!/^\s+$/.test(ch)) tokens.push(ch);
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

/** 解析 SELECT（只接受白名单子集）。失败返回可读原因。 */
export function parseSelect(sql: string): { ok: true; stmt: SqlStatement } | { ok: false; reason: string } {
  const upper = sql.toUpperCase();
  // 硬拦截：写操作 / 多语句 / 注释绕过 / 子查询
  const forbidden =
    /DROP\s+TABLE|DELETE\s+FROM|UPDATE\s+\w+|INSERT\s+INTO|ALTER\s+TABLE|CREATE\s+TABLE|TRUNCATE|;|--|\/\*|\*\//.test(
      upper,
    );
  if (forbidden) {
    return { ok: false, reason: "拒绝：run_sql 是只读白名单工具，仅支持 SELECT（不允许写操作/多语句/注释）。" };
  }
  const trimmed = sql.trim();
  const match =
    /^SELECT\s+([\s\S]+?)\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\d+))?\s*$/i.exec(
      trimmed,
    );
  if (!match) {
    return { ok: false, reason: "SQL 语法不在支持子集内。支持：SELECT 列 FROM sales [WHERE 条件(s)] [ORDER BY 列 ASC|DESC] [LIMIT n]。" };
  }
  const [, colPart, table, wherePart, orderPart, limitPart] = match;

  if (!SQL_TABLES.includes(table.toLowerCase())) {
    return { ok: false, reason: `未知表："${table}"。只有表 sales 可查。` };
  }

  // 列：* 或白名单列
  let columns: string[];
  if (colPart.trim() === "*") columns = [...SQL_COLUMNS];
  else {
    columns = colPart.split(",").map((c) => c.trim()).filter(Boolean);
    for (const c of columns) {
      if (!(SQL_COLUMNS as readonly string[]).includes(c)) {
        return { ok: false, reason: `未知列："${c}"。可用列：${SQL_COLUMNS.join("、")}。` };
      }
    }
    if (columns.length === 0) return { ok: false, reason: "SELECT 后至少要一个列。" };
  }

  // WHERE：条件由 AND 连接，每个条件 <列> <op> <值>
  const where: SqlCondition[] = [];
  if (wherePart) {
    const conditions = wherePart.split(/\s+AND\s+/i).map((c) => c.trim()).filter(Boolean);
    for (const cond of conditions) {
      const cm = /^([\u4e00-\u9fff\w]+)\s*(!=|>=|<=|=|>|<|contains)\s*(.+)$/.exec(cond);
      if (!cm) {
        return { ok: false, reason: `WHERE 条件无法解析："${cond}"。请按 <列> <op> <值> 且用 AND 连接多个条件。` };
      }
      const [, column, op, rawValue] = cm;
      if (!(SQL_COLUMNS as readonly string[]).includes(column)) {
        return { ok: false, reason: `WHERE 中未知列："${column}"。可用列：${SQL_COLUMNS.join("、")}。` };
      }
      if (!["=", "!=", ">", "<", ">=", "<=", "contains"].includes(op)) {
        return { ok: false, reason: `不支持运算符："${op}"。` };
      }
      const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
      where.push({ column, op: op as SqlCondition["op"], value });
    }
  }

  // ORDER BY
  let orderBy: SqlStatement["orderBy"];
  if (orderPart) {
    const om = /^([\u4e00-\u9fff\w]+)\s*(ASC|DESC)?$/i.exec(orderPart.trim());
    if (!om || !(SQL_COLUMNS as readonly string[]).includes(om[1])) {
      return { ok: false, reason: `ORDER BY 无法解析或列未知："${orderPart}"。` };
    }
    orderBy = { column: om[1], desc: (om[2] ?? "ASC").toUpperCase() === "DESC" };
  }

  let limit: number | undefined;
  if (limitPart !== undefined) {
    limit = Number(limitPart);
    if (!Number.isInteger(limit) || limit <= 0) return { ok: false, reason: "LIMIT 必须是正整数。" };
  }

  return { ok: true, stmt: { columns, where, orderBy, limit } };
}

/** 在行集上执行解析出的语句。 */
export function executeStatement(
  rows: Record<string, string>[],
  stmt: SqlStatement,
): { columns: string[]; rows: Record<string, string>[]; total: number } {
  let result = rows;
  for (const cond of stmt.where) {
    result = result.filter((row) => {
      const cell = row[cond.column] ?? "";
      if (cond.op === "contains") return cell.includes(cond.value);
      const numCell = Number(cell);
      const numValue = Number(cond.value);
      switch (cond.op) {
        case "=": return cell === cond.value;
        case "!=": return cell !== cond.value;
        case ">": return !isNaN(numCell) && !isNaN(numValue) && numCell > numValue;
        case "<": return !isNaN(numCell) && !isNaN(numValue) && numCell < numValue;
        case ">=": return !isNaN(numCell) && !isNaN(numValue) && numCell >= numValue;
        case "<=": return !isNaN(numCell) && !isNaN(numValue) && numCell <= numValue;
        default: return false;
      }
    });
  }
  const total = result.length;
  if (stmt.orderBy) {
    const { column, desc } = stmt.orderBy;
    result = [...result].sort((a, b) => {
      const na = Number(a[column]);
      const nb = Number(b[column]);
      if (!isNaN(na) && !isNaN(nb)) return desc ? nb - na : na - nb;
      return desc ? String(b[column]).localeCompare(String(a[column])) : String(a[column]).localeCompare(String(b[column]));
    });
  }
  const limited = stmt.limit !== undefined ? result.slice(0, stmt.limit) : result;
  return { columns: [...stmt.columns], rows: limited, total };
}

export const runSqlTool = defineTool({
  name: "run_sql",
  description:
    `对销售数据（sales 表，字段：${SQL_COLUMNS.join("、")}）执行只读 SQL 查询。` +
    '仅支持：SELECT <列> FROM sales [WHERE <列> <op> <值> [AND ...]] [ORDER BY <列> ASC|DESC] [LIMIT n]。' +
    "op 支持 = != > < >= <= contains。必须先写一条查询再回答，不要把真实存在的数据金额写错。",
  parameters: Type.Object({
    sql: Type.String({ description: "一条只读 SELECT 语句，例如：SELECT 产品, SUM 不行——先按行查：SELECT * FROM sales WHERE 地区 = '华东'" }),
  }),

  async execute(_id, params) {
    const { rows } = loadSales();
    const parsed = parseSelect(params.sql);
    if (!parsed.ok) {
      return {
        content: [{ type: "text", text: `SQL 被拒绝：${parsed.reason}\n请改用受支持的白名单子集（SELECT ... FROM sales WHERE ...）。` }],
        isError: true,
      };
    }
    const out = executeStatement(rows, parsed.stmt);
    const escaped: string[] = [];
    for (const row of out.rows) {
      const line = out.columns.map((c) => row[c] ?? "").join(", ");
      escaped.push(line);
    }
    let text = `SQL: ${params.sql}\n匹配 ${out.rows.length}/${out.total} 行\n\n`;
    text += out.columns.join(", ") + "\n";
    text += escaped.join("\n") + "\n";
    if (out.total > out.rows.length) text += `... 还有 ${out.total - out.rows.length} 行未显示`;
    return { content: [{ type: "text", text }] };
  },
});