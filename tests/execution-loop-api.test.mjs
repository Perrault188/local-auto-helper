import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// P0-D 第二步：新建任务 → 发布 → 收到文件 → 自动登记 → 查看结果 的真实执行闭环（HTTP 集成）。
// 全部针对用户 POST /api/automation-tasks 创建的真实任务（非固定 demo id），走真实 executor。
// 触发方式：POST /api/events/dispatch 传入自定义事件；执行器按每条 flow 自带的
// conversationId/keyword/groupId/taskAttachmentId 匹配与隔离，无需引擎新增按 automationId 触发的能力。
const port = 43373;
const base = `http://127.0.0.1:${port}`;
let dataDir;
let child;

async function startServer() {
  const proc = spawn(process.execPath, ['demo/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), AUTO_HELPER_DATA_DIR: dataDir, AUTO_HELPER_SCHEDULER_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('本地Demo服务启动超时')), 5000);
    proc.once('exit', code => reject(new Error(`本地Demo服务异常退出 ${code}`)));
    proc.stdout.on('data', chunk => { if (chunk.toString().includes('Demo已启动')) { clearTimeout(timeout); resolve(); } });
  });
  return proc;
}
async function stopServer(proc) { if (!proc) return; await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); }); }

async function req(path, method = 'GET', value) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const data = await response.json();
  return { status: response.status, ok: response.ok, data };
}
async function create(input) { const r = await req('/api/automation-tasks', 'POST', input); assert.equal(r.ok, true, JSON.stringify(r.data)); return r.data.result; }
async function dispatch(event) { const r = await req('/api/events/dispatch', 'POST', event); assert.equal(r.ok, true, r.data.error); return r.data; }
async function state() { return (await req('/api/state')).data; }

let uid = 0;
const eid = tag => `event_${tag}_${Date.now()}_${uid++}`;

function taskInput(overrides = {}) {
  return {
    taskName: '数据结构第2周作业',
    groupId: 'group_ds_2024',
    publishText: '请提交第2周作业。',
    noticeFilePath: '/demo/source/数据结构第2周作业.pdf',
    publishAt: '2026-07-28T10:00:00+08:00',
    deadlineAt: '2026-08-05T18:00:00+08:00',
    collectRule: { allowedExtensions: ['.docx'], keyword: '作业' },
    nameTemplate: '{studentId}_{name}{originalExtension}',
    remindText: '第2周作业即将截止。',
    roster: [
      { userId: '2100010001', name: '测试成员甲', studentId: '20240301' },
      { userId: '2100010002', name: '测试成员乙', studentId: '20240302' }
    ],
    ...overrides
  };
}

// 通过 flowId 拿到某任务某模板的 flow（从 state 里查）。
function flowOf(st, flowIds, templateId) { return st.flows.find(f => flowIds.includes(f.flowId) && f.templateId === templateId); }

// 触发某任务的发布：self_message_sent，text 含发布 flow 的 keyword，conversationId 与其一致。
async function triggerPublish(publishFlow) {
  return dispatch({ schemaVersion: '0.2-rc1', eventId: eid('pub'), type: 'self_message_sent', occurredAt: '2026-07-28T10:05:00+08:00',
    payload: { messageId: `msg_${uid++}`, conversationId: publishFlow.hook.params.conversationId, senderUserId: '9000012345', text: `${publishFlow.hook.params.keyword}` } });
}
// 触发某任务的收取：group_file_received，群与该任务一致，文件名含 keyword 与允许扩展名，senderUserId 指定。
async function triggerSubmit(collectFlow, senderUserId, fileName) {
  const n = fileName ?? '我的作业.docx';
  return dispatch({ schemaVersion: '0.2-rc1', eventId: eid('sub'), type: 'group_file_received', occurredAt: '2026-07-29T09:00:00+08:00',
    payload: { messageId: `msg_${uid++}`, groupId: collectFlow.hook.params.groupId, senderUserId, text: '作业提交', file: { fileId: `file_${uid++}`, name: n, path: `/demo/inbox/${n}` } } });
}

before(async () => { dataDir = await mkdtemp(join(tmpdir(), 'local-auto-helper-loop-')); child = await startServer(); });
after(() => stopServer(child));

test('启动即空（策略 B）：无任何 Flow / 附件', async () => {
  const st = await state();
  assert.equal(st.flows.length, 0);
  assert.equal(st.attachments.length, 0);
});

test('新建任务闭环：发布成功 + 一次有效提交登记成功 + 一次无效提交（人员未匹配）', async () => {
  const task = await create(taskInput());
  let st = await state();
  const publishFlow = flowOf(st, task.flowIds, 'homework_publish_v1');
  const collectFlow = flowOf(st, task.flowIds, 'homework_collect_v1');
  assert.ok(publishFlow && collectFlow, '应能取到本任务的发布/收取 Flow');
  assert.equal(collectFlow.hook.params.groupId, 'group_ds_2024');

  // 1) 发布：读该任务配置/通知文件/目标群，产出发布结果（群消息 + 文件）。
  const pub = await triggerPublish(publishFlow);
  assert.equal(pub.runs.length, 1);
  assert.equal(pub.runs[0].status, 'succeeded');
  assert.equal(pub.runs[0].steps.map(s => s.actionType).join(), 'initialize_task_attachment,send_group_message_and_file');
  assert.equal(pub.state.adapters.groupMessages.filter(m => m.groupId === 'group_ds_2024').length, 1);

  // 2) 有效提交：花名册内成员提交 .docx，匹配、改名、登记写回本任务附件。
  const ok = await triggerSubmit(collectFlow, '2100010001');
  assert.equal(ok.runs[0].status, 'succeeded');
  assert.ok(ok.runs[0].steps.every(s => s.status === 'succeeded'));
  const attach = ok.state.attachments.find(a => a.taskAttachmentId === task.taskAttachmentId);
  const zhangsan = attach.members.find(m => m.userId === '2100010001');
  assert.equal(zhangsan.submissionStatus, 'submitted');
  assert.match(zhangsan.filePath, /20240301_测试成员甲\.docx$/);
  // 改名后的文件归档进 /demo/submissions（本任务提交），且回复了发送人。
  assert.ok(ok.state.adapters.files.some(f => f.sourcePath && !f.path.includes('/') && !f.sourcePath.includes('/')), '公共文件投影只暴露安全标签');
  assert.equal(ok.state.adapters.replies.length >= 1, true);

  // 3) 无效提交：非花名册 用户ID 提交，人员匹配失败，run 失败且不误登记。
  const bad = await triggerSubmit(collectFlow, '2100019999');
  assert.equal(bad.runs[0].status, 'failed');
  assert.equal(bad.runs[0].error.code, 'PERSON_NOT_FOUND');
  const attach2 = bad.state.attachments.find(a => a.taskAttachmentId === task.taskAttachmentId);
  assert.equal(attach2.members.filter(m => m.submissionStatus === 'submitted').length, 1, '仍只有 1 人已提交');
  assert.equal(bad.state.unseenFailureCount >= 1, true);

  // 查看结果：本任务运行记录可查（发布1 + 提交成功1 + 提交失败1 = 3），且与本任务 flow 关联。
  st = await state();
  const taskRuns = st.runs.filter(r => task.flowIds.includes(r.flowId));
  assert.equal(taskRuns.length, 3);
});

test('重复提交：同一成员二次提交为 succeeded_no_action，不覆盖首次文件', async () => {
  // 复用上一任务：测试成员甲已提交。构造第二个任务避免跨用例耦合，独立验证重复语义。
  const task = await create(taskInput({ taskName: '重复提交任务', groupId: 'group_dup', roster: [{ userId: '2100020001', name: '测试成员丙', studentId: '20240401' }] }));
  let st = await state();
  const publishFlow = flowOf(st, task.flowIds, 'homework_publish_v1');
  const collectFlow = flowOf(st, task.flowIds, 'homework_collect_v1');
  await triggerPublish(publishFlow);
  const first = await triggerSubmit(collectFlow, '2100020001', '第一次作业.docx');
  assert.equal(first.runs[0].status, 'succeeded');
  const firstPath = first.state.attachments.find(a => a.taskAttachmentId === task.taskAttachmentId).members[0].filePath;
  const second = await triggerSubmit(collectFlow, '2100020001', '第二次作业.docx');
  assert.equal(second.runs[0].status, 'succeeded_no_action');
  assert.equal(Object.hasOwn(second.runs[0].steps[0], 'output'), false, '公共Run不得泄漏步骤输出');
  const nowPath = second.state.attachments.find(a => a.taskAttachmentId === task.taskAttachmentId).members[0].filePath;
  assert.equal(nowPath, firstPath, '重复提交不覆盖首次文件路径');
});

test('两个不同新建任务执行结果互不串扰', async () => {
  const a = await create(taskInput({ taskName: '隔离任务甲', groupId: 'group_iso_a', roster: [{ userId: '2100030001', name: '甲同学', studentId: '20240501' }] }));
  const b = await create(taskInput({ taskName: '隔离任务乙', groupId: 'group_iso_b', roster: [{ userId: '2100030002', name: '乙同学', studentId: '20240502' }] }));
  let st = await state();
  const aCollect = flowOf(st, a.flowIds, 'homework_collect_v1');
  const bCollect = flowOf(st, b.flowIds, 'homework_collect_v1');
  await triggerPublish(flowOf(st, a.flowIds, 'homework_publish_v1'));
  await triggerPublish(flowOf(st, b.flowIds, 'homework_publish_v1'));

  // 只在甲群提交甲成员：只影响甲任务，乙任务名单不受影响。
  const submit = await triggerSubmit(aCollect, '2100030001');
  assert.equal(submit.runs[0].status, 'succeeded');
  // 甲成员在乙群提交应因群不匹配而不触发乙的收取 flow（甲的收取 flow 也因群不同不匹配）。
  const crossGroupNoMatch = await triggerSubmit(bCollect, '2100030001');
  assert.equal(crossGroupNoMatch.runs[0].status, 'failed', '乙群收到非乙成员文件应人员匹配失败');
  assert.equal(crossGroupNoMatch.runs[0].error.code, 'PERSON_NOT_FOUND');

  st = await state();
  const attachA = st.attachments.find(x => x.taskAttachmentId === a.taskAttachmentId);
  const attachB = st.attachments.find(x => x.taskAttachmentId === b.taskAttachmentId);
  assert.equal(attachA.members.find(m => m.userId === '2100030001').submissionStatus, 'submitted');
  assert.equal(attachB.members[0].submissionStatus, 'unsubmitted', '乙任务不受甲提交影响');
});

test('重启后新建任务与其运行记录仍在（SQLite 持久化）', async () => {
  const before = await state();
  const flowCountBefore = before.flows.length;
  const runCountBefore = before.runs.length;
  const sampleAttachmentId = before.attachments[0].taskAttachmentId;
  assert.ok(flowCountBefore > 0 && runCountBefore > 0);

  await stopServer(child);
  child = await startServer();

  const after = await state();
  assert.equal(after.flows.length, flowCountBefore, '重启后 Flow 数量不变（未清库、启动不播种）');
  assert.equal(after.runs.length, runCountBefore, '重启后运行记录仍在');
  assert.ok(after.attachments.some(a => a.taskAttachmentId === sampleAttachmentId), '重启后任务附件仍在');
});
