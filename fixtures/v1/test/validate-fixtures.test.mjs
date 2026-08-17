import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const fixtureDir = dirname(dirname(fileURLToPath(import.meta.url)));
const load = (name) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
const capabilities = load('target-capabilities.json');
const queryStore = load('database-query-store.json');
const atlas = load('atlas-projection.json');
const runtime = load('query-store-runtime.json');
const live = load('live-cases.json');
const evidence = load('cross-database-evidence.json');

const allowedCapabilityStates = new Set(['supported', 'unsupported', 'not-probed', 'permission-denied']);
const jsonFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? jsonFiles(path) : entry.name.endsWith('.json') ? [path] : [];
});
const asTime = (value) => {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `UTC timestamp required: ${value}`);
  assert.ok(Number.isFinite(Date.parse(value)), `valid timestamp required: ${value}`);
  return Date.parse(value);
};

test('fixture documents are versioned, timestamped, and capability states are explicit', () => {
  for (const doc of [capabilities, queryStore, atlas, runtime, live, evidence]) {
    assert.equal(doc.fixtureVersion, '1.0.0');
    assert.match(doc.fixtureId, /^[a-z][a-z0-9-]*-v1$/);
  }
  for (const target of capabilities.targets) {
    assert.equal(typeof target.compatibilityLevel, 'number');
    assert.ok(target.sourceScope);
    assert.ok(target.sourceLimitations.length);
    for (const state of Object.values(target.capabilities)) assert.ok(allowedCapabilityStates.has(state));
  }
  assert.equal(capabilities.targets.length, 5);
});

test('all fixture JSON parses and schemas declare JSON Schema 2020-12', () => {
  for (const path of jsonFiles(fixtureDir)) assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')));
  const schemas = jsonFiles(join(fixtureDir, 'schema')).map((path) => JSON.parse(readFileSync(path, 'utf8')));
  assert.ok(schemas.length >= 2);
  for (const schema of schemas) assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('Query Store state distinguishes OFF, quota read-only, errors, access, and support', () => {
  const byId = Object.fromEntries(queryStore.records.map((row) => [row.recordId, row]));
  assert.equal(byId['qs:off'].actualState, 'OFF');
  assert.equal(byId['qs:quota-readonly'].desiredState, 'READ_WRITE');
  assert.equal(byId['qs:quota-readonly'].actualState, 'READ_ONLY');
  assert.equal(byId['qs:quota-readonly'].reasonCode, 65536);
  assert.equal(byId['qs:error'].actualState, 'ERROR');
  assert.equal(byId['qs:permission-denied'].availability, 'permission-denied');
  assert.equal(byId['qs:unsupported'].availability, 'unsupported');
  for (const row of queryStore.records) {
    asTime(row.observedAt);
    if (row.availability !== 'available') {
      assert.equal(row.actualState, null);
      assert.ok(row.reasonCode);
    }
  }
});

test('atlas preserves allocation ordering, equality, and zero versus unknown', () => {
  assert.deepEqual(atlas.databases.map((db) => db.name), ['master', 'sales', 'ledger', 'warehouse', 'telemetry', 'archive', 'scratch', 'crm']);
  const db = Object.fromEntries(atlas.databases.map((row) => [row.name, row]));
  assert.ok(db.sales.allocatedBytes > db.ledger.allocatedBytes);
  assert.equal(db.ledger.allocatedBytes, db.warehouse.allocatedBytes);
  assert.equal(db.ledger.allocatedKiB, db.warehouse.allocatedKiB);
  assert.equal(db.telemetry.allocationKnowledge, 'zero');
  assert.equal(db.telemetry.allocatedBytes, 0);
  for (const name of ['archive', 'scratch']) {
    assert.equal(db[name].allocationKnowledge, 'unknown');
    assert.equal(db[name].allocatedBytes, null);
    assert.equal(db[name].allocatedKiB, null);
  }
  for (const row of atlas.databases) {
    asTime(row.sourceObservedAt);
    if (row.allocationKnowledge === 'known' || row.allocationKnowledge === 'zero') {
      assert.equal(row.allocatedBytes, row.allocatedKiB * 1024);
    }
  }
});

test('Query Store runtime retains duplicate rows, exact weighted duration, and execution types', () => {
  assert.equal(runtime.activeInterval.rawRows.reduce((sum, row) => sum + row.executions, 0), 47);
  assert.equal(runtime.activeInterval.aggregateExecutions, 47);
  const weightedTotal = runtime.weightedDuration.samples.reduce((sum, row) => sum + row.executions * row.meanDurationMicroseconds, 0);
  const executions = runtime.weightedDuration.samples.reduce((sum, row) => sum + row.executions, 0);
  assert.equal(runtime.weightedDuration.weightedMeanMicroseconds, weightedTotal / executions);
  assert.notEqual(runtime.weightedDuration.weightedMeanMicroseconds, runtime.weightedDuration.naiveMeanMicroseconds);
  assert.equal(runtime.weightedDuration.weightedMeanMicroseconds, 3960.3960396039606);
  assert.deepEqual(Object.fromEntries(runtime.executionTypes.map((row) => [row.executionType, row.executions])), { regular: 120, 'client-aborted': 5, exception: 2 });
  assert.equal(runtime.contextSettings[0].compoundId, runtime.contextSettings[1].compoundId);
});

test('plan recency, failure state, PSP, OPPO, and reset epoch stay distinct', () => {
  const newest = runtime.plans.reduce((latest, plan) => asTime(plan.lastExecutionAt) > asTime(latest.lastExecutionAt) ? plan : latest);
  assert.equal(newest.planId, 2);
  assert.equal(runtime.forcedPlan.state, 'force-failed');
  assert.ok(runtime.forcedPlan.forceFailureCount > 0);
  assert.notEqual(runtime.parameterSensitivePlan.dispatcherPlanId, runtime.optionalParameterPlanOptimization.dispatcherPlanId);
  assert.deepEqual(runtime.optionalParameterPlanOptimization.variants.map((v) => v.predicate), ['@region IS NULL', '@region IS NOT NULL']);
  asTime(runtime.resetEpoch.resetAt);
});

test('live cases separate disappearing requests, unavailable plans, parallel contexts, blockers, and Azure scope', () => {
  const requests = Object.fromEntries(live.requests.map((row) => [row.requestId, row]));
  assert.equal(requests['req:gone'].availability, 'disappeared');
  assert.equal(requests['req:plan-unavailable'].availability, 'available');
  assert.equal(requests['req:plan-unavailable'].planAvailability, 'unavailable');
  const blocking = new Map(live.requests.filter((row) => row.blockingSessionId > 0).map((row) => [row.sessionId, row.blockingSessionId]));
  assert.equal(blocking.get(81), 80);
  assert.equal(blocking.get(82), 81);
  assert.ok(!blocking.has(83), 'negative sentinel must not become a normal blocker edge');
  assert.equal(requests['req:sentinel'].blockingSessionId, -5);
  assert.deepEqual(new Set(live.waitingTasks.map((task) => task.executionContext)), new Set(['coordinator', 'worker']));
  assert.equal(live.azureSqlDatabaseScope.visibilityScope, 'current-database-only');
});

test('cross-database edges carry every confidence with rationale and match atlas edges', () => {
  const confidences = new Set(evidence.evidence.map((row) => row.confidence));
  assert.deepEqual(confidences, new Set(['confirmed', 'probable', 'unknown']));
  for (const row of evidence.evidence) {
    assert.ok(row.rationale.length > 20);
    assert.ok(atlas.edges.some((edge) => edge.fromDatabaseId === row.fromDatabaseId && edge.toDatabaseId === row.toDatabaseId && edge.confidence === row.confidence));
    asTime(row.observedAt);
  }
});

test('fixture content does not resemble production secrets or connection strings', () => {
  const forbidden = [/(?:password|pwd)\s*=/i, /(?:user id|uid)\s*=/i, /server\s*=/i, /data source\s*=/i, /(?:account key|access token|client secret)\s*=/i, /(?:^|[^a-z])(?:jdbc|odbc|sqlserver):/i];
  for (const path of jsonFiles(fixtureDir)) {
    const content = readFileSync(path, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, `${path} matched ${pattern}`);
  }
});
