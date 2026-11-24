// The rules the tool descriptions are held to, shared by the hosted and the
// stdio test. The Claude directory's submission form has the owner attest that
// "tool descriptions contain no instructions about model behavior, other tools,
// or external instruction sources, and no hidden or encoded text". So a
// description states what its tool does, takes and returns - in the third
// person, as fact - and may name another tool only as a fact (the counterpart,
// the tool that returns an id). What to do about those facts is said once, in
// the server's `instructions`.
import assert from "node:assert/strict";

/** Words that address the reader or give an order. */
const DIRECTIVE_WORDS =
  /\b(never|always|do not|don't|must|should|shall|please|you|your|yourself|make sure|be sure|remember)\b/i;
/** Emphasis written as an order. */
const SHOUTED =
  /\b(FIRST|(?<!IF )NOT(?! EXISTS)|NO|ALSO|IRREVERSIBLE|DESTRUCTIVE|WARNING|IMPORTANT|SECRET-BEARING)\b/;
/** A sentence or clause that opens with a bare verb is an order, not a statement. */
const IMPERATIVE_START =
  /(?:^|[.!?:;]\s+|\s-\s|\(\s*)(Use|Call|Poll|Pass|Ask|Tell|Check|Read|Set|Omit|Prefer|Write|Give|Keep|Treat|Wait|Retry|Rank|Report|Point|Compare|Request|Relay|Surface|Look|See|Run|Make|Note|Lower|Choose|Pick|Avoid|Stop|Verify|Confirm|Rehearse|Fall back|Only (?:call|use|choose|do|claim|destroy|rotate|change|update|run))\s/;
/** An order hung on the end of a statement: "..., so get the user's go-ahead first". */
const TRAILING_ORDER =
  /\b(?:so|and|then|but|or|rather than|instead of) (?:(?:only |also )?(?:get|check|use|call|read|ask|tell|fix|re-issue|keep|give|treat|point|retry|report|relay|do|append|address)|only when)\b/;
/** Orders about the user, and the classic prompt-injection disclaimer shape. */
const USER_DIRECTED =
  /\b(?:ask|tell|point|give|show|warn|inform) the user\b|\bthe user's go-ahead\b|\bwhen the user asks\b|\btreat (?:it|them|this|the \w+) as\b|\bas instructions\b/i;
/** Anything outside printable ASCII would be text a reviewer cannot see. */
const NOT_PLAIN = /[^\x20-\x7E]/;

/** snake_case identifiers, skipping the second half of dotted names such as `project.import_started`. */
const IDENTIFIER = /(?<![\w.$@/-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w-])/g;

/**
 * Identifiers a description may use that are neither a tool nor a field of a
 * tool's input or output schema: Postgres names, result fields of tools that
 * declare no output schema, lint rules, alert kinds and enum values. A new
 * snake_case name in a description has to be a real tool or field, or be added
 * here on purpose - which is what catches a description naming a tool that
 * does not exist.
 */
const KNOWN_TERMS = new Set([
  // Postgres and extensions
  "app_user", "pg_catalog", "pg_cron", "pg_dump", "pg_qualstats", "pg_stat_statements",
  "work_mem", "deadlock_timeout",
  // Enum values and states
  "non_production", "org_suspended", "rollback_available", "rolling_back",
  // Result fields of tools without an output schema, and fields the open
  // output schemas pass through without declaring (all in the control plane's
  // OpenAPI document)
  "claim_token", "claim_url", "export_id", "requested_restore_time", "restore_time_clamped",
  "estimated_size_bytes", "estimated_cost_reduction_pct", "drop_statement", "uptime_percent",
  "generic_plan_calls", "custom_plan_calls", "wait_time_ms", "fastpath_exceeded", "do_vacuum",
  "do_analyze", "for_wraparound",
  // Lint rules
  "missing_primary_key", "unindexed_foreign_key", "duplicate_index", "redundant_index",
  "unused_index", "table_bloat",
  // Alert kinds
  "kv_unreachable", "pooler_handshake", "read_only", "cache_hit", "blocked_queries",
  "long_transaction", "oom_kill", "temp_spill",
  // Audit actions (first halves of dotted names)
  "api_key",
]);

function schemaProperties(node, into) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) schemaProperties(item, into);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      for (const name of Object.keys(value)) into.add(name);
    }
    schemaProperties(value, into);
  }
}

function paramDescriptions(node, path, into) {
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" && typeof value === "string") into.push([path, value]);
    else paramDescriptions(value, `${path}.${key}`, into);
  }
}

function unknownIdentifiers(text, known) {
  return [...new Set(text.match(IDENTIFIER) ?? [])].filter((name) => !known.has(name));
}

/**
 * Asserts every tool description, every input and output field description and
 * the server instructions against the rules above. `instructions` are orders by design,
 * so only the tool names in them are checked.
 */
export function assertDescriptionsAreFacts(tools, instructions) {
  const toolNames = new Set(tools.map((tool) => tool.name));
  const known = new Set([...toolNames, ...KNOWN_TERMS]);
  for (const tool of tools) {
    schemaProperties(tool.inputSchema, known);
    schemaProperties(tool.outputSchema, known);
  }

  const problems = [];
  const check = (where, text) => {
    for (const [rule, pattern] of [
      ["a directive word", DIRECTIVE_WORDS],
      ["shouted emphasis", SHOUTED],
      ["an imperative sentence", IMPERATIVE_START],
      ["a trailing order", TRAILING_ORDER],
      ["an order about the user", USER_DIRECTED],
      ["a character outside printable ASCII", NOT_PLAIN],
    ]) {
      const match = pattern.exec(text);
      if (match) problems.push(`${where}: ${rule} (${JSON.stringify(match[0].trim())})`);
    }
    const unknown = unknownIdentifiers(text, known);
    if (unknown.length > 0) problems.push(`${where}: names ${unknown.join(", ")}, which is not a tool or a field`);
  };

  for (const tool of tools) {
    assert.ok(tool.description, `${tool.name} has no description`);
    check(tool.name, tool.description);
    // The first sentence says what the tool does, in the third person.
    if (!/^[A-Z][a-z]+s\b/.test(tool.description)) {
      problems.push(`${tool.name}: does not open with a third-person verb`);
    }
    // Field descriptions travel in tools/list too, in both schemas.
    const fields = [];
    paramDescriptions(tool.inputSchema, `${tool.name} input`, fields);
    paramDescriptions(tool.outputSchema, `${tool.name} output`, fields);
    for (const [path, text] of fields) check(path, text);
  }

  // Every tool the instructions name has to exist on this server.
  assert.equal(typeof instructions, "string");
  const ghostTools = unknownIdentifiers(instructions, known);
  if (ghostTools.length > 0) problems.push(`instructions: names ${ghostTools.join(", ")}`);

  assert.deepEqual(problems, []);
}
