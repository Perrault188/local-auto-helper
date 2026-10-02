import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EngineService, planHash, parseProviderOutput,
  validateAgentDraft, validatePlanSpec
} from '../engine/index.mjs';

let sequence = 0;
const now = () => `2026-07-30T12:00:${String(sequence++).padStart(2, '0')}+08:00`;
const dataDir = () => mkdtemp(join(tmpdir(), 'local-auto-helper-agent-b2-qa-'));
const facts = {
  taskName: 'QA收件',
  groupId: 'group_qa',
  deadlineAt: '2026-08-06T18:00:00+08:00',
  collectRule: { allowedExtensions: ['.pdf'] },
  nameTemplate: '{studentId}_{name}{originalExtension}',
  replyText: '收到，已登记',
  roster: [{ userId: '6000012345', name: '测试成员', studentId: 'QA01' }]
};

async function ready(service, conversationId = 'conversation_a') {
  const created = await service.agent.create({ conversationId });
  const draft = await service.agent.message(created.draftId, {
    conversationId,
    draftToken: created.draftToken,
    message: '只收文件登记',
    facts
  });
  return { draft, token: created.draftToken };
}

async function businessCounts(service) {
  const names = [
    'automations', 'attachments', 'flows', 'resources',
    'recordStores', 'entityDirectories', 'runs'
  ];
  return Object.fromEntries(await Promise.all(
    names.map(async name => [name, (await service[name].list()).length])
  ));
}

test('QA：确认前所有非Agent仓库保持零写入', async () => {
  const service = new EngineService({ dataDir: await dataDir(), now });
  const { draft } = await ready(service);
  assert.equal(draft.status, 'ready_for_confirmation');
  assert.deepEqual(await businessCounts(service), {
    automations: 0,
    attachments: 0,
    flows: 0,
    resources: 0,
    recordStores: 0,
    entityDirectories: 0,
    runs: 0
  });
  service.db.close();
});

test('QA：不同会话不能读取、修改、取消或确认对方草稿', async () => {
  const service = new EngineService({ dataDir: await dataDir(), now });
  const { draft, token } = await ready(service, 'conversation_a');
  const attacker = 'conversation_b';

  await assert.rejects(
    service.agent.get(draft.draftId, { conversationId: attacker, draftToken: token }),
    /找不到草稿|会话不匹配/
  );
  await assert.rejects(
    service.agent.message(draft.draftId, {
      conversationId: attacker,
      draftToken: token,
      message: '把这个任务改掉',
      facts: { taskName: '被篡改' }
    }),
    /找不到草稿|会话不匹配/
  );
  await assert.rejects(
    service.agent.confirm(draft.draftId, {
      conversationId: attacker,
      draftToken: token,
      revision: draft.revision,
      planHash: planHash(draft.planSpec)
    }),
    /找不到草稿|会话不匹配/
  );
  await assert.rejects(
    service.agent.cancel(draft.draftId, { conversationId: attacker, draftToken: token }),
    /找不到草稿|会话不匹配/
  );
  service.db.close();
});

test('QA：一个草稿的确认凭据不能重放到另一个草稿', async () => {
  const service = new EngineService({ dataDir: await dataDir(), now });
  const first = await ready(service, 'conversation_a');
  const second = await ready(service, 'conversation_a');
  await assert.rejects(
    service.agent.confirm(second.draft.draftId, {
      conversationId: 'conversation_a',
      draftToken: second.token,
      revision: first.draft.revision,
      planHash: planHash(first.draft.planSpec)
    }),
    /摘要已变化|版本已变化/
  );
  assert.deepEqual(await businessCounts(service), {
    automations: 0,
    attachments: 0,
    flows: 0,
    resources: 0,
    recordStores: 0,
    entityDirectories: 0,
    runs: 0
  });
  service.db.close();
});

test('QA：同一确认并发提交只创建一个任务', async () => {
  const service = new EngineService({ dataDir: await dataDir(), now });
  const { draft, token } = await ready(service);
  const confirmation = {
    conversationId: 'conversation_a',
    draftToken: token,
    revision: draft.revision,
    planHash: planHash(draft.planSpec)
  };
  const results = await Promise.all([
    service.agent.confirm(draft.draftId, confirmation),
    service.agent.confirm(draft.draftId, confirmation)
  ]);
  assert.equal(new Set(results.map(item => item.automationId)).size, 1);
  assert.equal((await service.automations.list()).length, 1);
  assert.equal((await service.attachments.list()).length, 1);
  assert.equal((await service.flows.list()).length, 1);
  service.db.close();
});

test('QA：错误或缺失会话token不能访问，持久化及公开对象不泄露明文token', async () => {
  const service = new EngineService({ dataDir: await dataDir(), now });
  const created = await service.agent.create({ conversationId: 'token_conversation' });
  assert.equal(typeof created.draftToken, 'string');
  assert.notEqual(created.draftToken, created.draftTokenHash);
  const persisted = await service.agentDrafts.get(created.draftId);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(created.draftToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await assert.rejects(
    service.agent.get(created.draftId, { conversationId: 'token_conversation', draftToken: 'wrong-token' }),
    /找不到草稿/
  );
  service.db.close();
});

test('QA：嵌套schema、provider大小和重复候选均严格拒绝', () => {
  assert.throws(() => parseProviderOutput({
    candidates: [
      { domain: 'education', goal: '收件', capabilities: ['collect'], assumptions: [], confidence: 0.8, nested: true },
      { domain: 'education', goal: '提醒', capabilities: ['remind'], assumptions: [], confidence: 0.7 }
    ]
  }), /未声明字段/);
  assert.throws(() => parseProviderOutput({
    candidates: [
      { domain: 'education', goal: 'x'.repeat(12100), capabilities: ['collect'], assumptions: [], confidence: 0.8 },
      { domain: 'education', goal: '提醒', capabilities: ['remind'], assumptions: [], confidence: 0.7 }
    ]
  }), /大小限制/);
  const candidate = { domain: 'education', goal: '收件', capabilities: ['collect'], assumptions: [], confidence: 0.8 };
  assert.throws(() => parseProviderOutput({ candidates: [candidate, { ...candidate }] }), /重复/);
  assert.throws(() => validatePlanSpec({
    specVersion: '1.0', domain: 'education', capabilities: ['collect'], bindings: {},
    riskPolicy: { humanApprovalRequired: false, autoReview: false, autoPayment: false, autoBookkeeping: false, nested: true },
    approvalRequirements: [], humanReadablePlan: '计划', registryVersion: 'p1b-v1',
    confirmationContext: { draftId: 'agentdraft_x', conversationId: 'c', revision: 1 }
  }), /字段不严格/);
});

test('QA：trustedContext拒绝未知字段及名单嵌套字段', async () => {
  const service = new EngineService({ dataDir: await dataDir(), now });
  const created = await service.agent.create({ conversationId: 'trusted' });
  const auth = { conversationId: 'trusted', draftToken: created.draftToken };
  await assert.rejects(service.agent.message(created.draftId, {
    ...auth, message: '收作业', trustedContext: { domain: 'education', arbitrary: 'x' }
  }), /未知字段/);
  await assert.rejects(service.agent.message(created.draftId, {
    ...auth, message: '收作业', trustedContext: {
      domain: 'education',
      roster: [{ userId: '6000012345', name: '甲', studentId: '1', role: 'admin' }]
    }
  }), /未知字段/);
  service.db.close();
});

test('QA：自然语言回答每轮只推进pendingQuestion单字段', async () => {
  const service = new EngineService({ dataDir: await dataDir(), now });
  const created = await service.agent.create({ conversationId: 'single_field' });
  const auth = { conversationId: 'single_field', draftToken: created.draftToken };
  const first = await service.agent.message(created.draftId, { ...auth, message: '只收文件登记' });
  assert.equal(first.pendingQuestion.field, 'taskName');
  const second = await service.agent.message(created.draftId, { ...auth, userAnswer: 'QA资料收件，同时群是evil' });
  assert.equal(second.planSpec.bindings.taskName, 'QA资料收件，同时群是evil');
  assert.equal(second.planSpec.bindings.groupId, undefined);
  assert.equal(second.pendingQuestion.field, 'groupId');
  service.db.close();
});

test('QA：registry漂移和finance policy篡改均在确认前拒绝且零业务写入', async () => {
  const service = new EngineService({ dataDir: await dataDir(), now });
  const first = await ready(service);
  first.draft.planSpec.registryVersion = 'stale-registry';
  await service.agentDrafts.save(validateAgentDraft(first.draft));
  await assert.rejects(service.agent.confirm(first.draft.draftId, {
    conversationId: 'conversation_a', draftToken: first.token,
    revision: first.draft.revision, planHash: 'irrelevant'
  }), /注册表版本/);

  const created = await service.agent.create({ conversationId: 'finance_policy' });
  const finance = await service.agent.message(created.draftId, {
    conversationId: 'finance_policy', draftToken: created.draftToken,
    message: '收财务单据', trustedContext: {
      domain: 'finance', taskName: '单据', groupId: 'finance',
      collectRule: { allowedExtensions: ['.pdf'], keyword: '单据' },
      nameTemplate: '{studentId}_{name}{originalExtension}',
      submitters: [{ userId: '6000012345', name: '甲', entityId: 'P1' }]
    }
  });
  finance.planSpec.riskPolicy.autoPayment = true;
  await service.agentDrafts.save(validateAgentDraft(finance));
  await assert.rejects(service.agent.confirm(finance.draftId, {
    conversationId: 'finance_policy', draftToken: created.draftToken,
    revision: finance.revision, planHash: 'irrelevant'
  }), /风险策略/);
  assert.equal((await service.automations.list()).length, 0);
  service.db.close();
});

test('QA：创建链首次失败后compiling草稿可用同一凭据恢复且不重复创建', async () => {
  const service = new EngineService({ dataDir: await dataDir(), now });
  const prepared = await ready(service);
  const original = service.agent.createAutomationTask;
  let attempts = 0;
  service.agent.createAutomationTask = async input => {
    attempts++;
    if (attempts === 1) throw new Error('injected save failure');
    return original(input);
  };
  const confirmation = {
    conversationId: 'conversation_a', draftToken: prepared.token,
    revision: prepared.draft.revision, planHash: planHash(prepared.draft.planSpec)
  };
  await assert.rejects(service.agent.confirm(prepared.draft.draftId, confirmation), /injected save failure/);
  assert.equal((await service.agentDrafts.get(prepared.draft.draftId)).status, 'compiling');
  const recovered = await service.agent.confirm(prepared.draft.draftId, confirmation);
  assert.match(recovered.automationId, /^automation_/);
  assert.equal((await service.automations.list()).length, 1);
  service.db.close();
});

test('QA：业务已创建但草稿最终save失败，重试仍收敛为同一任务', async () => {
  const service = new EngineService({ dataDir: await dataDir(), now: () => '2026-07-30T12:30:00+08:00' });
  const prepared = await ready(service);
  const originalSave = service.agentDrafts.save.bind(service.agentDrafts);
  let injected = false;
  service.agentDrafts.save = async value => {
    if (value.status === 'compiled' && !injected) {
      injected = true;
      throw new Error('injected final draft save failure');
    }
    return originalSave(value);
  };
  const confirmation = {
    conversationId: 'conversation_a', draftToken: prepared.token,
    revision: prepared.draft.revision, planHash: planHash(prepared.draft.planSpec)
  };
  await assert.rejects(service.agent.confirm(prepared.draft.draftId, confirmation), /final draft save failure/);
  assert.equal((await service.automations.list()).length, 1);
  assert.equal((await service.agentDrafts.get(prepared.draft.draftId)).status, 'compiling');
  const recovered = await service.agent.confirm(prepared.draft.draftId, confirmation);
  assert.equal((await service.automations.list()).length, 1);
  assert.equal(recovered.automationId, (await service.automations.list())[0].automationId);
  service.db.close();
});

test('QA：TTL跨重启失效，reset后旧token不能访问新状态', async () => {
  let at = '2026-07-30T12:00:00+08:00';
  const clock = () => at;
  const directory = await dataDir();
  const first = new EngineService({ dataDir: directory, now: clock, agentTtlMs: 1000 });
  const created = await first.agent.create({ conversationId: 'ttl_reset' });
  first.db.close();
  at = '2026-07-30T12:00:02+08:00';
  const restarted = new EngineService({ dataDir: directory, now: clock, agentTtlMs: 1000 });
  const expired = await restarted.agent.get(created.draftId, {
    conversationId: 'ttl_reset', draftToken: created.draftToken
  });
  assert.equal(expired.status, 'expired');
  await restarted.resetDemo({ flows: [], attachments: [], adapterState: {} });
  await assert.rejects(restarted.agent.get(created.draftId, {
    conversationId: 'ttl_reset', draftToken: created.draftToken
  }), /找不到草稿/);
  restarted.db.close();
});
