/**
 * Input guard and output shaping for the explain_query tool.
 *
 * EXPLAIN without ANALYZE plans a statement and executes nothing, so it is a
 * read even for an UPDATE; EXPLAIN ANALYZE runs the statement, which is why
 * it is refused here rather than left to the READ ONLY transaction (which
 * would only catch writes). A second statement after a `;` would run outside
 * the EXPLAIN, so multi-statement input is refused too.
 */

const EXPLAIN_PREFIX =
  /^\s*explain\b(?:\s*\((?<options>[^)]*)\))?(?:\s+(?<bare>(?:analy[sz]e|verbose)\b\s*)+)?/i;

/**
 * Returns the EXPLAIN statement to run for the caller's query, or throws with
 * the reason it cannot be planned safely.
 */
export function prepareExplainQuery(input: string): string {
  let query = input.trim();
  const prefix = EXPLAIN_PREFIX.exec(query);
  if (prefix !== null) {
    const options = `${prefix.groups?.options ?? ""} ${prefix.groups?.bare ?? ""}`;
    if (/\banaly[sz]e\b(?!\s+(?:false|off|0)\b)/i.test(options)) {
      throw new Error(
        "EXPLAIN ANALYZE executes the statement; this tool only plans it. Remove ANALYZE (run the statement itself with query_sql or execute_sql if you need actual timings).",
      );
    }
    query = query.slice(prefix[0].length).trim();
  }
  if (query === "") {
    throw new Error(
      "query is empty: pass one SELECT, INSERT, UPDATE, DELETE or WITH statement to plan.",
    );
  }
  if (hasStatementAfterSemicolon(query)) {
    throw new Error(
      "query holds more than one statement; EXPLAIN plans exactly one. Pass the statements one at a time.",
    );
  }
  return `EXPLAIN (COSTS, VERBOSE false, FORMAT TEXT) ${query.replace(/;\s*$/, "")}`;
}

/**
 * True when a `;` outside quotes, dollar-quotes and comments is followed by
 * anything but whitespace or comments.
 */
export function hasStatementAfterSemicolon(query: string): boolean {
  let i = 0;
  const n = query.length;
  while (i < n) {
    const ch = query[i];
    const next = query[i + 1];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(query, i, ch);
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(query.slice(i));
      if (tag !== null) {
        const end = query.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? n : end + tag[0].length;
        continue;
      }
    }
    if (ch === "-" && next === "-") {
      const end = query.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = query.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === ";") {
      return stripTrailingNoise(query.slice(i + 1)) !== "";
    }
    i += 1;
  }
  return false;
}

function skipQuoted(query: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < query.length) {
    if (query[i] === quote) {
      if (query[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return query.length;
}

/** Whitespace and comments only → "". */
function stripTrailingNoise(rest: string): string {
  return rest
    .replaceAll(/--[^\n]*/g, "")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .trim();
}

/** Shapes EXPLAIN's result rows (one `QUERY PLAN` column) into the tool output. */
export function formatExplainResult(result: {
  columns: string[];
  rows: Record<string, unknown>[];
  duration_ms?: number | null;
}): { plan: string; summary: string; duration_ms?: number | null } {
  const column = result.columns[0] ?? "QUERY PLAN";
  const lines = result.rows.map((row) => String(row[column] ?? ""));
  const first = lines[0] ?? "";
  const estimate = /\(cost=([\d.]+)\.\.([\d.]+) rows=(\d+) width=(\d+)\)/.exec(first);
  const summary =
    estimate === null
      ? first
      : `top node: ${first.slice(0, first.indexOf("(cost=")).trim()} - estimated cost ${estimate[2]} (startup ${estimate[1]}), ${estimate[3]} rows, width ${estimate[4]}`;
  return { plan: lines.join("\n"), summary, duration_ms: result.duration_ms };
}
