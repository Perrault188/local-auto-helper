import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineService, planHash } from '../engine/index.mjs';

const dir = () => mkdtemp(join(tmpdir(), 'local-auto-helper-agent-b3-api-qa-'));
const fixedNow = () => '2026-07-30T14:00:00+08:00';
const educationFacts = {
  taskName: 'B3安全收件', groupId: 'group_b3',
  deadlineAt: '2026-08-06T18:00:00+08:00',
  collectRule: { allowedExtensions: ['.pdf'] },
  nameTemplate: '{studentId}_{name}{originalExtension}',
  replyText: '收到，已登记',
  roster: [{ userId: '8000012345', name: '测试人', studentId: 'B301' }]
};
const demoSeed = {
  group: { name: 'B3演示群' },
  attachments: [{
    groupId: 'group_b3',
    taskName: 'B3演示任务',
    sourceFilePath: '/demo/source/b3.pdf',
    members: educationFacts.roster
  }]
};

async function createAuth(service, conversationId) {
  const created = await service.agent.create({ conversationId });
  return {
    created,
    auth: { conversationId, draftToken: created.draftToken }
  };
}

test('B3候选必须使用绑定草稿与版本的candidateId，不能只信任数组下标', async () => {
  const service = new EngineService({ dataDir: await dir(), now: fixedNow });
  const { created, auth } = await createAuth(service, 'candidate_id');
  const draft = await service.agent.message(created.draftId, { ...auth, message: '帮我登记一下' });
  assert.equal(draft.status, 'awaiting_candidate');
  for (const candidate of draft.candidateUnderstandings) {
    assert.match(candidate.candidateId, /^[a-f0-9]{24,64}$/);
  }
  service.db.close();
});

test('B3 optionId跨草稿、跨revision及TTL后均失效', async () => {
  let at = '2026-07-30T14:00:00+08:00';
  const clock = () => at;
  const service = new EngineService({ dataDir: await dir(), now: clock, agentTtlMs: 1000 });
  await service.createAutomationTask({ ...educationFacts, domain: 'education', capabilities: ['collect'] });
  const first = await createAuth(service, 'option_first');
  const second = await createAuth(service, 'option_second');
  const inferred = await service.agent.message(first.created.draftId, {
    ...first.auth,
    message: '只收文件登记'
  });
  const named = await service.agent.message(first.created.draftId, {
    ...first.auth,
    userAnswer: 'B3上下文选项任务'
  });
  assert.equal(inferred.pendingQuestion.field, 'taskName');
  assert.equal(named.pendingQuestion.field, 'groupId');
  const option = (await service.agent.contextOptions(first.created.draftId, first.auth, { demoSeed }))
    .find(item => item.field === 'groupId');
  assert.ok(option);

  await assert.rejects(
    service.agent.resolveContextOptions(second.created.draftId, second.auth, [option.optionId], { demoSeed }),
    /失效/
  );

  await service.agent.back(first.created.draftId, first.auth);
  await assert.rejects(
    service.agent.resolveContextOptions(first.created.draftId, first.auth, [option.optionId], { demoSeed }),
    /失效/
  );

  at = '2026-07-30T14:00:02+08:00';
  await assert.rejects(
    service.agent.resolveContextOptions(first.created.draftId, first.auth, [option.optionId], { demoSeed }),
    /过期|不能|失效/
  );
  service.db.close();
});

test('B3 back与revise拒绝跨会话、越权字段、终态和重复调用', async () => {
  const service = new EngineService({ dataDir: await dir(), now: fixedNow });
  const { created, auth } = await createAuth(service, 'owner');
  const ready = await service.agent.message(created.draftId, {
    ...auth, message: '只收文件登记', trustedContext: educationFacts
  });
  const attacker = { conversationId: 'attacker', draftToken: auth.draftToken };
  await assert.rejects(service.agent.back(created.draftId, attacker), /会话不匹配/);
  await assert.rejects(service.agent.revise(created.draftId, { ...attacker, field: 'taskName' }), /会话不匹配/);
  for (const field of ['domain', 'capabilities', 'riskPolicy', 'confirmationContext', '__proto__', 'constructor']) {
    await assert.rejects(service.agent.revise(created.draftId, { ...auth, field }), /不可修改/);
  }

  const confirmation = { ...auth, revision: ready.revision, planHash: planHash(ready.planSpec) };
  await service.agent.confirm(created.draftId, confirmation);
  await assert.rejects(service.agent.back(created.draftId, auth), /安全状态/);
  await assert.rejects(service.agent.revise(created.draftId, { ...auth, field: 'taskName' }), /不可修改/);
  service.db.close();
});

test('B3 revisionHistory不保存用户原文、token或内部确认密钥', async () => {
  const service = new EngineService({ dataDir: await dir(), now: fixedNow });
  const { created, auth } = await createAuth(service, 'history');
  const secretText = 'QA_RAW_MESSAGE_SHOULD_NOT_PERSIST';
  const after = await service.agent.message(created.draftId, { ...auth, message: secretText });
  assert.equal(after.status, 'unsupported');
  const serialized = JSON.stringify(after.revisionHistory);
  assert.doesNotMatch(serialized, /QA_RAW_MESSAGE_SHOULD_NOT_PERSIST/);
  assert.doesNotMatch(serialized, new RegExp(created.draftToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serialized, /draftTokenHash|idempotencyKey|confirmedPlanHash/);
  service.db.close();
});

test('B3 空context options稳定返回空数组，非法option数组和并发重复调用无副作用', async () => {
  const service = new EngineService({ dataDir: await dir(), now: fixedNow });
  const { created, auth } = await createAuth(service, 'empty_options');
  assert.deepEqual(await service.agent.contextOptions(created.draftId, auth), []);
  await assert.rejects(service.agent.resolveContextOptions(created.draftId, auth, 'not-array'), /非法/);
  await assert.rejects(service.agent.resolveContextOptions(created.draftId, auth, Array(21).fill('x')), /非法/);

  const results = await Promise.all([
    service.agent.contextOptions(created.draftId, auth),
    service.agent.contextOptions(created.draftId, auth),
    service.agent.contextOptions(created.draftId, auth)
  ]);
  assert.deepEqual(results, [[], [], []]);
  assert.equal((await service.agentDrafts.get(created.draftId)).revision, 0);
  service.db.close();
});
