import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [path, shape] = process.argv.slice(2);
assert.ok(path && shape, 'usage: validate-smoke-response.mjs <path> <shape>');
const value = JSON.parse(readFileSync(path, 'utf8'));

switch (shape) {
  case 'health':
    assert.equal(value.status, 'healthy');
    break;
  case 'readiness':
    assert.equal(value.status, 'ready');
    break;
  case 'atlas':
    assert.equal(value.schemaVersion, '1.0');
    assert.ok(Array.isArray(value.databases) && value.databases.length > 0);
    break;
  case 'live':
    assert.ok(value.collector && typeof value.collector.state === 'string');
    assert.ok(value.snapshot && value.snapshot.schemaVersion === '1.0');
    break;
  case 'query-store-status':
    assert.equal(value.schemaVersion, '1.0');
    assert.equal(value.state, 'Ready');
    break;
  case 'query-store-queries':
    assert.equal(value.schemaVersion, '1.0');
    assert.ok(Array.isArray(value.items) && value.items.length > 0);
    break;
  case 'findings-status':
    assert.equal(value.schemaVersion, '1.0');
    assert.ok(Array.isArray(value.rules) && value.rules.length > 0);
    break;
  case 'findings-export':
    assert.equal(value.schemaVersion, '1.0');
    assert.ok(Array.isArray(value.findings));
    assert.equal(typeof value.redactionNote, 'string');
    break;
  default:
    assert.fail(`unknown smoke response shape: ${shape}`);
}
