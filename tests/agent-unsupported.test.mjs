import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EngineService,
  normalizeAgentDraftDocument,
  parseProviderOutput,
  planHash,
  validateAgentDraft
} from '../engine/index.mjs';

const at = '2026-07-31T10:00:00+08:00';
const serviceAt = async provider => new EngineService({
  dataDir: await mkdtemp(join(tmpdir(), 'local-auto-helper-unsupported-')),
  now: () => at,
  intentProvider: provider
});
const authFor = async (service, conversationId) => {
  const created = await service.agent.create({ conversationId });
  return { created, auth: { conversationId, draftToken: created.draftToken } };
};

test('provider结果严格区分supported、needs_clarification与unsupported并兼容旧候选格式', () => {
  const candidate = { domain: 'education', goal: '收文件', capabilities: ['collect'], assumptions: [], confidence: 0.8 };
  assert.equal(parseProviderOutput({ outcome: 'supported', candidates: [candidate], question: null }).outcome, 'supported');
  assert.equal(parseProviderOutput({ outcome: 'needs_clarification', candidates: [candidate, { ...candidate, goal: '收文件并提醒', capabilities: ['collect', 'remind'] }], question: null }).outcome, 'needs_clarification');
  assert.equal(parseProviderOutput({ outcome: 'unsupported', reasonCode: 'outside_registered_capabilities' }).outcome, 'unsupported');
  assert.equal(parseProviderOutput({ candidates: [candidate], question: null }).outcome, 'supported');
  assert.throws(() => parseProviderOutput({ outcome: 'unsupported', reasonCode: 'outside_registered_capabilities', candidates: [candidate] }), /字段非法/);
});

test('超出注册能力的请求进入unsupported且不能候选、确认或编译', async () => {
  const service = await serviceAt();
  const { created, auth } = await authFor(service, 'unsupported_zero_write');
  const draft = await service.agent.message(created.draftId, {
    ...auth,
    message: '把群里的号码和金额整理成待确认订单'
  });
  assert.equal(draft.status, 'unsupported');
  assert.deepEqual(draft.candidateUnderstandings, []);
  assert.equal(draft.planSpec, null);
  assert.equal(draft.pendingQuestion, null);
  assert.equal(draft.unsupportedResult.reasonCode, 'insufficient_supported_evidence');
  await assert.rejects(service.agent.chooseCandidate(draft.draftId, { ...auth, candidateId: 'a'.repeat(32) }), /不能选择候选/);
  await assert.rejects(service.agent.confirm(draft.draftId, { ...auth, revision: draft.revision, planHash: 'x' }), /版本已变化/);
  assert.equal((await service.automations.list()).length, 0);
  assert.equal((await service.flows.list()).length, 0);
  assert.equal((await service.recordStores.list()).length, 0);
});

test('支持动作混入未覆盖动作时整体unsupported，不能静默收窄', async () => {
  const service = await serviceAt();
  const { created, auth } = await authFor(service, 'mixed_unsupported');
  const draft = await service.agent.message(created.draftId, {
    ...auth,
    message: '收报销单并自动付款'
  });
  assert.equal(draft.status, 'unsupported');
  assert.equal(draft.unsupportedResult.reasonCode, 'mixed_supported_and_unsupported_operations');
  assert.equal((await service.automations.list()).length, 0);
});

test('领域不明但命中注册动作时进入needs_clarification，不强行默认领域', async () => {
  const service = await serviceAt();
  const { created, auth } = await authFor(service, 'needs_clarification');
  const draft = await service.agent.message(created.draftId, { ...auth, message: '帮我登记一下' });
  assert.equal(draft.status, 'awaiting_candidate');
  assert.equal(draft.candidateUnderstandings.length, 2);
  assert.deepEqual(new Set(draft.candidateUnderstandings.map(item => item.domain)), new Set(['education', 'finance']));
  assert.equal(draft.planSpec, null);
});

test('局部命中文件和通知但包含未注册操作时仍整体unsupported', async () => {
  const service = await serviceAt();
  const { created, auth } = await authFor(service, 'mixed_print');
  const draft = await service.agent.message(created.draftId, {
    ...auth,
    message: '收到文件后直接打印并通知取件'
  });
  assert.equal(draft.status, 'unsupported');
  assert.equal((await service.automations.list()).length, 0);
  assert.equal((await service.flows.list()).length, 0);
});

test('正向语法完整消费已注册请求，反例含未消费片段时fail closed', async () => {
  for (const message of [
    '帮我收报销单并放进待审核清单',
    '帮我发通知',
    '发作业并收作业',
    '不用审核，只收单据',
    '收完放进待审核清单'
  ]) {
    const service = await serviceAt();
    const { created, auth } = await authFor(service, `positive_${message}`);
    const draft = await service.agent.message(created.draftId, { ...auth, message });
    assert.notEqual(draft.status, 'unsupported', message);
    service.db.close();
  }
  for (const message of [
    '收报销单并建订单',
    '收报销单后创建订单',
    '收文件后归档到云盘'
  ]) {
    const service = await serviceAt();
    const { created, auth } = await authFor(service, `negative_${message}`);
    const draft = await service.agent.message(created.draftId, { ...auth, message });
    assert.equal(draft.status, 'unsupported', message);
    assert.deepEqual(draft.candidateUnderstandings, []);
    service.db.close();
  }
});

for (const [index, message] of [
  '请每天收门店日报并提醒没交的店',
  '麻烦每天收门店日报',
  '帮我收一下作业',
  '请帮我收一下作业',
  '帮我把作业收一下',
  '帮我收作业？',
  '麻烦发个通知',
  '收一下报销单'
].entries()) {
  test(`表层归一化正例${index + 1}完整进入注册语法 ${message}`, async () => {
    const service = await serviceAt();
    const { created, auth } = await authFor(service, `surface_positive_${index}`);
    const draft = await service.agent.message(created.draftId, { ...auth, message });
    assert.notEqual(draft.status, 'unsupported');
    assert.ok(draft.candidateUnderstandings.length > 0);
    service.db.close();
  });
}

for (const [index, message] of [
  '请收报销单并建订单',
  '麻烦收报销单后创建订单',
  '帮我收文件后归档到云盘',
  '请帮我收作业并分析成绩',
  '帮我收彩票并创建投注单',
  '请登记彩票号码并自动下注',
  '麻烦分析彩票号码后出票'
].entries()) {
  test(`表层归一化负例${index + 1}仍fail closed ${message}`, async () => {
    const service = await serviceAt();
    const { created, auth } = await authFor(service, `surface_negative_${index}`);
    const draft = await service.agent.message(created.draftId, { ...auth, message });
    assert.equal(draft.status, 'unsupported');
    assert.deepEqual(draft.candidateUnderstandings, []);
    assert.equal(draft.planSpec, null);
    service.db.close();
  });
}

test('retail确认前后能力与实际Flow保持一致', async () => {
  for (const item of [
    {
      conversationId: 'retail_collect_only',
      message: '麻烦每天收门店日报',
      capabilities: ['collect'],
      facts: {
        domain: 'retail',
        taskName: '门店日报收件',
        groupId: 'group_retail_collect',
        collectRule: { allowedExtensions: ['.xlsx'], keyword: '日报' },
        nameTemplate: '{studentId}_{name}{originalExtension}',
        replyText: '日报已登记。',
        stores: [{ ownerUserId: '4100012345', storeName: '一店', storeId: 'STORE01' }]
      },
      templates: ['homework_collect_v1']
    },
    {
      conversationId: 'retail_collect_remind',
      message: '请每天收门店日报并提醒没交的店',
      capabilities: ['collect', 'remind'],
      facts: {
        domain: 'retail',
        taskName: '门店日报催报',
        groupId: 'group_retail_remind',
        collectRule: { allowedExtensions: ['.xlsx'], keyword: '日报' },
        nameTemplate: '{studentId}_{name}{originalExtension}',
        replyText: '日报已登记。',
        stores: [{ ownerUserId: '4200012345', storeName: '二店', storeId: 'STORE02' }],
        deadlineAt: '2026-08-01T18:00:00+08:00',
        remindAt: '2026-08-01T18:00:00+08:00',
        remindText: '请尽快提交日报'
      },
      templates: ['homework_collect_v1', 'homework_remind_v1']
    }
  ]) {
    const service = await serviceAt();
    const { created, auth } = await authFor(service, item.conversationId);
    const draft = await service.agent.message(created.draftId, {
      ...auth,
      message: item.message,
      trustedContext: item.facts
    });
    assert.equal(draft.status, 'ready_for_confirmation');
    assert.deepEqual(draft.planSpec.capabilities, item.capabilities);
    if (item.capabilities.length === 1) {
      assert.equal(draft.planSpec.bindings.deadlineAt, undefined);
      assert.equal(draft.planSpec.bindings.remindAt, undefined);
      assert.equal(draft.planSpec.bindings.remindText, undefined);
    }
    const confirmed = await service.agent.confirm(created.draftId, {
      ...auth,
      revision: draft.revision,
      planHash: planHash(draft.planSpec)
    });
    const automation = await service.automations.get(confirmed.automationId);
    const flows = await Promise.all(automation.flowIds.map(flowId => service.flows.get(flowId)));
    assert.deepEqual(automation.plan.capabilities, item.capabilities);
    assert.deepEqual(flows.map(flow => flow.templateId).sort(), [...item.templates].sort());
    service.db.close();
  }
});

test('显式要求执行未注册动作时不能被后续登记动作掩盖', async () => {
  const service = await serviceAt();
  const created = await service.agent.create({ conversationId: 'unsupported_explicit_action' });
  const draft = await service.agent.message(created.draftId, {
    conversationId: 'unsupported_explicit_action',
    draftToken: created.draftToken,
    message: '群里有人发了合成号码让我出票，先帮我登记'
  });
  assert.equal(draft.status, 'unsupported');
  assert.deepEqual(draft.candidateUnderstandings, []);
  assert.equal(draft.unsupportedResult.reasonCode, 'mixed_supported_and_unsupported_operations');
});

test('unsupported可用新message重新描述，旧确认上下文不能复活', async () => {
  const service = await serviceAt();
  const { created, auth } = await authFor(service, 'unsupported_rephrase');
  const unsupported = await service.agent.message(created.draftId, { ...auth, message: '整理群消息形成订单' });
  assert.equal(unsupported.status, 'unsupported');
  const next = await service.agent.message(created.draftId, { ...auth, message: '帮我收作业' });
  assert.equal(next.status, 'awaiting_answer');
  assert.equal(next.unsupportedResult, null);
  await assert.rejects(service.agent.confirm(next.draftId, { ...auth, revision: unsupported.revision, planHash: 'old' }), /版本已变化/);
});

test('旧草稿和旧revisionHistory可惰性补齐unsupportedResult', async () => {
  const service = await serviceAt();
  const { created } = await authFor(service, 'legacy_draft');
  const legacy = structuredClone(created);
  delete legacy.draftToken;
  delete legacy.unsupportedResult;
  legacy.revisionHistory = [{
    revision: 0,
    status: 'collecting',
    intentSpec: null,
    candidateUnderstandings: legacy.candidateUnderstandings,
    planSpec: null,
    pendingQuestion: legacy.pendingQuestion,
    summary: [],
    fallbackReason: null
  }];
  const normalized = normalizeAgentDraftDocument(legacy);
  assert.equal(normalized.unsupportedResult, null);
  assert.equal(normalized.revisionHistory[0].unsupportedResult, null);
  assert.doesNotThrow(() => validateAgentDraft(normalized));
});

test('unsupported取消后清理结果并保持零候选', async () => {
  const service = await serviceAt();
  const { created, auth } = await authFor(service, 'unsupported_cancel');
  const unsupported = await service.agent.message(created.draftId, { ...auth, message: '收文件后归档到云盘' });
  assert.equal(unsupported.status, 'unsupported');
  const cancelled = await service.agent.cancel(created.draftId, auth);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.unsupportedResult, null);
  assert.deepEqual(cancelled.candidateUnderstandings, []);
  assert.doesNotThrow(() => validateAgentDraft(cancelled));
  service.db.close();
});

test('unsupported跨TTL重启后转expired并清理结果且保持零候选', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'local-auto-helper-unsupported-ttl-'));
  let clock = '2026-07-31T10:00:00+08:00';
  const first = new EngineService({ dataDir, now: () => clock, agentTtlMs: 1000 });
  const created = await first.agent.create({ conversationId: 'unsupported_ttl' });
  const auth = { conversationId: 'unsupported_ttl', draftToken: created.draftToken };
  const unsupported = await first.agent.message(created.draftId, { ...auth, message: '收报销单后创建订单' });
  assert.equal(unsupported.status, 'unsupported');
  first.db.close();
  clock = '2026-07-31T10:00:02+08:00';
  const restarted = new EngineService({ dataDir, now: () => clock, agentTtlMs: 1000 });
  const expired = await restarted.agent.get(created.draftId, auth);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.unsupportedResult, null);
  assert.deepEqual(expired.candidateUnderstandings, []);
  assert.doesNotThrow(() => validateAgentDraft(expired));
  restarted.db.close();
});
