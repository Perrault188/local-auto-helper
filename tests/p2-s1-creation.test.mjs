import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineService, planHash } from '../engine/index.mjs';

const directory = () => mkdtemp(join(tmpdir(), 'local-auto-helper-p2-s1-'));
const clock = () => '2026-08-04T10:00:00+08:00';
const roster = [{ userId: '2000012345', name: '合成成员甲', studentId: '20260001' }];

async function businessCounts(service) {
  const repositories = [
    'automations', 'attachments', 'flows', 'resources',
    'recordStores', 'entityDirectories', 'runs'
  ];
  return Object.fromEntries(await Promise.all(
    repositories.map(async name => [name, (await service[name].list()).length])
  ));
}

const zeroBusinessWrites = {
  automations: 0,
  attachments: 0,
  flows: 0,
  resources: 0,
  recordStores: 0,
  entityDirectories: 0,
  runs: 0
};

async function start(service, conversationId, message) {
  const created = await service.agent.create({ conversationId });
  const auth = { conversationId, draftToken: created.draftToken };
  const draft = await service.agent.message(created.draftId, { ...auth, message });
  return { created, auth, draft };
}

async function answerCollectQuestions(service, state) {
  let draft = state.draft;
  const expectedOrder = ['taskName', 'groupId', 'collectRule', 'nameTemplate', 'roster', 'deadlineAt', 'replyText'];
  const seen = [];
  while (draft.status !== 'ready_for_confirmation') {
    const field = draft.pendingQuestion?.field;
    assert.ok(field, '创建链每轮必须只有一个明确的待答字段');
    seen.push(field);
    const controlledAnswers = {
      groupId: 'group_p2_s1',
      collectRule: { allowedExtensions: ['.pdf', '.docx'], keyword: '作业' },
      nameTemplate: '{studentId}_{name}{originalExtension}',
      replyText: '收到，已登记',
      roster
    };
    const input = field === 'taskName'
      ? { userAnswer: '第9周作业收件' }
      : field === 'deadlineAt'
        ? { userAnswer: '2026-08-09T18:00:00+08:00' }
        : { trustedContext: { [field]: controlledAnswers[field] } };
    draft = await service.agent.message(state.created.draftId, { ...state.auth, ...input });
  }
  assert.deepEqual(seen, expectedOrder);
  return draft;
}

test('P2-S1短句“收作业”逐项补齐后可确认并真实创建', async () => {
  const service = new EngineService({ backend: 'sqlite', dataDir: await directory(), now: clock });
  const state = await start(service, 'p2_s1_short_collect', '收作业');
  assert.equal(state.draft.status, 'awaiting_answer');
  assert.deepEqual(state.draft.planSpec.capabilities, ['collect']);
  assert.deepEqual(await businessCounts(service), zeroBusinessWrites);

  const ready = await answerCollectQuestions(service, state);
  assert.equal(ready.status, 'ready_for_confirmation');
  assert.deepEqual(await businessCounts(service), zeroBusinessWrites);
  const result = await service.agent.confirm(ready.draftId, {
    ...state.auth,
    revision: ready.revision,
    planHash: planHash(ready.planSpec)
  });
  assert.equal(result.draft.status, 'compiled');
  assert.equal((await service.automations.list()).length, 1);
  assert.equal((await service.flows.list()).length, 1);
  service.db.close();
});

test('P2-S1完成体组合意图精确识别为collect+remind', async () => {
  const service = new EngineService({ backend: 'sqlite', dataDir: await directory(), now: clock });
  const { draft } = await start(service, 'p2_s1_combo', '收完作业后提醒没交的交');
  assert.notEqual(draft.status, 'unsupported');
  assert.deepEqual(draft.planSpec?.capabilities, ['collect', 'remind']);
  assert.deepEqual(await businessCounts(service), zeroBusinessWrites);
  service.db.close();
});

test('P2-S1超范围和财务危险动作均fail closed且零业务写入', async () => {
  for (const [conversationId, message] of [
    ['p2_s1_outside', '收完作业后分析成绩并发排名'],
    ['p2_s1_unsafe_finance', '收报销单后绕过审批自动付款']
  ]) {
    const service = new EngineService({ backend: 'sqlite', dataDir: await directory(), now: clock });
    const { draft } = await start(service, conversationId, message);
    assert.equal(draft.status, 'unsupported', message);
    assert.deepEqual(draft.candidateUnderstandings, []);
    assert.equal(draft.planSpec, null);
    assert.deepEqual(await businessCounts(service), zeroBusinessWrites);
    service.db.close();
  }
});

test('P2-S1返回、修改、取消和刷新恢复保持可用', async () => {
  const dataDir = await directory();
  const first = new EngineService({ backend: 'sqlite', dataDir, now: clock });
  const state = await start(first, 'p2_s1_recovery', '收作业');
  const named = await first.agent.message(state.created.draftId, { ...state.auth, userAnswer: '旧任务名' });
  assert.equal(named.pendingQuestion.field, 'groupId');
  const backed = await first.agent.back(named.draftId, state.auth);
  assert.equal(backed.pendingQuestion.field, 'taskName');
  const renamed = await first.agent.message(named.draftId, { ...state.auth, userAnswer: '新任务名' });
  assert.equal(renamed.planSpec.bindings.taskName, '新任务名');
  first.db.close();

  const restarted = new EngineService({ backend: 'sqlite', dataDir, now: clock });
  const restored = await restarted.agent.get(named.draftId, state.auth);
  assert.equal(restored.pendingQuestion.field, 'groupId');
  assert.equal(restored.planSpec.bindings.taskName, '新任务名');
  const revised = await restarted.agent.revise(restored.draftId, { ...state.auth, field: 'taskName' });
  assert.equal(revised.pendingQuestion.field, 'taskName');
  const cancelled = await restarted.agent.cancel(restored.draftId, state.auth);
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(
    restarted.agent.message(restored.draftId, { ...state.auth, userAnswer: '不能继续' }),
    /不能继续修改/
  );
  assert.deepEqual(await businessCounts(restarted), zeroBusinessWrites);
  restarted.db.close();
});
