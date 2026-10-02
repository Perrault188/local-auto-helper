import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineService, CreationValidationError, validateCreateAutomationTaskInput } from '../engine/index.mjs';

// A2 彻底档：按 capabilities 真正按需建 Flow / 裁剪字段与通用对象。
// 覆盖验收判据：只登记/只提醒/只发布/发布+收取/催未交闭环 + capabilities 非法与空 + 不传=三条回归。

let clockIndex = 0;
const now = () => `2026-07-21T10:00:${String(clockIndex++).padStart(2, '0')}+08:00`;
async function tempDir() { return mkdtemp(join(tmpdir(), 'local-auto-helper-caps-')); }
async function newService() { clockIndex = 0; return new EngineService({ backend: 'sqlite', dataDir: await tempDir(), now }); }

const base = {
  taskName: '按需组合任务',
  groupId: 'group_demo_1',
  publishText: '请查收通知。',
  noticeFilePath: '/demo/source/通知.pdf',
  publishAt: '2026-07-28T10:00:00+08:00',
  deadlineAt: '2026-08-02T18:00:00+08:00',
  remindAt: '2026-08-02T09:00:00+08:00',
  collectRule: { allowedExtensions: ['.docx', '.pdf'], keyword: '作业' },
  nameTemplate: '{studentId}_{name}{originalExtension}',
  remindText: '即将截止，请尽快提交。',
  roster: [
    { userId: '2000012345', name: '测试成员甲', studentId: '20240101' },
    { userId: '2000012346', name: '测试成员乙', studentId: '20240102' }
  ]
};
const pick = (...keys) => Object.fromEntries(Object.entries(base).filter(([k]) => keys.includes(k)));

test('只登记 collect：只建一条收取 Flow、只需收取相关字段，不被迫填催交/发布', async () => {
  const service = await newService();
  const input = { capabilities: ['collect'], ...pick('taskName', 'groupId', 'collectRule', 'nameTemplate', 'roster') };
  const result = await service.createAutomationTask(input);
  assert.equal(result.flowIds.length, 1);
  const flows = await service.flows.list();
  assert.equal(flows.length, 1);
  assert.equal(flows[0].templateId, 'homework_collect_v1');
  // collect 需要名单与提交记录容器
  assert.ok(result.entityDirectoryId && result.recordStoreId);
  const attachment = await service.attachments.get(result.taskAttachmentId);
  assert.deepEqual(attachment.capabilities, ['collect']);
  assert.equal(attachment.members.length, 2);
  service.db.close();
});

test('只提醒 remind：只建一条提醒 Flow，只需提醒时间+文案，不强制群/名单/截止', async () => {
  const service = await newService();
  const input = { capabilities: ['remind'], taskName: '到点提醒', remindAt: '2026-08-01T09:00:00+08:00', remindText: '该做某事了' };
  const result = await service.createAutomationTask(input);
  assert.equal(result.flowIds.length, 1);
  const flows = await service.flows.list();
  assert.equal(flows[0].templateId, 'homework_remind_v1');
  // remind 独立时间：runAt = remindAt，不再 = deadline
  assert.equal(flows[0].hook.params.runAt, '2026-08-01T09:00:00+08:00');
  // 不建名单/提交记录容器
  assert.equal(result.entityDirectoryId, null);
  assert.equal(result.recordStoreId, null);
  const attachment = await service.attachments.get(result.taskAttachmentId);
  assert.deepEqual(attachment.capabilities, ['remind']);
  assert.equal(attachment.groupId, null);
  assert.equal(attachment.deadlineAt, null);
  assert.deepEqual(attachment.members, []);
  service.db.close();
});

test('只发布 publish：只建一条发布 Flow，只需发送目标+正文+附件+发布时间，不需名单', async () => {
  const service = await newService();
  const input = { capabilities: ['publish'], ...pick('taskName', 'groupId', 'publishText', 'noticeFilePath', 'publishAt') };
  const result = await service.createAutomationTask(input);
  assert.equal(result.flowIds.length, 1);
  const flows = await service.flows.list();
  assert.equal(flows[0].templateId, 'homework_publish_v1');
  assert.equal(result.entityDirectoryId, null);
  const attachment = await service.attachments.get(result.taskAttachmentId);
  assert.deepEqual(attachment.capabilities, ['publish']);
  assert.deepEqual(attachment.members, []);
  assert.equal(attachment.deadlineAt, null);
  service.db.close();
});

test('发布+收取（不催交）：建两条 Flow，需群/正文/收取规则/名单，不需催交字段', async () => {
  const service = await newService();
  const input = { capabilities: ['publish', 'collect'], ...pick('taskName', 'groupId', 'publishText', 'noticeFilePath', 'publishAt', 'collectRule', 'nameTemplate', 'roster') };
  const result = await service.createAutomationTask(input);
  assert.equal(result.flowIds.length, 2);
  const templates = (await service.flows.list()).map(f => f.templateId).sort();
  assert.deepEqual(templates, ['homework_collect_v1', 'homework_publish_v1']);
  service.db.close();
});

test('催未交闭环 collect+remind：需名单+截止，remind 缺省回退 deadline', async () => {
  const service = await newService();
  const input = { capabilities: ['collect', 'remind'], ...pick('taskName', 'groupId', 'deadlineAt', 'collectRule', 'nameTemplate', 'remindText', 'roster') };
  const result = await service.createAutomationTask(input);
  assert.equal(result.flowIds.length, 2);
  const flows = await service.flows.list();
  const remind = flows.find(f => f.templateId === 'homework_remind_v1');
  // 未显式给 remindAt，催未交闭环缺省回退 deadline
  assert.equal(remind.hook.params.runAt, '2026-08-02T18:00:00+08:00');
  service.db.close();
});

test('不传 capabilities = 旧三条行为：三条 Flow、附件无 capabilities 字段、runAt=deadline', async () => {
  const service = await newService();
  const input = { ...base };
  delete input.remindAt; // 不传 remindAt，验证全能力缺省回退 deadline
  const result = await service.createAutomationTask(input);
  assert.equal(result.flowIds.length, 3);
  const attachment = await service.attachments.get(result.taskAttachmentId);
  // 兼容红线：全能力缺省附件不写 capabilities 字段，与旧 0.2-rc1 逐字段等价
  assert.equal('capabilities' in attachment, false);
  const flows = await service.flows.list();
  const remind = flows.find(f => f.templateId === 'homework_remind_v1');
  assert.equal(remind.hook.params.runAt, '2026-08-02T18:00:00+08:00');
  assert.ok(result.entityDirectoryId && result.recordStoreId);
  service.db.close();
});

test('capabilities 空数组 → EMPTY 错误', () => {
  assert.throws(() => validateCreateAutomationTaskInput({ capabilities: [], taskName: 'x' }), err => {
    assert.ok(err instanceof CreationValidationError);
    assert.equal(err.errors[0].code, 'EMPTY');
    assert.equal(err.errors[0].field, 'capabilities');
    return true;
  });
});

test('capabilities 非法值 → UNKNOWN 错误', () => {
  assert.throws(() => validateCreateAutomationTaskInput({ capabilities: ['publish', 'delete_all'], taskName: 'x' }), err => {
    assert.equal(err.errors[0].code, 'UNKNOWN');
    return true;
  });
});

test('只提醒缺 remindAt → REQUIRED；不因缺群/名单/截止报错', () => {
  assert.throws(() => validateCreateAutomationTaskInput({ capabilities: ['remind'], taskName: '提醒', remindText: '文案' }), err => {
    const fields = err.errors.map(e => e.field);
    assert.ok(fields.includes('remindAt'));
    // 关键：不因缺 groupId/roster/deadlineAt 报错
    assert.ok(!fields.includes('groupId'));
    assert.ok(!fields.includes('roster'));
    assert.ok(!fields.includes('deadlineAt'));
    return true;
  });
});

test('只登记不因缺催交文案/发布字段报错', () => {
  // 只给 collect 所需字段，故意不给 publishText/remindText/publishAt
  const normalized = validateCreateAutomationTaskInput({
    capabilities: ['collect'], taskName: '登记', groupId: 'g1',
    collectRule: { allowedExtensions: ['.pdf'] }, nameTemplate: '{studentId}{originalExtension}',
    roster: [{ userId: '2000012345', name: '甲', studentId: 'S1' }]
  });
  assert.deepEqual(normalized.capabilities, ['collect']);
  assert.equal(normalized.publishText, null);
  assert.equal(normalized.remindText, null);
});

test('大小写与顺序规范化：Remind/PUBLISH 归一为规范顺序 publish→remind', () => {
  const normalized = validateCreateAutomationTaskInput({
    capabilities: ['Remind', 'PUBLISH'], taskName: 't',
    groupId: 'g1', publishText: 'x', noticeFilePath: '/a.pdf', publishAt: '2026-07-28T10:00:00+08:00',
    remindAt: '2026-07-30T10:00:00+08:00', remindText: 'r'
  });
  assert.deepEqual(normalized.capabilities, ['publish', 'remind']);
});

// P-1（reviewer）：publishTrigger=scheduled 时发布 Flow 落库为定时触发（runAt=publishAt），
// 而非硬编码 self_message——修复「UI 说定时、落库却是关键词触发」的背离。
test('定时发通知：publishTrigger=scheduled 落库为 scheduled hook（runAt=publishAt）', async () => {
  const service = await newService();
  const input = { capabilities: ['publish'], publishTrigger: 'scheduled', taskName: '定时发通知',
    groupId: 'group_p', publishText: '通知正文', noticeFilePath: '/demo/n.pdf', publishAt: '2026-08-01T09:00:00+08:00' };
  const result = await service.createAutomationTask(input);
  assert.equal(result.flowIds.length, 1);
  const flow = (await service.flows.list()).find(f => f.templateId === 'homework_publish_v1');
  assert.equal(flow.hook.type, 'scheduled');
  assert.equal(flow.hook.params.runAt, '2026-08-01T09:00:00+08:00');
  service.db.close();
});

test('默认发布触发仍为 self_message（不传 publishTrigger 兼容旧行为）', async () => {
  const service = await newService();
  const input = { capabilities: ['publish'], taskName: '关键词触发发布',
    groupId: 'group_p', publishText: '正文', noticeFilePath: '/demo/n.pdf', publishAt: '2026-08-01T09:00:00+08:00' };
  await service.createAutomationTask(input);
  const flow = (await service.flows.list()).find(f => f.templateId === 'homework_publish_v1');
  assert.equal(flow.hook.type, 'self_message');
  service.db.close();
});

// B-2 路线②：执行写回附件后，对应 RecordStore 提交记录片段被同步刷新（不再是创建期死快照）。
test('B-2 提交登记后 RecordStore 片段与附件同步（片段变活）', async () => {
  const service = await newService();
  const input = { capabilities: ['collect'], taskName: '片段同步任务', groupId: 'group_sync',
    collectRule: { allowedExtensions: ['.docx'] }, nameTemplate: '{studentId}_{name}{originalExtension}',
    roster: [{ userId: '2000012345', name: '测试成员甲', studentId: '20240101' }] };
  const result = await service.createAutomationTask(input);

  // 创建即投影：片段初始为 unsubmitted，且带 sourceAttachmentId 便于反查。
  const before = await service.recordStores.get(result.recordStoreId);
  assert.equal(before.records[0].submissionStatus, 'unsubmitted');
  assert.equal(before.sourceAttachmentId, result.taskAttachmentId);

  // 触发一次有效提交：collect flow 收到 .docx。
  const collectFlow = (await service.flows.list()).find(f => f.templateId === 'homework_collect_v1');
  const event = { schemaVersion: '0.3-rc1', eventId: 'event_sync_submit', type: 'group_file_received', occurredAt: now(),
    payload: { messageId: 'm1', groupId: 'group_sync', senderUserId: '2000012345', text: '作业', file: { fileId: 'f1', name: '作业.docx', path: '/demo/inbox/作业.docx' } } };
  service.adapters.receiveFile(event.payload.file);
  const [run] = await service.dispatch(event);
  assert.equal(run.status, 'succeeded');

  // 关键断言：RecordStore 片段已同步为 submitted（B-2 路线②让片段变活）。
  const after = await service.recordStores.get(result.recordStoreId);
  assert.equal(after.records[0].submissionStatus, 'submitted');
  assert.ok(after.records[0].filePath && after.records[0].lastSubmittedAt);
  // 附件仍是权威源，与片段一致（D021 不破）。
  const attachment = await service.attachments.get(result.taskAttachmentId);
  assert.equal(attachment.members[0].submissionStatus, 'submitted');
  service.db.close();
});

// P-6（reviewer）：催未交后 RecordStore 片段 reminderStatus 也同步（覆盖 send_direct_message_batch 写回路径）。
test('B-2 催未交后 RecordStore 片段 reminderStatus 同步为 sent', async () => {
  const service = await newService();
  const input = { capabilities: ['collect', 'remind'], taskName: '催交同步任务', groupId: 'group_rmd',
    deadlineAt: '2026-08-05T18:00:00+08:00',
    collectRule: { allowedExtensions: ['.docx'] }, nameTemplate: '{studentId}_{name}{originalExtension}',
    remindText: '请尽快提交', roster: [{ userId: '2000012345', name: '测试成员甲', studentId: '20240101' }] };
  const result = await service.createAutomationTask(input);
  const remindFlow = (await service.flows.list()).find(f => f.templateId === 'homework_remind_v1');
  // 触发到点提醒：timer_fired，scheduledFor = remind flow 的 runAt（催未交闭环缺省=deadline）。
  const event = { schemaVersion: '0.3-rc1', eventId: 'event_sync_remind', type: 'timer_fired', occurredAt: now(),
    payload: { scheduledFor: remindFlow.hook.params.runAt, timezone: 'Asia/Shanghai' } };
  const [run] = await service.dispatch(event);
  assert.equal(run.status, 'succeeded');
  // 片段 reminderStatus 同步为 sent（未交成员被提醒）。
  const after = await service.recordStores.get(result.recordStoreId);
  assert.equal(after.records[0].reminderStatus, 'sent');
  const attachment = await service.attachments.get(result.taskAttachmentId);
  assert.equal(attachment.members[0].reminderStatus, 'sent');
  service.db.close();
});

// P-6（reviewer）：旧 0.2-rc1 附件在升版本后仍可校验通过、可执行（双版本兼容回归）。
test('0.2-rc1 旧附件在 0.3 引擎下仍可校验与执行（双版本兼容）', async () => {
  const service = await newService();
  // 手工构造一份 0.2-rc1 完整附件（无 capabilities 字段），直接落库并走校验。
  const legacyAttachment = {
    schemaVersion: '0.2-rc1', taskAttachmentId: 'task_legacy_02', taskName: '旧版任务',
    groupId: 'group_legacy', publishAt: '2026-07-28T10:00:00+08:00', deadlineAt: '2026-08-02T18:00:00+08:00',
    sourceFilePath: '/demo/legacy.pdf',
    members: [{ userId: '2000012345', name: '甲', studentId: 'S1', submissionStatus: 'unsubmitted', lastSubmittedAt: null, filePath: null, reminderStatus: 'pending', remindedAt: null }],
    createdAt: '2026-07-21T09:00:00+08:00', updatedAt: '2026-07-21T09:00:00+08:00'
  };
  // saveAttachment 内部走 validateAttachment，0.2-rc1 应被 isSupportedVersion 接受、按全必填校验通过。
  await service.saveAttachment(legacyAttachment);
  const got = await service.attachments.get('task_legacy_02');
  assert.equal(got.schemaVersion, '0.2-rc1');
  assert.equal(got.members.length, 1);
  service.db.close();
});
