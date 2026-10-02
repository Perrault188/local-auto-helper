import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentOrchestrator, RuleBasedProvider } from '../engine/index.mjs';

const provider = new RuleBasedProvider();

test('P2-S1高频短句和可枚举错字保持注册内识别', async () => {
  for (const [message, domain, capabilities] of [
    ['收作业', 'education', ['collect']],
    ['发送才料', 'education', ['publish']],
    ['每天收门店日抱', 'retail', ['collect']]
  ]) {
    const result = await provider.infer({ message });
    assert.equal(result.outcome, 'supported', message);
    assert.equal(result.candidates[0].domain, domain, message);
    assert.deepEqual(result.candidates[0].capabilities, capabilities, message);
  }
});

test('P2-S1省略口语追问一个意图，完成体组合可直接识别', async () => {
  const unclear = await provider.infer({ message: '提醒没交的交' });
  assert.equal(unclear.outcome, 'needs_clarification');
  assert.equal(unclear.question, '请确认是只收取，还是收取后提醒未交人员？');
  assert.deepEqual(unclear.candidates.map(item => item.capabilities), [['collect'], ['collect', 'remind']]);
  const complete = await provider.infer({ message: '收完作业后提醒没交的交' });
  assert.equal(complete.outcome, 'supported');
  assert.deepEqual(complete.candidates[0].capabilities, ['collect', 'remind']);
});

test('P2-S1未知动作和对象仍由coverageGuard整体拒绝', async () => {
  const orchestrator = new AgentOrchestrator();
  for (const message of ['收作业并打印', '收完作业后删除原文件', '提醒没交的交并踢出群聊']) {
    const result = await orchestrator.infer({ message, trustedContext: {} });
    assert.equal(result.outcome, 'unsupported', message);
    assert.equal(result.candidates, undefined, message);
  }
});
