import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineService, ManagementError } from '../engine/index.mjs';

// P1-A：任务级长期管理（状态变更 + 聚合视图 + 编辑，含修改一致性规则）。

let clockIndex = 0;
const now = () => `2026-07-21T10:00:${String(clockIndex++).padStart(2, '0')}+08:00`;
async function tempDir() { return mkdtemp(join(tmpdir(), 'local-auto-helper-mgmt-')); }
async function newService() { clockIndex = 0; return new EngineService({ backend: 'sqlite', dataDir: await tempDir(), now }); }

function fullInput(overrides = {}) {
  return {
    taskName: '第3周作业', groupId: 'group_m',
    publishText: '请提交第3周作业', noticeFilePath: '/demo/w3.pdf',
    publishAt: '2026-07-28T10:00:00+08:00', deadlineAt: '2026-08-02T18:00:00+08:00',
    collectRule: { allowedExtensions: ['.docx'], keyword: '作业' },
    nameTemplate: '{studentId}_{name}{originalExtension}',
    remindText: '即将截止', roster: [
      { userId: '2000012345', name: '测试成员甲', studentId: '20240101' },
      { userId: '2000012346', name: '测试成员乙', studentId: '20240102' }
    ], ...overrides
  };
}

test('任务级暂停：联动名下 Flow 变 disabled，任务状态 paused', async () => {
  const service = await newService();
  const { automationId, flowIds } = await service.createAutomationTask(fullInput());
  await service.setAutomationStatus(automationId, 'paused');
  const automation = await service.automations.get(automationId);
  assert.equal(automation.status, 'paused');
  for (const fid of flowIds) assert.equal((await service.flows.get(fid)).status, 'disabled');
  service.db.close();
});

test('任务级恢复：paused → enabled 联动 Flow 回 enabled', async () => {
  const service = await newService();
  const { automationId, flowIds } = await service.createAutomationTask(fullInput());
  await service.setAutomationStatus(automationId, 'paused');
  await service.setAutomationStatus(automationId, 'enabled');
  assert.equal((await service.automations.get(automationId)).status, 'enabled');
  for (const fid of flowIds) assert.equal((await service.flows.get(fid)).status, 'enabled');
  service.db.close();
});

test('任务级删除：软删，Flow 变 deleted 但历史仍可 get', async () => {
  const service = await newService();
  const { automationId, flowIds } = await service.createAutomationTask(fullInput());
  await service.setAutomationStatus(automationId, 'deleted');
  assert.equal((await service.automations.get(automationId)).status, 'deleted');
  for (const fid of flowIds) assert.equal((await service.flows.get(fid)).status, 'deleted');
  // 默认列表隐藏已删除
  assert.equal((await service.listAutomationViews()).length, 0);
  assert.equal((await service.listAutomationViews({ includeDeleted: true })).length, 1);
  service.db.close();
});

test('非法状态转移：ended 后不能回 enabled', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask(fullInput());
  await service.setAutomationStatus(automationId, 'ended');
  await assert.rejects(() => service.setAutomationStatus(automationId, 'enabled'), err => {
    assert.ok(err instanceof ManagementError);
    assert.equal(err.code, 'STATUS_TRANSITION_INVALID');
    return true;
  });
  service.db.close();
});

test('聚合视图：一个任务聚合三条 Flow + 能力集 + 名单进度', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask(fullInput());
  const view = await service.getAutomationView(automationId);
  assert.equal(view.name, '第3周作业');
  assert.deepEqual(view.capabilities, ['publish', 'collect', 'remind']);
  assert.equal(view.flows.length, 3);
  assert.equal(view.memberCount, 2);
  assert.equal(view.submittedCount, 0);
  service.db.close();
});

test('编辑改名：任务名与三条 Flow 名称同步更新，automation.name 更新', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask(fullInput());
  const view = await service.editAutomationTask(automationId, { taskName: '第3周作业（改）' });
  assert.equal(view.name, '第3周作业（改）');
  const flows = view.flows;
  assert.ok(flows.find(f => f.name === '发布：第3周作业（改）'));
  assert.ok(flows.find(f => f.name === '收取：第3周作业（改）'));
  assert.equal((await service.automations.get(automationId)).name, '第3周作业（改）');
  service.db.close();
});

test('编辑改截止：催未交闭环的提醒 Flow runAt 同步重算为新截止', async () => {
  const service = await newService();
  const { automationId, flowIds } = await service.createAutomationTask(fullInput());
  await service.editAutomationTask(automationId, { deadlineAt: '2026-08-10T18:00:00+08:00' });
  const attachment = await service.attachments.get((await service.getAutomationView(automationId)).taskAttachmentId);
  assert.equal(attachment.deadlineAt, '2026-08-10T18:00:00+08:00');
  // remind flow runAt 跟随新截止（否则 validateFlow 会失败，能保存说明已同步）
  const flows = await Promise.all(flowIds.map(id => service.flows.get(id)));
  const remind = flows.find(f => f.templateId === 'homework_remind_v1');
  assert.equal(remind.hook.params.runAt, '2026-08-10T18:00:00+08:00');
  service.db.close();
});

test('编辑改名单：新增成员成功，已提交成员状态在 merge 中保留', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask(fullInput());
  const view0 = await service.getAutomationView(automationId);
  const attachmentId = view0.taskAttachmentId;
  // 先让测试成员甲提交（直接改附件模拟已登记）
  const att = await service.attachments.get(attachmentId);
  att.members[0].submissionStatus = 'submitted'; att.members[0].filePath = '/demo/submissions/x.docx'; att.members[0].lastSubmittedAt = now(); att.members[0].reminderStatus = 'not_needed';
  await service.saveAttachment(att);
  // 编辑名单：保留测试成员甲(已交)、去掉测试成员乙(未交)、新增测试成员丙
  const view = await service.editAutomationTask(automationId, { roster: [
    { userId: '2000012345', name: '测试成员甲', studentId: '20240101' },
    { userId: '2000012347', name: '测试成员丙', studentId: '20240103' }
  ] });
  const att2 = await service.attachments.get(attachmentId);
  const wukong = att2.members.find(m => m.userId === '2000012345');
  assert.equal(wukong.submissionStatus, 'submitted', '已提交成员状态保留');
  assert.equal(wukong.filePath, '/demo/submissions/x.docx');
  assert.ok(att2.members.find(m => m.userId === '2000012347'), '新成员已加入');
  assert.equal(att2.members.find(m => m.userId === '2000012346'), undefined, '未交成员可移除');
  assert.equal(view.memberCount, 2);
  service.db.close();
});

test('编辑改名单：移除已提交成员被拒（不静默丢失已登记）', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask(fullInput());
  const attachmentId = (await service.getAutomationView(automationId)).taskAttachmentId;
  const att = await service.attachments.get(attachmentId);
  att.members[0].submissionStatus = 'submitted'; att.members[0].filePath = '/demo/x.docx'; att.members[0].lastSubmittedAt = now(); att.members[0].reminderStatus = 'not_needed';
  await service.saveAttachment(att);
  // 尝试移除已提交的测试成员甲 → 报错
  await assert.rejects(() => service.editAutomationTask(automationId, { roster: [
    { userId: '2000012346', name: '测试成员乙', studentId: '20240102' }
  ] }), err => {
    assert.ok(err instanceof ManagementError);
    assert.equal(err.code, 'EDIT_INPUT_INVALID');
    assert.ok(err.errors.some(e => e.code === 'REMOVE_SUBMITTED'));
    return true;
  });
  service.db.close();
});

test('编辑保留旧 Run 快照：改文案后已执行 Run 的 flowSnapshot 不变', async () => {
  const service = await newService();
  const { automationId, taskAttachmentId } = await service.createAutomationTask(fullInput());
  const publishFlow = (await service.flows.list()).find(f => f.templateId === 'homework_publish_v1');
  service.adapters.receiveFile({ fileId: 'fn', name: 'w3.pdf', path: '/demo/w3.pdf' });
  const [run] = await service.dispatch({ schemaVersion: '0.3-rc1', eventId: 'event_edit_pub', type: 'self_message_sent', occurredAt: now(),
    payload: { messageId: 'm', conversationId: publishFlow.hook.params.conversationId, senderUserId: '9000012345', text: publishFlow.hook.params.keyword } });
  assert.equal(run.status, 'succeeded');
  const oldText = run.flowSnapshot.actions[1].params.text;
  // 编辑发布文案
  await service.editAutomationTask(automationId, { publishText: '新的发布文案' });
  const runAfter = await service.runs.get(run.runId);
  assert.equal(runAfter.flowSnapshot.actions[1].params.text, oldText, '历史 Run 快照不被编辑污染');
  service.db.close();
});

// P1-A（reviewer P2-#4）：编辑后的后续事件用新配置执行。
test('编辑后后续事件用新配置：改发布文案后再触发，运行用新文案', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask(fullInput());
  await service.editAutomationTask(automationId, { publishText: '改后的发布内容' });
  const publishFlow = (await service.flows.list()).find(f => f.templateId === 'homework_publish_v1');
  service.adapters.receiveFile({ fileId: 'fn2', name: 'w3.pdf', path: '/demo/w3.pdf' });
  const [run] = await service.dispatch({ schemaVersion: '0.3-rc1', eventId: 'event_after_edit', type: 'self_message_sent', occurredAt: now(),
    payload: { messageId: 'm', conversationId: publishFlow.hook.params.conversationId, senderUserId: '9000012345', text: publishFlow.hook.params.keyword } });
  assert.equal(run.status, 'succeeded');
  assert.equal(run.flowSnapshot.actions[1].params.text, '改后的发布内容', '后续事件用编辑后的新配置');
  service.db.close();
});

// P1-A（reviewer P2-#4）：暂停后恢复，任务可再次被事件触发。
test('恢复后可执行：paused→enabled 后事件能再次触发运行', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask(fullInput());
  await service.setAutomationStatus(automationId, 'paused');
  const publishFlow = (await service.flows.list()).find(f => f.templateId === 'homework_publish_v1');
  // 暂停中：dispatch 不产生运行（Flow disabled）
  const pausedRuns = await service.dispatch({ schemaVersion: '0.3-rc1', eventId: 'event_paused', type: 'self_message_sent', occurredAt: now(),
    payload: { messageId: 'm', conversationId: publishFlow.hook.params.conversationId, senderUserId: '9000012345', text: publishFlow.hook.params.keyword } });
  assert.equal(pausedRuns.length, 0, '暂停时不触发');
  // 恢复后可触发
  await service.setAutomationStatus(automationId, 'enabled');
  service.adapters.receiveFile({ fileId: 'fn3', name: 'w3.pdf', path: '/demo/w3.pdf' });
  const runs = await service.dispatch({ schemaVersion: '0.3-rc1', eventId: 'event_resumed', type: 'self_message_sent', occurredAt: now(),
    payload: { messageId: 'm2', conversationId: publishFlow.hook.params.conversationId, senderUserId: '9000012345', text: publishFlow.hook.params.keyword } });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded');
  service.db.close();
});

// P1-A（reviewer P2-#4）：已结束/已删除任务不可编辑。
test('编辑 ended / deleted 任务被拒（NOT_EDITABLE）', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask(fullInput());
  await service.setAutomationStatus(automationId, 'ended');
  await assert.rejects(() => service.editAutomationTask(automationId, { taskName: '改' }), err => {
    assert.equal(err.code, 'NOT_EDITABLE'); return true;
  });
  await service.setAutomationStatus(automationId, 'deleted');
  await assert.rejects(() => service.editAutomationTask(automationId, { taskName: '改' }), err => {
    assert.equal(err.code, 'NOT_EDITABLE'); return true;
  });
  service.db.close();
});

// P1-A（reviewer P2-#4）：单能力任务（纯 remind）编辑不因缺 collect 字段出错，且改 deadline 不触发无意义重建。
test('单能力任务编辑：纯 remind 改提醒文案成功', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask({ capabilities: ['remind'], taskName: '到点提醒', remindAt: '2026-08-01T09:00:00+08:00', remindText: '该做某事' });
  const view = await service.editAutomationTask(automationId, { remindText: '新的提醒内容' });
  assert.equal(view.name, '到点提醒');
  const remind = (await service.flows.list()).find(f => f.templateId === 'homework_remind_v1');
  assert.equal(remind.actions[2].params.text, '新的提醒内容');
  service.db.close();
});

test('已有收作业任务可追加催交：复用附件、保留提交状态并幂等', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask({
    capabilities: ['collect'], taskName: '第4周作业', groupId: 'group_m',
    collectRule: { allowedExtensions: ['.docx'], keyword: '作业' },
    nameTemplate: '{studentId}_{name}{originalExtension}',
    roster: [{ userId: '2000012345', name: '测试成员甲', studentId: '20240101' }]
  });
  const before = await service.getAutomationView(automationId);
  const attachment = await service.attachments.get(before.taskAttachmentId);
  attachment.members[0].submissionStatus = 'submitted';
  attachment.members[0].filePath = '/demo/submissions/w4.docx';
  attachment.members[0].lastSubmittedAt = now();
  attachment.members[0].reminderStatus = 'not_needed';
  await service.saveAttachment(attachment);
  const view = await service.addAutomationCapability(automationId, 'remind', {
    remindAt: '2026-08-04T18:00:00+08:00', remindText: '请还未提交的同学尽快补交。'
  });
  assert.deepEqual(view.capabilities, ['collect', 'remind']);
  assert.equal(view.memberCount, 1);
  assert.equal((await service.attachments.get(before.taskAttachmentId)).members[0].submissionStatus, 'submitted');
  const remind = view.flows.find(flow => flow.templateId === 'homework_remind_v1');
  assert.equal(remind.status, 'enabled');
  const again = await service.addAutomationCapability(automationId, 'remind', { remindText: '不会覆盖' });
  assert.equal(again.flows.filter(flow => flow.templateId === 'homework_remind_v1').length, 1);
  service.db.close();
});

test('追加催交没有截止或提醒时间时返回结构化错误', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask({
    capabilities: ['collect'], taskName: '第5周作业', groupId: 'group_m',
    collectRule: { allowedExtensions: ['.docx'] }, roster: [{ userId: '2000012345', name: '测试成员甲', studentId: '20240101' }]
  });
  await assert.rejects(() => service.addAutomationCapability(automationId, 'remind'), err => {
    assert.equal(err.code, 'CAPABILITY_INPUT_INVALID');
    assert.equal(err.errors[0].field, 'remindAt');
    return true;
  });
  service.db.close();
});

test('收作业截止检查零发送，用户确认后才催交未交成员', async () => {
  const service = await newService();
  const { automationId } = await service.createAutomationTask({
    capabilities: ['collect'], taskName: '第6周作业', groupId: 'group_m', deadlineAt: '2026-08-06T18:00:00+08:00',
    collectRule: { allowedExtensions: ['.docx'] }, roster: [
      { userId: '2000012345', name: '测试成员甲', studentId: '20240101' },
      { userId: '2000012346', name: '测试成员乙', studentId: '20240102' }
    ]
  });
  const check = await service.inspectAutomationDeadline(automationId);
  assert.equal(check.missingCount, 2);
  assert.deepEqual((await service.getAutomationView(automationId)).capabilities, ['collect']);
  assert.equal(service.adapters.snapshot().directMessages.length, 0);
  const result = await service.sendAutomationReminderNow(automationId);
  assert.equal(result.run.status, 'succeeded');
  assert.equal(result.sentCount, 2);
  assert.deepEqual(result.view.capabilities, ['collect', 'remind']);
  assert.equal(service.adapters.snapshot().directMessages.length, 2);
  service.db.close();
});
