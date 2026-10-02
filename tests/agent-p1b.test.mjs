import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EngineService, RemoteProvider, parseProviderOutput, planHash,
  validateIntentSpec, validatePlanSpec
} from '../engine/index.mjs';

let tick = 0;
const now = () => new Date(Date.parse('2026-07-30T10:00:00+08:00') + tick++ * 1000).toISOString();
const dir = () => mkdtemp(join(tmpdir(), 'local-auto-helper-agent-'));
const educationFacts = {
  taskName: '第8周作业', groupId: 'group_education', publishText: '请按时提交',
  noticeFilePath: '/demo/source/week8.pdf', publishTrigger: 'scheduled', publishAt: '2026-08-01T10:00:00+08:00',
  deadlineAt: '2026-08-05T18:00:00+08:00', remindAt: '2026-08-05T18:00:00+08:00',
  remindText: '请尽快提交', collectRule: { allowedExtensions: ['.pdf'] },
  nameTemplate: '{studentId}_{name}{originalExtension}',
  replyText: '收到，已登记',
  roster: [{ userId: '2000012345', name: '甲', studentId: '20260001' }]
};
const financeFacts = {
  domain: 'finance', taskName: '报销单收件', groupId: 'group_finance',
  collectRule: { allowedExtensions: ['.pdf'], keyword: '单据' },
  nameTemplate: '{studentId}_{name}{originalExtension}',
  submitters: [{ userId: '3000012345', name: '乙', entityId: 'PROJECT01' }]
};
const retailFacts = {
  domain: 'retail', taskName: '门店日报', groupId: 'group_retail',
  collectRule: { allowedExtensions: ['.xlsx'], keyword: '日报' },
  nameTemplate: '{studentId}_{name}{originalExtension}',
  replyText: '日报已登记。',
  stores: [{ ownerUserId: '4000012345', storeName: '一店', storeId: 'STORE01' }],
  deadlineAt: '2026-08-01T18:00:00+08:00', remindAt: '2026-08-01T18:00:00+08:00', remindText: '请提交日报'
};

async function ready(service, message, facts) {
  const draft = await service.agent.create({ conversationId: 'conversation_1' });
  return service.agent.message(draft.draftId, { message, facts });
}

test('IntentSpec与PlanSpec严格拒绝未声明字段', () => {
  assert.throws(() => validateIntentSpec({ specVersion: '1.0', extra: true }), /字段不严格/);
  assert.throws(() => validatePlanSpec({ specVersion: '1.0', extra: true }), /字段不严格/);
});

test('草稿每轮只有一个问题、候选2到4个，确认前不创建业务对象', async () => {
  const service = new EngineService({ dataDir: await dir(), now });
  const draft = await service.agent.create({ conversationId: 'c' });
  const next = await service.agent.message(draft.draftId, { message: '帮我登记一下' });
  assert.equal(next.status, 'awaiting_candidate');
  assert.equal(next.pendingQuestion, null);
  assert.ok(next.candidateUnderstandings.length >= 2 && next.candidateUnderstandings.length <= 4);
  assert.equal((await service.automations.list()).length, 0);
  assert.equal((await service.flows.list()).length, 0);
  service.db.close();
});

test('education、finance、retail确认后使用现有创建链真实落库', async () => {
  const service = new EngineService({ dataDir: await dir(), now });
  for (const [message, facts, domain] of [
    ['帮我发作业、收作业并催交', educationFacts, 'education'],
    ['帮我收报销单', financeFacts, 'finance'],
    ['帮我收门店日报并提醒缺失门店', retailFacts, 'retail']
  ]) {
    const draft = await ready(service, message, facts);
    assert.equal(draft.status, 'ready_for_confirmation');
    const result = await service.agent.confirm(draft.draftId, { revision: draft.revision, planHash: planHash(draft.planSpec) });
    assert.equal(result.draft.status, 'compiled');
    assert.equal((await service.automations.get(result.automationId)).domain, domain);
  }
  assert.equal((await service.automations.list()).length, 3);
  service.db.close();
});

test('finance混合审核付款目标整体unsupported且不静默收窄', async () => {
  const service = new EngineService({ dataDir: await dir(), now });
  const created = await service.agent.create({ conversationId: 'finance_unsupported' });
  const draft = await service.agent.message(created.draftId, {
    conversationId: 'finance_unsupported',
    draftToken: created.draftToken,
    message: '帮我收报销单并自动审核付款',
    trustedContext: financeFacts
  });
  assert.equal(draft.status, 'unsupported');
  assert.equal(draft.planSpec, null);
  assert.equal((await service.automations.list()).length, 0);
  service.db.close();
});

test('confirm绑定revision和hash，重放幂等，错误版本不创建', async () => {
  const service = new EngineService({ dataDir: await dir(), now });
  const draft = await ready(service, '只收文件登记', { ...educationFacts });
  const hash = planHash(draft.planSpec);
  await assert.rejects(service.agent.confirm(draft.draftId, { revision: draft.revision - 1, planHash: hash }), /版本已变化/);
  assert.equal((await service.automations.list()).length, 0);
  const first = await service.agent.confirm(draft.draftId, { revision: draft.revision, planHash: hash });
  const second = await service.agent.confirm(draft.draftId, { revision: draft.revision, planHash: hash });
  assert.equal(second.idempotent, true);
  assert.equal(second.automationId, first.automationId);
  assert.equal((await service.automations.list()).length, 1);
  service.db.close();
});

test('未确认草稿SQLite重启恢复，结构化摘要不保存模型原文或秘密字段', async () => {
  const dataDir = await dir();
  const first = new EngineService({ dataDir, now });
  const draft = await first.agent.create({ conversationId: 'restart' });
  await assert.rejects(first.agent.message(draft.draftId, { message: '帮我收作业', trustedContext: { API_KEY: 'never-store' } }), /未知字段/);
  const next = await first.agent.message(draft.draftId, { message: '帮我收作业' });
  first.db.close();
  const restarted = new EngineService({ dataDir, now });
  const restored = await restarted.agent.get(next.draftId);
  assert.equal(restored.status, 'awaiting_answer');
  assert.doesNotMatch(JSON.stringify(restored), /never-store|API_KEY/);
  restarted.db.close();
});

test('非法、注入和超时provider均降级到规则provider', async () => {
  assert.throws(() => parseProviderOutput({ hook: {}, candidates: [{}, {}] }), /禁止字段/);
  for (const provider of [
    { infer: async () => ({ code: 'rm -rf', candidates: [{}, {}] }) },
    new RemoteProvider({ timeoutMs: 5, request: () => new Promise(() => {}) })
  ]) {
    const service = new EngineService({ dataDir: await dir(), now, intentProvider: provider });
    const draft = await ready(service, '帮我收报销单', financeFacts);
    assert.equal(draft.planSpec.domain, 'finance');
    assert.deepEqual(draft.planSpec.capabilities, ['collect']);
    service.db.close();
  }
});

test('取消草稿后不能继续或确认', async () => {
  const service = new EngineService({ dataDir: await dir(), now });
  const draft = await service.agent.create({ conversationId: 'cancel' });
  const cancelled = await service.agent.cancel(draft.draftId);
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(service.agent.message(draft.draftId, { message: '继续' }), /不能继续修改/);
  await assert.rejects(service.agent.confirm(draft.draftId, { revision: cancelled.revision, planHash: 'x' }), /版本已变化/);
  service.db.close();
});

test('自然语言userAnswer只推进当前pendingQuestion一个字段', async () => {
  const service = new EngineService({ dataDir: await dir(), now });
  const created = await service.agent.create({ conversationId: 'answers' });
  const first = await service.agent.message(created.draftId, { message: '只收文件登记' });
  assert.equal(first.pendingQuestion.field, 'taskName');
  const second = await service.agent.message(created.draftId, { userAnswer: '资料收件' });
  assert.equal(second.planSpec.bindings.taskName, '资料收件');
  assert.equal(second.pendingQuestion.field, 'groupId');
  assert.deepEqual(second.intentSpec.confirmedFacts, ['taskName']);
  service.db.close();
});

test('草稿跨TTL后标记expired，消息和确认失效，取消仍可审计', async () => {
  let at = '2026-07-30T10:00:00+08:00';
  const clock = () => at;
  const dataDir = await dir();
  const first = new EngineService({ dataDir, now: clock, agentTtlMs: 1000 });
  const created = await first.agent.create({ conversationId: 'ttl' });
  first.db.close();
  at = '2026-07-30T10:00:02+08:00';
  const restarted = new EngineService({ dataDir, now: clock, agentTtlMs: 1000 });
  const expired = await restarted.agent.get(created.draftId);
  assert.equal(expired.status, 'expired');
  await assert.rejects(restarted.agent.message(created.draftId, { message: '继续' }), /不能继续修改/);
  await assert.rejects(restarted.agent.confirm(created.draftId, { revision: expired.revision, planHash: 'x' }), /版本已变化/);
  assert.equal((await restarted.agent.cancel(created.draftId)).status, 'cancelled');
  restarted.db.close();
});

test('创建链各落库阶段失败后以稳定ID重试收敛，无重复或孤儿', async () => {
  for (const repoName of ['attachments', 'flows', 'resources', 'entityDirectories', 'recordStores', 'automations']) {
    const service = new EngineService({ dataDir: await dir(), now });
    const draft = await ready(service, '只收文件登记', educationFacts);
    const confirmation = { revision: draft.revision, planHash: planHash(draft.planSpec) };
    const repo = service[repoName];
    const originalSave = repo.save.bind(repo);
    let failed = false;
    repo.save = async value => {
      if (!failed) { failed = true; throw new Error(`injected ${repoName}`); }
      return originalSave(value);
    };
    await assert.rejects(service.agent.confirm(draft.draftId, confirmation), new RegExp(repoName));
    const result = await service.agent.confirm(draft.draftId, confirmation);
    assert.match(result.automationId, /^automation_/);
    assert.equal((await service.automations.list()).length, 1);
    assert.equal((await service.attachments.list()).length, 1);
    assert.equal((await service.flows.list()).length, 1);
    assert.equal((await service.resources.list()).length, 1);
    assert.equal((await service.entityDirectories.list()).length, 1);
    assert.equal((await service.recordStores.list()).length, 1);
    service.db.close();
  }
});

test('确认上下文被篡改时即使重算hash也拒绝', async () => {
  const service = new EngineService({ dataDir: await dir(), now });
  const draft = await ready(service, '只收文件登记', educationFacts);
  draft.planSpec.confirmationContext.draftId = 'agentdraft_other';
  await service.agentDrafts.save(draft);
  await assert.rejects(service.agent.confirm(draft.draftId, {
    revision: draft.revision, planHash: planHash(draft.planSpec)
  }), /确认上下文不匹配/);
  assert.equal((await service.automations.list()).length, 0);
  service.db.close();
});

test('多义表达先等待候选选择，选择后才生成计划且可back', async () => {
  const service = new EngineService({ dataDir: await dir(), now });
  const created = await service.agent.create({ conversationId: 'candidate' });
  const ambiguous = await service.agent.message(created.draftId, { message: '帮我登记一下' });
  assert.equal(ambiguous.status, 'awaiting_candidate');
  assert.equal(ambiguous.planSpec, null);
  assert.equal(ambiguous.candidateUnderstandings.length, 2);
  assert.notEqual(ambiguous.candidateUnderstandings[0].domain, ambiguous.candidateUnderstandings[1].domain);
  const selected = await service.agent.chooseCandidate(created.draftId, { candidateId: ambiguous.candidateUnderstandings[0].candidateId });
  assert.equal(selected.status, 'awaiting_answer');
  assert.deepEqual(selected.planSpec.capabilities, ['collect']);
  const backed = await service.agent.back(created.draftId);
  assert.equal(backed.status, 'awaiting_candidate');
  assert.equal(backed.planSpec, null);
  service.db.close();
});

test('revise只清理允许字段并使确认失效', async () => {
  const service = new EngineService({ dataDir: await dir(), now });
  const draft = await ready(service, '只收文件登记', educationFacts);
  const revised = await service.agent.revise(draft.draftId, { field: 'taskName' });
  assert.equal(revised.status, 'awaiting_answer');
  assert.equal(revised.pendingQuestion.field, 'taskName');
  assert.equal(revised.planSpec.bindings.taskName, undefined);
  assert.equal(revised.confirmedPlanHash, null);
  await assert.rejects(service.agent.revise(draft.draftId, { field: 'domain' }), /不可修改/);
  service.db.close();
});

test('上下文选项不枚举无关联全库，非pending字段返回空', async () => {
  const service = new EngineService({ dataDir: await dir(), now });
  await service.createAutomationTask(educationFacts);
  const created = await service.agent.create({ conversationId: 'options' });
  const options = await service.agent.contextOptions(created.draftId);
  assert.deepEqual(options, []);
  await assert.rejects(service.agent.resolveContextOptions(created.draftId, {}, ['invalid']), /已失效/);
  service.db.close();
});

test('education、finance、retail均可用自然语言和领域隔离demo选项走到待确认', async () => {
  const demoSeed = { group: { name: '教育演示群' }, attachments: [{
    taskAttachmentId: 'task_demo', taskName: '演示作业', groupId: 'group_education_demo',
    sourceFilePath: '/demo/source/assignment.pdf',
    members: [{ userId: '7200012345', name: '演示成员', studentId: 'STUDENT_DEMO' }]
  }] };
  const cases = [
    { conversationId: 'domain_education', message: '只收文件登记', domain: 'education' },
    { conversationId: 'domain_finance', message: '收财务单据', domain: 'finance' },
    { conversationId: 'domain_retail', message: '收门店日报并提醒', domain: 'retail' }
  ];
  for (const item of cases) {
    const service = new EngineService({ dataDir: await dir(), now });
    const created = await service.agent.create({ conversationId: item.conversationId });
    const auth = { conversationId: item.conversationId, draftToken: created.draftToken };
    let draft = await service.agent.message(created.draftId, { ...auth, message: item.message });
    for (let step = 0; draft.status !== 'ready_for_confirmation' && step < 12; step++) {
      const field = draft.pendingQuestion?.field;
      assert.ok(field, `${item.domain}应有待答字段`);
      const options = await service.agent.contextOptions(created.draftId, auth, { demoSeed });
      if (field === 'collectRule' && item.domain === 'finance') {
        assert.deepEqual(options.map(option => option.label), ['PDF/JPG/PNG，文件名包含“单据”', '仅PDF，不限文件名']);
      }
      if (field === 'collectRule' && item.domain === 'retail') {
        assert.deepEqual(options.map(option => option.label), ['DOCX/XLSX/PDF，文件名包含“日报”', '仅XLSX，不限文件名']);
      }
      if (field === 'replyText' && item.domain === 'retail') assert.equal(options.length, 2);
      if (field === 'remindText' && item.domain === 'education') {
        assert.deepEqual(options.map(option => option.label), ['发送“作业还没提交，请尽快补交”', '发送“截止时间已到，请尽快提交作业”']);
      }
      if (field === 'remindText' && item.domain === 'retail') {
        assert.deepEqual(options.map(option => option.label), ['发送“今日日报尚未登记，请尽快提交”', '发送“请尽快补交今日日报”']);
      }
      const option = options[0];
      if (option) {
        const trustedContext = await service.agent.resolveContextOptions(created.draftId, auth, [option.optionId], { demoSeed });
        draft = await service.agent.message(created.draftId, { ...auth, trustedContext });
      } else {
        const answers = {
          taskName: `${item.domain}演示帮办`, remindText: '请及时处理',
          remindAt: '2026-08-10T18:00:00+08:00', deadlineAt: '2026-08-10T18:00:00+08:00'
        };
        assert.ok(answers[field], `${item.domain}.${field}缺少演示回答`);
        draft = await service.agent.message(created.draftId, { ...auth, userAnswer: answers[field] });
      }
    }
    assert.equal(draft.status, 'ready_for_confirmation');
    assert.equal(draft.planSpec.domain, item.domain);
    service.db.close();
  }
});
