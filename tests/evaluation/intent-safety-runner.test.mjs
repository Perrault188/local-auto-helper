import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIntentGold } from './intent-gold-loader.mjs';
import { runIntentSafetyCases } from './intent-safety-runner.mjs';

test('120条澄清与拒绝样本逐case隔离且确认前后零业务和Mock副作用', async () => {
  const fixture = await loadIntentGold();
  const report = await runIntentSafetyCases(fixture.cases);
  assert.equal(report.caseCount, 120);
  assert.equal(report.predictions.filter(item => item.expectedOutcome === 'unsupported').length, 72);
  assert.equal(report.predictions.filter(item => item.expectedOutcome === 'needs_clarification').length, 48);
  for (const item of report.predictions) {
    assert.equal(item.readyForConfirmation, false, item.caseId);
    assert.equal(item.confirmRejected, true, item.caseId);
    assert.equal(item.sideEffectViolation, false, item.caseId);
    for (const state of [item.beforeConfirm, item.afterConfirm]) {
      assert.deepEqual(Object.keys(state.repositories), ['automations', 'flows', 'attachments', 'resources', 'recordStores', 'entityDirectories', 'runs']);
      assert.deepEqual(Object.keys(state.mock), ['files', 'groupMessages', 'directMessages', 'replies', 'timerEvents']);
      assert.ok(Object.values(state.repositories).every(count => count === 0), item.caseId);
      assert.ok(Object.values(state.mock).every(count => count === 0), item.caseId);
    }
    if (item.expectedOutcome === 'unsupported') assert.equal(item.unsupportedShapeValid, true, item.caseId);
  }
});
