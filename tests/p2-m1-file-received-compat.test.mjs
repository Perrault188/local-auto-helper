import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { EngineService, loadDemoSeed, validateEvent, validateFlow } from '../engine/index.mjs';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const tempDir = () => mkdtemp(join(tmpdir(), 'local-auto-helper-p2-m1-file-'));
let sequence = 0;
const now = () => `2026-08-01T19:00:${String(sequence++ % 60).padStart(2, '0')}+08:00`;

async function setup({ seed = true } = {}) {
  sequence = 0;
  const service = new EngineService({ dataDir: await tempDir(), now });
  if (seed) await service.resetDemo(await loadDemoSeed(fixturesDir));
  return service;
}
const legacy = id => ({
  schemaVersion: '0.3-rc1', eventId: `event_${id}`, type: 'group_file_received', occurredAt: '2026-08-01T19:10:00+08:00',
  payload: { messageId: `message_${id}`, groupId: 'group_se_2024_1', senderUserId: '1000012345', text: '作业提交', file: { fileId: `file_${id}`, name: '作业.docx', path: `/demo/inbox/${id}.docx` } }
});
const taskInput = (name, groupId, userId = '6200012345') => ({
  capabilities: ['collect'], taskName: name, groupId,
  collectRule: { allowedExtensions: ['.docx'], keyword: '作业' },
  nameTemplate: '{studentId}_{name}{originalExtension}',
  roster: [{ userId, name: '测试成员', studentId: `${name}01` }]
});

async function canonical(service, { id, kind, externalKey, senderUserId = '6200012345' }) {
  const conversation = await service.ensureConversation({ kind, connector: 'mock', externalKey });
  return {
    schemaVersion: '0.4-rc1', eventId: `event_${id}`, type: 'file_received', occurredAt: '2026-08-01T19:20:00+08:00',
    payload: {
      messageId: `message_${id}`, conversationId: conversation.conversationId, conversationType: kind,
      senderUserId, text: '作业提交', file: { fileId: `file_${id}`, name: '作业.docx', sourceRef: `mock-inbox:${id}` }
    }
  };
}

async function close(service) { service.adapters.closeConnectorJournal?.(); service.db?.close(); }

test('P2-M1红灯：旧group_file_received只在边界转换，Run内部快照为canonical file_received', async () => {
  const service = await setup();
  const input = legacy('legacy');
  const storedLegacyFlow = await service.flows.get('flow_collect_demo');
  assert.equal(storedLegacyFlow.schemaVersion, '0.2-rc1');
  assert.equal(storedLegacyFlow.hook.type, 'group_file_received');
  const [run] = await service.dispatch(input);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.flowSnapshot.schemaVersion, '0.4-rc1');
  assert.equal(run.flowSnapshot.hook.type, 'file_received');
  assert.equal(run.eventSnapshot.type, 'file_received');
  assert.equal(run.eventSnapshot.payload.conversationType, 'group');
  assert.match(run.eventSnapshot.payload.conversationId, /^conv_/);
  assert.equal(run.eventSnapshot.payload.file.sourceRef, `mock-path:${input.payload.file.path}`);
  assert.equal((await service.runs.get(run.runId)).eventSnapshot.type, 'file_received');
  assert.deepEqual(await service.flows.get('flow_collect_demo'), storedLegacyFlow, '边界双读不得回写迁移旧Flow');
  await close(service);
});

test('B5：Flow/Event Schema与runtime拒绝0.4+group_file_received，legacy与canonical各守边界', async () => {
  const [flowSchema, eventSchema, seed] = await Promise.all([
    readFile(new URL('../contracts/flow.schema.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../contracts/mock-event.schema.json', import.meta.url), 'utf8').then(JSON.parse),
    loadDemoSeed(fixturesDir)
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateFlowSchema = ajv.compile(flowSchema);
  const validateEventSchema = ajv.compile(eventSchema);
  const legacyFlow = structuredClone(seed.flows.find(item => item.flowId === 'flow_collect_demo'));
  const attachment = structuredClone(seed.attachments.find(item => item.taskAttachmentId === legacyFlow.taskAttachmentId));
  const legacyEvent = legacy('b5-legacy-accepted');
  assert.equal(validateFlowSchema(legacyFlow), true, JSON.stringify(validateFlowSchema.errors));
  assert.equal(validateEventSchema(legacyEvent), true, JSON.stringify(validateEventSchema.errors));
  assert.doesNotThrow(() => validateFlow(structuredClone(legacyFlow), structuredClone(attachment)));
  assert.doesNotThrow(() => validateEvent(structuredClone(legacyEvent)));
  const legacyFlow03 = { ...structuredClone(legacyFlow), schemaVersion: '0.3-rc1' };
  assert.equal(validateFlowSchema(legacyFlow03), true, JSON.stringify(validateFlowSchema.errors));
  assert.doesNotThrow(() => validateFlow(legacyFlow03, structuredClone(attachment)));

  const invalidFlow = { ...structuredClone(legacyFlow), schemaVersion: '0.4-rc1' };
  const invalidEvent = { ...structuredClone(legacyEvent), schemaVersion: '0.4-rc1' };
  assert.equal(validateFlowSchema(invalidFlow), false, 'Flow Schema必须拒绝0.4+group_file_received');
  assert.equal(validateEventSchema(invalidEvent), false, 'Event Schema必须拒绝0.4+group_file_received');
  assert.throws(() => validateFlow(invalidFlow, structuredClone(attachment)), /0\.4 Flow禁止legacy/);
  assert.throws(() => validateEvent(invalidEvent), error => error?.code === 'HOOK_INPUT_INVALID' && /旧文件事件版本非法/.test(error.message));

  const service = await setup({ seed: false });
  const created = await service.createAutomationTask(taskInput('B5_CANONICAL', 'group_b5_canonical'));
  const canonicalFlow = await service.flows.get(created.flowIds[0]);
  const canonicalAttachment = await service.attachments.get(created.taskAttachmentId);
  const canonicalEvent = await canonical(service, { id: 'b5-canonical-accepted', kind: 'group', externalKey: 'group_b5_canonical' });
  assert.equal(validateFlowSchema(canonicalFlow), true, JSON.stringify(validateFlowSchema.errors));
  assert.equal(validateEventSchema(canonicalEvent), true, JSON.stringify(validateEventSchema.errors));
  assert.doesNotThrow(() => validateFlow(structuredClone(canonicalFlow), structuredClone(canonicalAttachment)));
  assert.doesNotThrow(() => validateEvent(structuredClone(canonicalEvent)));
  for (const oldVersion of ['0.2-rc1', '0.3-rc1']) {
    const oldCanonicalFlow = { ...structuredClone(canonicalFlow), schemaVersion: oldVersion };
    assert.equal(validateFlowSchema(oldCanonicalFlow), false, `Flow Schema必须拒绝${oldVersion}+file_received`);
    assert.throws(() => validateFlow(oldCanonicalFlow, structuredClone(canonicalAttachment)), /统一文件Hook会话非法/);
  }
  const directFlow = { ...structuredClone(canonicalFlow), hook: { ...structuredClone(canonicalFlow.hook), type: 'direct_file_received' } };
  const directEvent = { ...structuredClone(canonicalEvent), type: 'direct_file_received' };
  assert.equal(validateFlowSchema(directFlow), false, 'Flow Schema必须拒绝direct_file_received第三语义');
  assert.equal(validateEventSchema(directEvent), false, 'Event Schema必须拒绝direct_file_received第三语义');
  assert.throws(() => validateFlow(directFlow, structuredClone(canonicalAttachment)), /模板不允许该Hook/);
  assert.throws(() => validateEvent(directEvent), error => error?.code === 'HOOK_INPUT_INVALID');
  await close(service);
});

test('P2-M1红灯：非法旧事件在归一化前严格拒绝且零消息、零Run、零文件副作用', async () => {
  const service = await setup();
  const invalid = legacy('invalid');
  delete invalid.payload.groupId;
  await assert.rejects(service.dispatch(invalid), error => error?.code === 'HOOK_INPUT_INVALID');
  assert.equal((await service.messageLogs.list()).length, 0);
  assert.equal((await service.runs.list()).length, 0);
  assert.equal(service.adapters.snapshot().files.some(item => item.fileId === invalid.payload.file.fileId), false);
  await close(service);
});

test('P2-M1红灯：group与direct使用完全相同的四Action执行主链', async () => {
  const groupService = await setup({ seed: false });
  const groupTask = await groupService.createAutomationTask(taskInput('GROUP', 'group_p2m1'));
  const storedCollect = await groupService.flows.get(groupTask.flowIds[0]);
  assert.equal(storedCollect.schemaVersion, '0.4-rc1');
  assert.equal(storedCollect.hook.type, 'file_received');
  assert.equal((await groupService.flows.list()).some(item => item.flowId === storedCollect.flowId && item.hook.type === 'group_file_received'), false);
  const groupEvent = await canonical(groupService, { id: 'canonical_group', kind: 'group', externalKey: 'group_p2m1' });
  const [groupRun] = await groupService.dispatch(groupEvent);

  const directService = await setup({ seed: false });
  const directTask = await directService.createAutomationTask(taskInput('DIRECT', 'group_unused'));
  const directEvent = await canonical(directService, { id: 'canonical_direct', kind: 'direct', externalKey: 'owner:6200012345' });
  const [directRun] = await directService.dispatch(directEvent, { trustedRoute: { automationId: directTask.automationId } });

  const expected = ['match_person', 'rename_received_file', 'mark_submission', 'reply_to_sender'];
  assert.deepEqual(groupRun.steps.map(item => item.actionType), expected);
  assert.deepEqual(directRun.steps.map(item => item.actionType), expected);
  assert.equal(groupRun.flowId, groupTask.flowIds[0]);
  assert.equal(directRun.flowId, directTask.flowIds[0]);
  assert.equal(directRun.eventSnapshot.payload.conversationType, 'direct');
  await close(groupService);
  await close(directService);
});

test('P2-M1红灯：direct无可信路由或路由歧义时fail closed，可信绑定后只更新目标任务', async () => {
  const service = await setup({ seed: false });
  const a = await service.createAutomationTask(taskInput('A', 'group_a'));
  const b = await service.createAutomationTask(taskInput('B', 'group_b'));
  const untrusted = await canonical(service, { id: 'direct_untrusted', kind: 'direct', externalKey: 'owner:6200012345' });
  assert.deepEqual(await service.dispatch(untrusted), []);
  assert.equal((await service.messageLogs.findByEvent(untrusted.eventId)).filter(item => item.direction === 'inbound').length, 1);

  const trusted = await canonical(service, { id: 'direct_trusted', kind: 'direct', externalKey: 'owner:6200012345' });
  const [run] = await service.dispatch(trusted, { trustedRoute: { automationId: a.automationId, source: 'mock_task_context' } });
  const bindings = await service.conversationBindings.listByConversation(trusted.payload.conversationId, { capability: 'collect', active: true });
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].automationId, a.automationId);
  assert.equal(bindings[0].source, 'mock_task_context');
  assert.ok(a.flowIds.includes(run.flowId));
  const attachmentA = await service.attachments.get(a.taskAttachmentId);
  const attachmentB = await service.attachments.get(b.taskAttachmentId);
  assert.equal(attachmentA.members[0].submissionStatus, 'submitted');
  assert.equal(attachmentB.members[0].submissionStatus, 'unsubmitted');
  const outbound = (await service.messageLogs.findByEvent(trusted.eventId)).filter(item => item.direction === 'outbound');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].automationId, a.automationId);
  assert.equal(outbound[0].conversationId, trusted.payload.conversationId, 'direct回执必须写回原direct会话');
  await close(service);
});

test('P2-M1红灯：direct受控路由拒绝unknown任务、无collect任务和目录外发送人', async t => {
  const cases = [
    { name: 'unknown automation', prepare: async () => 'automation_unknown', senderUserId: '6200012345' },
    { name: 'automation without collect', prepare: async service => (await service.createAutomationTask({ capabilities: ['remind'], taskName: '只提醒', remindText: '提醒', remindAt: '2026-08-02T18:00:00+08:00' })).automationId, senderUserId: '6200012345' },
    { name: 'sender outside directory', prepare: async service => (await service.createAutomationTask(taskInput('BOUND', 'group_bound'))).automationId, senderUserId: '6200099999' }
  ];
  for (const [index, item] of cases.entries()) await t.test(item.name, async () => {
    const service = await setup({ seed: false });
    const automationId = await item.prepare(service);
    const incoming = await canonical(service, { id: `direct_negative_${index}`, kind: 'direct', externalKey: `owner:${item.senderUserId}`, senderUserId: item.senderUserId });
    const attachmentBefore = await service.attachments.list();
    const recordsBefore = await service.recordStores.list();
    assert.deepEqual(await service.dispatch(incoming, { trustedRoute: { automationId, source: 'mock_task_context' } }), []);
    assert.equal((await service.messageLogs.findByEvent(incoming.eventId)).filter(message => message.direction === 'inbound').length, 1);
    assert.equal((await service.messageLogs.findByEvent(incoming.eventId)).filter(message => message.direction === 'outbound').length, 0);
    assert.equal((await service.runs.list()).length, 0);
    assert.deepEqual(await service.attachments.list(), attachmentBefore);
    assert.deepEqual(await service.recordStores.list(), recordsBefore);
    assert.equal((await service.conversationBindings.list()).length, 0, '无效路由不得落binding');
    await close(service);
  });
});

test('P2-M1红灯：暂停任务拒绝direct执行但保留唯一入站事实', async () => {
  const service = await setup({ seed: false });
  const task = await service.createAutomationTask(taskInput('PAUSED', 'group_paused'));
  await service.setAutomationStatus(task.automationId, 'paused');
  const incoming = await canonical(service, { id: 'direct_paused', kind: 'direct', externalKey: 'owner:6200012345' });
  assert.deepEqual(await service.dispatch(incoming, { trustedRoute: { automationId: task.automationId } }), []);
  assert.equal((await service.messageLogs.findByEvent(incoming.eventId)).filter(item => item.direction === 'inbound').length, 1);
  assert.equal((await service.runs.list()).length, 0);
  await close(service);
});

test('P2-M1阻塞复核：direct后续事件复用持久active binding而无需再次传trustedRoute', async () => {
  const service = await setup({ seed: false });
  const task = await service.createAutomationTask(taskInput('BOUND_REUSE', 'group_bound_reuse'));
  const first = await canonical(service, { id: 'direct_bind_first', kind: 'direct', externalKey: 'owner:6200012345' });
  const [firstRun] = await service.dispatch(first, { trustedRoute: { automationId: task.automationId, source: 'mock_task_context' } });
  const second = await canonical(service, { id: 'direct_bind_second', kind: 'direct', externalKey: 'owner:6200012345' });
  const [secondRun] = await service.dispatch(second);
  assert.equal(firstRun.flowId, secondRun.flowId);
  assert.equal(secondRun.status, 'succeeded_no_action');
  assert.equal((await service.conversationBindings.listByConversation(second.payload.conversationId, { capability: 'collect', active: true })).length, 1);
  await close(service);
});

test('P2-M1阻塞复核：编辑canonical collect Flow后仍保持0.4 file_received', async () => {
  const service = await setup({ seed: false });
  const task = await service.createAutomationTask(taskInput('EDIT_CANONICAL', 'group_edit_canonical'));
  await service.editAutomationTask(task.automationId, { collectRule: { allowedExtensions: ['.docx', '.pdf'], keyword: '作业' } });
  const flow = await service.flows.get(task.flowIds[0]);
  assert.equal(flow.schemaVersion, '0.4-rc1');
  assert.equal(flow.hook.type, 'file_received');
  assert.match(flow.hook.params.conversationId, /^conv_/);
  await close(service);
});
