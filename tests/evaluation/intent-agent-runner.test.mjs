import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentIntentCases } from './intent-agent-runner.mjs';

test('Agent runner在60+调用后仍增量累计usage且安全overlay与预测同源', async () => {
  const provider = {
    calls: 0,
    audit: [],
    async infer({ message }) {
      this.calls++;
      this.audit.push({ usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });
      if (this.audit.length > 50) this.audit.shift();
      return message.includes('订单')
        ? { outcome: 'unsupported', reasonCode: 'outside_registered_capabilities' }
        : { outcome: 'supported', candidates: [{ domain: 'education', goal: '收作业', capabilities: ['collect'], assumptions: [], confidence: 1 }], question: null };
    }
  };
  const cases = Array.from({ length: 65 }, (_, index) => ({
    caseId: `SYN-${index + 1}`,
    input: { message: index >= 60 ? '创建订单' : '收作业', trustedDomainHint: null },
    gold: { outcome: index >= 60 ? 'unsupported' : 'supported' }
  }));
  const { run, safetyRun } = await runAgentIntentCases(cases, {
    provider, identity: { provider: 'synthetic' }, networkAllowed: false,
    usageAfterCase: () => provider.audit.at(-1).usage
  });
  assert.equal(provider.calls, 65);
  assert.equal(provider.audit.length, 50);
  assert.deepEqual(run.usage, { externalCalls: 65, promptTokens: 65, completionTokens: 130, totalTokens: 195 });
  assert.equal(run.predictions.length, 65);
  assert.equal(safetyRun.predictions.length, 5);
  for (const safety of safetyRun.predictions) assert.equal(safety.sourceCallOrdinal, run.predictions.find(item => item.caseId === safety.caseId).sourceCallOrdinal);
});
