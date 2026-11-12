/**
 * A minimal lexical scan of SQL text, enough for the MCP-side input guards
 * (explain_query, execute_sql): it finds the top-level `;` separators and the
 * first keyword of each statement, skipping string literals, quoted
 * identifiers, dollar-quoted bodies and comments the way Postgres's lexer
 * does. It does not parse SQL; the control plane and the database stay the
 * real authority.
 */

/** Characters Postgres allows after the first one in an unquoted identifier. */
const IDENT_CONT = /[A-Za-z0-9_$\u0080-￿]/;
/** A dollar-quote delimiter: `$$` or `$tag$`, where tag is an identifier without `$`. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * Splits text into its top-level statements at `;` outside quotes,
 * dollar-quotes and comments. Each piece keeps its own comments and
 * whitespace; the `;` separators are dropped.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === ";") {
      statements.push(sql.slice(start, i));
      start = i + 1;
      i += 1;
      continue;
    }
    i = skipToken(sql, i);
  }
  statements.push(sql.slice(start));
  return statements;
}

/** True when the text is only whitespace and comments. */
export function isBlank(sql: string): boolean {
  return skipNoise(sql, 0) >= sql.length;
}

/**
 * The statement's first keyword, upper-cased, after leading whitespace and
 * comments - or "" when it does not start with a bare word. The word ends at
 * the first character that is not a letter; when an identifier character
 * other than `$` follows (`DOMAIN`, `do_it`), the word is part of a longer
 * identifier and is returned whole.
 */
export function firstKeyword(statement: string): string {
  const rest = statement.slice(skipNoise(statement, 0));
  const word = /^[A-Za-z]+/.exec(rest)?.[0];
  if (word === undefined) return "";
  const next = rest[word.length];
  if (next !== undefined && next !== "$" && IDENT_CONT.test(next)) {
    return (/^[A-Za-z0-9_$\u0080-￿]+/.exec(rest)?.[0] ?? word).toUpperCase();
  }
  return word.toUpperCase();
}

/** Index of the first character at or after `from` that is not whitespace or inside a comment. */
function skipNoise(sql: string, from: number): number {
  let i = from;
  while (i < sql.length) {
    if (/\s/.test(sql[i] ?? "")) {
      i += 1;
    } else if (sql.startsWith("--", i) || sql.startsWith("/*", i)) {
      i = skipToken(sql, i);
    } else {
      break;
    }
  }
  return i;
}

/**
 * Index just past the token that starts at `i`: a whole quoted string,
 * quoted identifier, dollar-quoted body or comment, a whole unquoted word,
 * or a single other character. An unterminated construct runs to the end.
 */
function skipToken(sql: string, i: number): number {
  const ch = sql[i];
  if (ch === "'") {
    const escapes =
      (sql[i - 1] === "E" || sql[i - 1] === "e") && !IDENT_CONT.test(sql[i - 2] ?? "");
    return skipQuoted(sql, i, "'", escapes);
  }
  if (ch === '"') return skipQuoted(sql, i, '"', false);
  if (ch === "-" && sql[i + 1] === "-") {
    const end = sql.indexOf("\n", i);
    return end === -1 ? sql.length : end + 1;
  }
  if (ch === "/" && sql[i + 1] === "*") return skipBlockComment(sql, i);
  if (ch === "$") {
    const tag = DOLLAR_TAG.exec(sql.slice(i));
    if (tag !== null) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      return end === -1 ? sql.length : end + tag[0].length;
    }
    return i + 1;
  }
  if (ch !== undefined && /[A-Za-z_\u0080-￿]/.test(ch)) {
    // A whole word, so a `$` inside an identifier (`a$b`, `col$q$`) is never read as the start of
    // a dollar quote - Postgres's lexer keeps it in the identifier.
    let end = i + 1;
    while (end < sql.length && IDENT_CONT.test(sql[end] ?? "")) end += 1;
    return end;
  }
  return i + 1;
}

/**
 * Skips a quoted literal or identifier. A doubled quote is an escaped quote;
 * in an `E'...'` string a backslash also escapes the next character.
 */
function skipQuoted(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    if (backslashEscapes && sql[i] === "\\") {
      i += 2;
      continue;
    }
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

/** Skips a block comment; Postgres block comments nest. */
function skipBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql.startsWith("/*", i)) {
      depth += 1;
      i += 2;
    } else if (sql.startsWith("*/", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return sql.length;
}

/**
 * Refuses text in which any statement starts with DO or CALL. A DO block or a
 * procedure can run any number of writes inside one statement, which the
 * control plane's unqualified-write guard cannot see into; through an agent
 * there is no person reading the body first, so the MCP path does not run
 * them at all (owner decision H-09, 2026-11-12). Studio and the CLI still do.
 */
export function refuseDoAndCall(query: string): void {
  for (const statement of splitStatements(query)) {
    const keyword = firstKeyword(statement);
    if (keyword === "DO" || keyword === "CALL") {
      throw new Error(
        `execute_sql does not run ${keyword === "DO" ? "DO blocks" : "CALL statements"}: they can change any number of rows in one statement, which the write guard cannot review. Ask the user to run it from the SQL Studio in the CapyDB dashboard or with \`capydb sql\` in the CapyDB CLI, or issue the individual INSERT/UPDATE/DELETE statements here instead.`,
      );
    }
  }
}
