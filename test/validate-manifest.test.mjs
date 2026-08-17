// Validation for the sql/ probe catalog.
//
// This suite is dependency-free (built-in node:test + node:assert only) and:
//   1. Unit-tests the sqlGuard library directly against synthetic strings (true positive/negative
//      cases), so the guard logic itself is proven correct rather than assumed.
//   2. Loads sql/manifest.json and checks structural completeness.
//   3. For every manifest entry, loads its referenced .sql file and checks: the file exists,
//      declared parameters exactly match the parameters actually referenced in the file, no
//      forbidden mutating/dynamic-SQL tokens appear, a SELECT/CTE result path exists, and
//      version-variant probes carry explicit version-applicability text.
//   4. Confirms every .sql file under sql/probes/ is referenced by exactly one manifest entry.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  stripSqlComments,
  extractParameterNames,
  findForbiddenTokens,
  hasSelectResultPath,
  splitStatements,
} from './lib/sqlGuard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const sqlDir = path.join(repoRoot, 'sql');
const manifestPath = path.join(sqlDir, 'manifest.json');

function loadManifest() {
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw);
}

function listSqlFilesRecursive(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...listSqlFilesRecursive(full));
    } else if (entry.endsWith('.sql')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 1. Unit tests for the guard library itself (synthetic strings, not real probe files).
// ---------------------------------------------------------------------------

describe('sqlGuard: stripSqlComments', () => {
  test('removes line comments', () => {
    const out = stripSqlComments('SELECT 1 -- trailing comment\nFROM t');
    assert.ok(!out.includes('trailing comment'));
    assert.ok(out.includes('SELECT 1'));
    assert.ok(out.includes('FROM t'));
  });

  test('removes block comments spanning multiple lines', () => {
    const out = stripSqlComments('SELECT 1 /* block\ncomment\nspanning lines */ FROM t');
    assert.ok(!out.includes('block'));
    assert.ok(!out.includes('spanning'));
    assert.ok(out.includes('SELECT 1'));
    assert.ok(out.includes('FROM t'));
  });

  test('does not strip -- inside a string literal', () => {
    const out = stripSqlComments("SELECT 'a--b' AS x");
    assert.ok(out.includes("'a--b'"), 'string literal content must survive comment stripping');
  });

  test('handles escaped quotes inside string literals', () => {
    const out = stripSqlComments("SELECT 'it''s -- not a comment' AS x FROM t");
    assert.ok(out.includes('FROM t'));
    assert.ok(out.includes("it''s -- not a comment"));
  });
});

describe('sqlGuard: extractParameterNames', () => {
  test('extracts simple named parameters', () => {
    const names = extractParameterNames('SELECT * FROM t WHERE a = @Foo AND b = @Bar');
    assert.deepEqual([...names].sort(), ['@Bar', '@Foo']);
  });

  test('excludes system/session variables (@@ prefix)', () => {
    const names = extractParameterNames('SELECT @@VERSION, @@ROWCOUNT, @Real');
    assert.deepEqual([...names], ['@Real']);
  });

  test('deduplicates repeated references', () => {
    const names = extractParameterNames('WHERE a = @X OR b = @X OR c = @X');
    assert.deepEqual([...names], ['@X']);
  });

  test('ignores parameters mentioned only in comments', () => {
    const names = extractParameterNames('-- uses @NotReal in a comment\nSELECT 1');
    assert.deepEqual([...names], []);
  });
});

describe('sqlGuard: findForbiddenTokens', () => {
  const forbiddenExamples = [
    ['ALTER DATABASE x SET QUERY_STORE = OFF', 'ALTER statement'],
    ['DBCC FREEPROCCACHE', 'DBCC command'],
    ['EXEC sp_who', 'EXEC/EXECUTE statement'],
    ['EXECUTE sp_who', 'EXEC/EXECUTE statement'],
    ["INSERT INTO t VALUES (1)", 'INSERT statement'],
    ['UPDATE t SET a = 1', 'UPDATE statement'],
    ['DELETE FROM t', 'DELETE statement'],
    ['MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN UPDATE SET a=1', 'MERGE statement'],
    ['TRUNCATE TABLE t', 'TRUNCATE statement'],
    ['CREATE TABLE t (a INT)', 'CREATE statement'],
    ['DROP TABLE t', 'DROP statement'],
    ['GRANT SELECT ON t TO u', 'GRANT statement'],
    ['DENY SELECT ON t TO u', 'DENY statement'],
    ['REVOKE SELECT ON t FROM u', 'REVOKE statement'],
    ['USE msdb', 'USE statement'],
    ["EXEC sp_executesql N'SELECT 1'", 'sp_executesql (dynamic SQL)'],
    ["SELECT * FROM OPENROWSET('SQLNCLI', 'a', 'b')", 'OPENROWSET/OPENQUERY/OPENDATASOURCE'],
    ['EXEC sp_query_store_force_plan 1, 2', 'Query Store administrative procedure'],
    ['ALTER DATABASE x SET QUERY_STORE CLEAR', 'Query Store CLEAR/force/flush maintenance'],
    ['EXEC master..xp_cmdshell \'dir\'', 'xp_cmdshell'],
  ];

  for (const [sql, expectedName] of forbiddenExamples) {
    test(`flags: ${expectedName}`, () => {
      const hits = findForbiddenTokens(sql);
      assert.ok(hits.includes(expectedName), `expected [${hits}] to include '${expectedName}'`);
    });
  }

  test('does not flag a plain read-only SELECT', () => {
    const sql = `
      SET NOCOUNT ON;
      SELECT s.session_id, s.status
      FROM sys.dm_exec_sessions AS s
      WHERE s.is_user_process = 1;
    `;
    assert.deepEqual(findForbiddenTokens(sql), []);
  });

  test('does not false-positive on words that merely contain a forbidden token', () => {
    // "execution_count", "created_at" (hypothetical alias) and "database_id" must not trip
    // EXEC/CREATE/USE just because the raw substring appears inside a longer identifier.
    const sql = `
      SELECT execution_count, count_executions, database_id, capture_policy_execution_count
      FROM sys.query_store_runtime_stats;
    `;
    assert.deepEqual(findForbiddenTokens(sql), []);
  });

  test('does not flag a forbidden keyword that only appears inside a comment', () => {
    const sql = '-- DROP TABLE would be forbidden if uncommented\nSELECT 1';
    assert.deepEqual(findForbiddenTokens(sql), []);
  });
});

describe('sqlGuard: hasSelectResultPath', () => {
  test('accepts SET + SELECT', () => {
    const result = hasSelectResultPath('SET NOCOUNT ON; SELECT 1;');
    assert.equal(result.ok, true);
  });

  test('accepts a leading CTE (WITH ... SELECT)', () => {
    const result = hasSelectResultPath('SET NOCOUNT ON; WITH c AS (SELECT 1 AS a) SELECT a FROM c;');
    assert.equal(result.ok, true);
  });

  test('accepts multiple independent SELECT result sets', () => {
    const result = hasSelectResultPath('SET NOCOUNT ON; SELECT 1; SELECT 2;');
    assert.equal(result.ok, true);
  });

  test('rejects a file with only SET statements and no SELECT', () => {
    const result = hasSelectResultPath('SET NOCOUNT ON; SET LOCK_TIMEOUT 5000;');
    assert.equal(result.ok, false);
  });

  test('rejects a non-SELECT top-level statement', () => {
    const result = hasSelectResultPath('SET NOCOUNT ON; UPDATE t SET a = 1;');
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 2. Manifest structural checks.
// ---------------------------------------------------------------------------

const manifest = loadManifest();

describe('manifest.json structure', () => {
  test('parses and has a manifestVersion', () => {
    assert.equal(typeof manifest.manifestVersion, 'number');
  });

  test('has at least one probe', () => {
    assert.ok(Array.isArray(manifest.probes));
    assert.ok(manifest.probes.length > 0);
  });

  test('every probe has required fields', () => {
    const requiredFields = [
      'id',
      'title',
      'file',
      'connectionScope',
      'minPlatform',
      'azureSqlDatabase',
      'requiredPermission',
      'cadenceClass',
      'parameters',
      'resultSets',
      'resultContract',
      'relativeCost',
    ];
    for (const probe of manifest.probes) {
      for (const field of requiredFields) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(probe, field),
          `probe '${probe.id ?? '<unknown>'}' is missing field '${field}'`,
        );
      }
    }
  });

  test('probe ids are unique', () => {
    const ids = manifest.probes.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate probe id found');
  });

  test('probe files are unique (one probe per file)', () => {
    const files = manifest.probes.map((p) => p.file);
    assert.equal(new Set(files).size, files.length, 'duplicate probe file reference found');
  });

  test('connectionScope is one of the documented scopes', () => {
    const validScopes = new Set(Object.keys(manifest.connectionScopes));
    for (const probe of manifest.probes) {
      assert.ok(
        validScopes.has(probe.connectionScope),
        `probe '${probe.id}' has undocumented connectionScope '${probe.connectionScope}'`,
      );
    }
  });

  test('cadenceClass is one of the documented classes', () => {
    const validClasses = new Set(Object.keys(manifest.cadenceClasses));
    for (const probe of manifest.probes) {
      assert.ok(
        validClasses.has(probe.cadenceClass),
        `probe '${probe.id}' has undocumented cadenceClass '${probe.cadenceClass}'`,
      );
    }
  });

  test('relativeCost is one of the documented costs', () => {
    const validCosts = new Set(Object.keys(manifest.relativeCosts));
    for (const probe of manifest.probes) {
      assert.ok(
        validCosts.has(probe.relativeCost),
        `probe '${probe.id}' has undocumented relativeCost '${probe.relativeCost}'`,
      );
    }
  });

  test('azureSqlDatabase.unsupported is boolean with notes', () => {
    for (const probe of manifest.probes) {
      assert.equal(typeof probe.azureSqlDatabase.unsupported, 'boolean', `probe '${probe.id}'`);
      assert.equal(typeof probe.azureSqlDatabase.notes, 'string', `probe '${probe.id}'`);
      assert.ok(probe.azureSqlDatabase.notes.length > 0, `probe '${probe.id}' has empty Azure SQL DB notes`);
    }
  });

  test('every parameter declares name, sqlDbType, required, and description', () => {
    for (const probe of manifest.probes) {
      for (const param of probe.parameters) {
        assert.match(param.name, /^@[A-Za-z_][A-Za-z0-9_]*$/, `probe '${probe.id}' parameter name`);
        assert.equal(typeof param.sqlDbType, 'string', `probe '${probe.id}' param '${param.name}' sqlDbType`);
        assert.equal(typeof param.required, 'boolean', `probe '${probe.id}' param '${param.name}' required`);
        assert.equal(typeof param.description, 'string', `probe '${probe.id}' param '${param.name}' description`);
        assert.ok(param.description.length > 0, `probe '${probe.id}' param '${param.name}' has empty description`);
        if (param.required === false) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(param, 'default'),
            `probe '${probe.id}' optional param '${param.name}' must declare a default`,
          );
        }
      }
    }
  });

  test('version-variant probes declare versionVariantNotes', () => {
    for (const probe of manifest.probes) {
      if (Object.prototype.hasOwnProperty.call(probe, 'versionVariantOf')) {
        assert.equal(
          typeof probe.versionVariantNotes,
          'string',
          `probe '${probe.id}' declares versionVariantOf but no versionVariantNotes`,
        );
        assert.ok(probe.versionVariantNotes.length > 0, `probe '${probe.id}' has empty versionVariantNotes`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Per-probe file checks: existence, parameter matching, forbidden tokens, SELECT path,
//    version-variant header text.
// ---------------------------------------------------------------------------

describe('every manifest probe file', () => {
  for (const probe of manifest.probes) {
    describe(`${probe.id} (${probe.file})`, () => {
      const filePath = path.join(sqlDir, probe.file);

      test('file exists under sql/', () => {
        assert.ok(statSync(filePath, { throwIfNoEntry: false }), `${probe.file} does not exist`);
      });

      // Skip remaining checks for a missing file rather than throwing an unhelpful ENOENT
      // out of every subsequent test in this block.
      if (!statSync(filePath, { throwIfNoEntry: false })) {
        return;
      }

      const source = readFileSync(filePath, 'utf8');

      test('declared parameters exactly match parameters referenced in the file', () => {
        const declared = new Set(probe.parameters.map((p) => p.name));
        const referenced = extractParameterNames(source);

        const missingFromFile = [...declared].filter((n) => !referenced.has(n));
        const undeclaredInManifest = [...referenced].filter((n) => !declared.has(n));

        assert.deepEqual(
          missingFromFile,
          [],
          `manifest declares ${JSON.stringify(missingFromFile)} but file never references them`,
        );
        assert.deepEqual(
          undeclaredInManifest,
          [],
          `file references ${JSON.stringify(undeclaredInManifest)} but manifest does not declare them`,
        );
      });

      test('contains no forbidden mutating/dynamic-SQL tokens', () => {
        const hits = findForbiddenTokens(source);
        assert.deepEqual(hits, [], `forbidden tokens found: ${hits.join(', ')}`);
      });

      test('has a static SELECT/CTE result path (plus only safe SET statements)', () => {
        const result = hasSelectResultPath(source);
        assert.ok(result.ok, result.reason);
      });

      test('declares safe session settings (NOCOUNT, DEADLOCK_PRIORITY LOW, bounded LOCK_TIMEOUT)', () => {
        const stripped = stripSqlComments(source);
        assert.match(stripped, /SET\s+NOCOUNT\s+ON/i, 'missing SET NOCOUNT ON');
        assert.match(stripped, /SET\s+DEADLOCK_PRIORITY\s+LOW/i, 'missing SET DEADLOCK_PRIORITY LOW');
        assert.match(stripped, /SET\s+LOCK_TIMEOUT\s+\d+/i, 'missing bounded SET LOCK_TIMEOUT <ms>');
      });

      test('does not default to READ UNCOMMITTED / NOLOCK without explicit justification', () => {
        const stripped = stripSqlComments(source);
        const usesReadUncommitted = /READ\s+UNCOMMITTED|\bNOLOCK\b/i.test(stripped);
        if (usesReadUncommitted) {
          // If a probe ever does need it, the *file itself* (not just the manifest) must say why.
          assert.match(
            source,
            /READ UNCOMMITTED|NOLOCK/i,
            `${probe.file} uses relaxed isolation without an inline justification comment`,
          );
          assert.match(
            source,
            /because|since|safe to read dirty|acceptable/i,
            `${probe.file} uses relaxed isolation but its comment does not document why it is acceptable`,
          );
        }
      });

      test('result set count matches manifest resultSets (top-level SELECT/WITH statements)', () => {
        const statements = splitStatements(source);
        const selectLikeCount = statements.filter((s) => /^\s*(SELECT|WITH)\b/i.test(s)).length;
        assert.equal(
          selectLikeCount,
          probe.resultSets,
          `manifest says resultSets=${probe.resultSets} but file has ${selectLikeCount} SELECT/WITH statements`,
        );
      });

      test('does not eagerly fetch plan XML via sys.dm_exec_query_plan', () => {
        assert.doesNotMatch(
          stripSqlComments(source),
          /dm_exec_query_plan/i,
          `${probe.file} calls sys.dm_exec_query_plan; per design this catalog never fetches plan XML eagerly`,
        );
      });

      if (Object.prototype.hasOwnProperty.call(probe, 'versionVariantOf')) {
        test('version-variant file header states its version/platform applicability', () => {
          const headerText = source.slice(0, 1200);
          assert.match(
            headerText,
            /SQL Server 20\d\d|SQL2\d\d\d|2022\+|2019\+|2016\+|2017\+/,
            `${probe.file} is a version variant but its header does not state an explicit version/platform`,
          );
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. No orphan .sql files: every file under sql/probes/ is referenced by exactly one probe.
// ---------------------------------------------------------------------------

test('every .sql file under sql/probes/ is referenced by exactly one manifest probe', () => {
  const probesDir = path.join(sqlDir, 'probes');
  const allFiles = listSqlFilesRecursive(probesDir).map((f) => path.relative(sqlDir, f).split(path.sep).join('/'));
  const manifestFiles = new Set(manifest.probes.map((p) => p.file));

  const orphans = allFiles.filter((f) => !manifestFiles.has(f));
  assert.deepEqual(orphans, [], `orphan .sql files not referenced by manifest.json: ${orphans.join(', ')}`);

  const missing = [...manifestFiles].filter((f) => !allFiles.includes(f));
  assert.deepEqual(missing, [], `manifest references files that do not exist: ${missing.join(', ')}`);
});
