import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIntentGoldFixture } from './intent-gold-schema.mjs';
import { loadIntentGold } from './intent-gold-loader.mjs';

test('P2-M0意图金标Schema、配比、registry组合与cluster隔离严格有效', async () => {
  const fixture = await loadIntentGold();
  const result = validateIntentGoldFixture(fixture);
  assert.equal(result.caseCount, 240);
  assert.deepEqual(result.splitCounts, { dev: 144, validation: 48, holdout: 48 });
  assert.deepEqual(result.outcomeCounts, { supported: 120, needs_clarification: 48, unsupported: 72 });
  assert.deepEqual(result.supportedDomains, { education: 72, finance: 16, retail: 32 });
  assert.deepEqual(result.clarificationCounts, { domain_ambiguity: 12, capability_ambiguity: 12, missing_object: 12, typo_uncertain: 12 });
  assert.deepEqual(result.unsupportedCounts, { out_of_scope: 18, injection: 18, mixed_operation: 18, unsafe_finance: 18 });
  assert.equal(result.clusterCount, 120);
  assert.equal(result.crossSplitClusters, 0);
});
