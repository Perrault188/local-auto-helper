import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineService, CreationValidationError } from '../engine/index.mjs';

let clockIndex = 0;
const now = () => `2026-07-21T10:00:${String(clockIndex++).padStart(2, '0')}+08:00`;
async function tempDir() { return mkdtemp(join(tmpdir(), 'local-auto-helper-create-')); }

function validInput(overrides = {}) {
  return {
    taskName: '软件工程第5周作业',
    groupId: 'group_se_2024_1',
    publishText: '请在本周日 18 点前提交第5周作业。',
    noticeFilePath: '/demo/source/第5周作业.pdf',
    publishAt: '2026-07-28T10:00:00+08:00',
    deadlineAt: '2026-08-02T18:00:00+08:00',
    collectRule: { allowedExtensions: ['.docx', '.pdf'], keyword: '作业' },
    nameTemplate: '{studentId}_{name}{originalExtension}',
    remindText: '本周作业即将截止，请尽快提交。',
    roster: [
      { userId: '2000012345', name: '测试成员甲', studentId: '20240101' },
      { userId: '2000012346', name: '测试成员乙', studentId: '20240102' }
    ],
    ...overrides
  };
}

async function newService() {
  clockIndex = 0;
  return new EngineService({ backend: 'sqlite', dataDir: await tempDir(), now });
}

test('从零创建真实任务：生成唯一 id 与专属对象，不复用固定 demo id', async () => {
  const service = await newService();
  const result = await service.createAutomationTask(validInput());
  assert.match(result.automationId, /^automation_[a-f0-9]+$/);
  assert.match(result.taskAttachmentId, /^task_[a-f0-9]+$/);
  assert.notEqual(result.taskAttachmentId, 'task_se_week03_demo');
  assert.equal(result.flowIds.length, 3);
  result.flowIds.forEach(fid => assert.match(fid, /^flow_[a-f0-9]+$/));

  // 附件、三条 Flow、通用对象都已落库且指向本任务。
  const attachment = await service.attachments.get(result.taskAttachmentId);
  assert.equal(attachment.taskName, '软件工程第5周作业');
  assert.equal(attachment.members.length, 2);
  assert.equal(attachment.members[0].submissionStatus, 'unsubmitted');
  const flows = await service.flows.list();
  assert.equal(flows.length, 3);
  for (const flow of flows) assert.equal(flow.taskAttachmentId, result.taskAttachmentId);
  const automation = await service.automations.get(result.automationId);
  assert.deepEqual(automation.flowIds, result.flowIds);
  assert.equal((await service.resources.get(result.resourceId)).kind, 'EducationAssignmentPack');
  assert.equal((await service.entityDirectories.get(result.entityDirectoryId)).matchKey, 'userId');
  assert.equal((await service.recordStores.get(result.recordStoreId)).records.length, 2);
  service.db.close();
});

test('三条内部 Flow 为发布/收取/催交且引用本任务专属附件与规则', async () => {
  const service = await newService();
  const result = await service.createAutomationTask(validInput());
  const flows = await service.flows.list();
  const byTemplate = Object.fromEntries(flows.map(f => [f.templateId, f]));
  assert.ok(byTemplate.homework_publish_v1 && byTemplate.homework_collect_v1 && byTemplate.homework_remind_v1);
  assert.equal(byTemplate.homework_publish_v1.hook.type, 'self_message');
  assert.equal(byTemplate.homework_collect_v1.hook.params.groupId, 'group_se_2024_1');
  assert.deepEqual(byTemplate.homework_collect_v1.hook.params.allowedExtensions, ['.docx', '.pdf']);
  assert.equal(byTemplate.homework_collect_v1.hook.params.keyword, '作业');
  assert.equal(byTemplate.homework_remind_v1.hook.params.runAt, '2026-08-02T18:00:00+08:00');
  service.db.close();
});

test('创建两个不同任务：各自 Flow 与资源独立、互不串扰', async () => {
  const service = await newService();
  const a = await service.createAutomationTask(validInput({ taskName: '任务甲', groupId: 'group_a' }));
  const b = await service.createAutomationTask(validInput({
    taskName: '任务乙', groupId: 'group_b',
    roster: [{ userId: '3000012345', name: '测试成员丁', studentId: '20240201' }]
  }));
  assert.notEqual(a.automationId, b.automationId);
  assert.notEqual(a.taskAttachmentId, b.taskAttachmentId);
  assert.equal(new Set([...a.flowIds, ...b.flowIds]).size, 6);

  // 甲有 2 人、群 group_a；乙有 1 人、群 group_b，互不影响。
  const attachA = await service.attachments.get(a.taskAttachmentId);
  const attachB = await service.attachments.get(b.taskAttachmentId);
  assert.equal(attachA.members.length, 2);
  assert.equal(attachB.members.length, 1);
  assert.equal(attachA.groupId, 'group_a');
  assert.equal(attachB.groupId, 'group_b');
  assert.equal((await service.flows.list()).length, 6);
  assert.equal((await service.automations.list()).length, 2);
  service.db.close();
});

test('发布 Flow 初始化动作指向本任务附件，可真实发布并初始化本任务资源', async () => {
  const service = await newService();
  const result = await service.createAutomationTask(validInput());
  const publishFlow = (await service.flows.list()).find(f => f.templateId === 'homework_publish_v1');
  // 触发本任务发布 Flow 的 self_message hook。
  const event = {
    schemaVersion: '0.2-rc1', eventId: 'event_create_publish', type: 'self_message_sent', occurredAt: now(),
    payload: { messageId: 'msg_1', conversationId: publishFlow.hook.params.conversationId, senderUserId: '9000012345', text: `发布 ${publishFlow.hook.params.keyword}` }
  };
  // 通知文件需在 Mock 文件系统中存在，发布才能发送成功。
  service.adapters.receiveFile({ fileId: 'file_notice', name: '第5周作业.pdf', path: '/demo/source/第5周作业.pdf' });
  const [run] = await service.dispatch(event);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.steps[0].actionType, 'initialize_task_attachment');
  assert.equal(run.steps[0].output.taskAttachmentId, result.taskAttachmentId);
  service.db.close();
});

test('名单校验：重复 用户ID、缺字段、非法命名模板返回字段级结构化错误', async () => {
  const service = await newService();
  // 重复 用户ID + 缺姓名
  try {
    await service.createAutomationTask(validInput({
      roster: [
        { userId: '2000012345', name: '甲', studentId: '20240101' },
        { userId: '2000012345', name: '', studentId: '20240102' }
      ]
    }));
    assert.fail('应抛出校验错误');
  } catch (error) {
    assert.ok(error instanceof CreationValidationError);
    assert.equal(error.code, 'CREATION_INPUT_INVALID');
    assert.ok(error.errors.some(e => e.code === 'USER_ID_DUPLICATE' && e.row === 2));
    assert.ok(error.errors.some(e => e.code === 'NAME_REQUIRED' && e.row === 2));
  }

  // 非法命名模板（含路径分隔符）
  try {
    await service.createAutomationTask(validInput({ nameTemplate: '{studentId}/{name}{originalExtension}' }));
    assert.fail('应抛出校验错误');
  } catch (error) {
    assert.ok(error instanceof CreationValidationError);
    assert.ok(error.errors.some(e => e.field === 'nameTemplate' && e.code === 'ILLEGAL_CHAR'));
  }

  // 非法 用户ID 格式 + 截止早于发布
  try {
    await service.createAutomationTask(validInput({
      deadlineAt: '2026-07-27T10:00:00+08:00',
      roster: [{ userId: '?', name: '乙', studentId: '20240103' }]
    }));
    assert.fail('应抛出校验错误');
  } catch (error) {
    assert.ok(error.errors.some(e => e.code === 'USER_ID_FORMAT' && e.row === 1));
    assert.ok(error.errors.some(e => e.field === 'deadlineAt' && e.code === 'RANGE'));
  }

  // 创建失败不应产生残留数据（第一次失败后库应为空）
  assert.equal((await service.automations.list()).length, 0);
  assert.equal((await service.flows.list()).length, 0);
  service.db.close();
});

test('重启后两个任务仍各自独立留存', async () => {
  clockIndex = 0;
  const dataDir = await tempDir();
  const first = new EngineService({ backend: 'sqlite', dataDir, now });
  const a = await first.createAutomationTask(validInput({ taskName: '甲', groupId: 'group_a' }));
  const b = await first.createAutomationTask(validInput({ taskName: '乙', groupId: 'group_b', roster: [{ userId: '3000019999', name: '丙', studentId: '20240301' }] }));
  first.db.close();

  const restarted = new EngineService({ backend: 'sqlite', dataDir, now });
  assert.equal((await restarted.automations.list()).length, 2);
  assert.equal((await restarted.flows.list()).length, 6);
  assert.equal((await restarted.attachments.get(a.taskAttachmentId)).groupId, 'group_a');
  assert.equal((await restarted.attachments.get(b.taskAttachmentId)).members.length, 1);
  restarted.db.close();
});
