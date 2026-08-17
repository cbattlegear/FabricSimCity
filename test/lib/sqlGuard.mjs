// Shared validation helpers for the sql/ probe catalog.
//
// These are intentionally small, dependency-free, and pure (no filesystem access) so they can be
// unit-tested directly against synthetic strings, in addition to being applied to every real
// probe file under sql/probes/.

/**
 * Strip SQL line comments (`-- ...`) and block comments (`/* ... *\/`) from T-SQL source text.
 * Comment markers inside single-quoted string literals are preserved as literal text (not treated
 * as comment starts), since none of this repository's probes need that edge case handled more
 * thoroughly, but getting it minimally right keeps the stripped output trustworthy for scanning.
 * @param {string} sql
 * @returns {string}
 */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  const len = sql.length;
  let inString = false;

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inString) {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === "'") {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === "'") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-') {
      while (i < len && sql[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Extract the set of named SqlParameter placeholders (`@Name`) referenced in T-SQL source text,
 * excluding system/session variables (`@@VERSION`, `@@ROWCOUNT`, ...).
 * @param {string} sql
 * @returns {Set<string>}
 */
export function extractParameterNames(sql) {
  const stripped = stripSqlComments(sql);
  const names = new Set();
  const re = /(?<!@)@([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = re.exec(stripped)) !== null) {
    names.add(`@${match[1]}`);
  }
  return names;
}

/**
 * Forbidden-token rules. Each entry's regex is matched, word-bounded and case-insensitive,
 * against comment-stripped SQL text. Any match means the probe file must be rejected.
 */
export const FORBIDDEN_PATTERNS = [
  { name: 'ALTER statement', regex: /\bALTER\b/i },
  { name: 'DBCC command', regex: /\bDBCC\b/i },
  { name: 'EXEC/EXECUTE statement', regex: /\bEXEC(UTE)?\b/i },
  { name: 'INSERT statement', regex: /\bINSERT\b/i },
  { name: 'UPDATE statement', regex: /\bUPDATE\b/i },
  { name: 'DELETE statement', regex: /\bDELETE\b/i },
  { name: 'MERGE statement', regex: /\bMERGE\b/i },
  { name: 'TRUNCATE statement', regex: /\bTRUNCATE\b/i },
  { name: 'CREATE statement', regex: /\bCREATE\b/i },
  { name: 'DROP statement', regex: /\bDROP\b/i },
  { name: 'GRANT statement', regex: /\bGRANT\b/i },
  { name: 'DENY statement', regex: /\bDENY\b/i },
  { name: 'REVOKE statement', regex: /\bREVOKE\b/i },
  { name: 'USE statement', regex: /\bUSE\b/i },
  { name: 'sp_executesql (dynamic SQL)', regex: /\bsp_executesql\b/i },
  { name: 'OPENROWSET/OPENQUERY/OPENDATASOURCE', regex: /\bOPEN(ROWSET|QUERY|DATASOURCE)\b/i },
  { name: 'Query Store administrative procedure', regex: /\bsp_query_store_\w+/i },
  { name: 'Query Store CLEAR/force/flush maintenance', regex: /QUERY_STORE\s*(CLEAR|=\s*OFF)/i },
  { name: 'xp_cmdshell', regex: /\bxp_cmdshell\b/i },
];

/**
 * Scan comment-stripped SQL text for forbidden tokens.
 * @param {string} sql
 * @returns {string[]} names of forbidden patterns found (empty when clean)
 */
export function findForbiddenTokens(sql) {
  const stripped = stripSqlComments(sql);
  const hits = [];
  for (const { name, regex } of FORBIDDEN_PATTERNS) {
    if (regex.test(stripped)) hits.push(name);
  }
  return hits;
}

/**
 * Split comment-stripped SQL text into top-level statements on `;` boundaries. This is a naive
 * splitter (no awareness of `;` inside string literals), which is acceptable because
 * stripSqlComments has already removed comments and none of this catalog's probes contain a
 * semicolon inside a string literal.
 * @param {string} sql
 * @returns {string[]}
 */
export function splitStatements(sql) {
  return stripSqlComments(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Verify that every top-level statement is either a safe `SET` session option or begins a
 * `SELECT`/`WITH` (CTE) result path, and that at least one `SELECT` is present. This enforces
 * "static SELECT/CTE/APPLY plus safe session SET statements only" at the statement-shape level,
 * not just by absence of forbidden keywords.
 * @param {string} sql
 * @returns {{ ok: boolean, reason?: string }}
 */
export function hasSelectResultPath(sql) {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return { ok: false, reason: 'no statements found' };
  }

  let sawSelect = false;
  for (const statement of statements) {
    const firstWordMatch = statement.match(/^\s*([A-Za-z_]+)/);
    const firstWord = firstWordMatch ? firstWordMatch[1].toUpperCase() : '';

    if (firstWord === 'SET') continue;
    if (firstWord === 'SELECT' || firstWord === 'WITH') {
      sawSelect = true;
      continue;
    }

    return { ok: false, reason: `unexpected statement type '${firstWord || statement.slice(0, 20)}'` };
  }

  if (!sawSelect) {
    return { ok: false, reason: 'no SELECT/WITH statement found' };
  }

  return { ok: true };
}
