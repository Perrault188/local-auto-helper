import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectIntentDatasetHygiene } from './intent-dataset-hygiene-probe.mjs';

test('规范化与prompt六元重合探针输出稳定结构，不把现状红灯混入npm test', async () => {
  const report = await inspectIntentDatasetHygiene();
  assert.equal(report.schemaVersion, 'intent-dataset-hygiene-v1');
  assert.equal(report.summary.caseCount, 240);
  assert.ok(Array.isArray(report.normalizedDuplicates));
  assert.ok(Array.isArray(report.highestPromptOverlaps));
  assert.ok(Array.isArray(report.excessivePromptOverlap));
});
