import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// P0-D 第一步集成测试：创建端点 POST /api/automation-tasks、启动不再 reset、数据重启留存。
// 与 demo-api.test.mjs 使用不同端口/数据目录，互不干扰。
const port = 43273;
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

async function stopServer(proc) {
  if (!proc) return;
  await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); });
}

async function post(path, value) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const data = await response.json();
  return { status: response.status, ok: response.ok, data };
}

function validInput(overrides = {}) {
  return {
    taskName: '软件工程第7周作业',
    groupId: 'group_se_2024_1',
    publishText: '请在本周日 18 点前提交第7周作业。',
    noticeFilePath: '/demo/source/第7周作业.pdf',
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

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'local-auto-helper-create-api-'));
  child = await startServer();
});
after(() => stopServer(child));

test('POST /api/automation-tasks 创建成功：返回 { result, state } 并落库到状态', async () => {
  const { status, data } = await post('/api/automation-tasks', validInput());
  assert.equal(status, 200);
  assert.ok(data.result, '应返回 result');
  assert.match(data.result.automationId, /^automation_[a-f0-9]+$/);
  assert.match(data.result.taskAttachmentId, /^task_[a-f0-9]+$/);
  assert.notEqual(data.result.taskAttachmentId, 'task_se_week03_demo');
  assert.equal(data.result.flowIds.length, 3);

  // state 为最新 snapshot：新任务的三条 Flow 已进入 flows；对应附件已落库。
  assert.ok(data.state, '应返回 state 快照');
  for (const fid of data.result.flowIds) assert.ok(data.state.flows.some(flow => flow.flowId === fid), `flow ${fid} 应出现在 state.flows`);
  const attachment = data.state.attachments.find(item => item.taskAttachmentId === data.result.taskAttachmentId);
  assert.ok(attachment, '本任务附件应在 state.attachments 中');
  assert.equal(attachment.taskName, '软件工程第7周作业');
  assert.equal(attachment.members.length, 2);
});

test('POST /api/automation-tasks 校验失败：返回非 2xx 且透传结构化 errors（field/code/message/row/index）', async () => {
  const { status, ok, data } = await post('/api/automation-tasks', validInput({
    taskName: '',
    collectRule: { allowedExtensions: ['bad', '.docx'] },
    nameTemplate: '{studentId}/{name}{originalExtension}',
    roster: [
      { userId: '?', name: '甲', studentId: '20240101' },
      { userId: '2000012345', name: '', studentId: '20240102' },
      { userId: '2000012345', name: '丙', studentId: '20240103' }
    ]
  }));
  assert.equal(ok, false, '校验失败应返回非 2xx');
  assert.ok(status >= 400 && status < 500, `状态码应为 4xx，实际 ${status}`);
  assert.ok(Array.isArray(data.errors), 'body 应为 { errors:[...] }');
  assert.equal(data.error, undefined, '校验失败不应返回 { error }');

  // 透传字段级结构：taskName 缺失、扩展名格式（带 index）、命名模板非法字符、名单错误（带 row）。
  assert.ok(data.errors.some(e => e.field === 'taskName' && e.code === 'REQUIRED'));
  assert.ok(data.errors.some(e => e.field === 'collectRule.allowedExtensions' && e.code === 'FORMAT' && typeof e.index === 'number'));
  assert.ok(data.errors.some(e => e.field === 'nameTemplate' && e.code === 'ILLEGAL_CHAR'));
  assert.ok(data.errors.some(e => e.field === 'roster' && e.code === 'USER_ID_FORMAT' && e.row === 1));
  assert.ok(data.errors.some(e => e.field === 'roster' && e.code === 'NAME_REQUIRED' && e.row === 2));
  assert.ok(data.errors.some(e => e.field === 'roster' && e.code === 'USER_ID_DUPLICATE' && e.row === 3));
  // 每项错误都带机器可读的 field/code/message。
  for (const item of data.errors) {
    assert.equal(typeof item.field, 'string');
    assert.equal(typeof item.code, 'string');
    assert.equal(typeof item.message, 'string');
  }
});

test('校验失败不产生残留：创建的任务数不因失败请求增加', async () => {
  const before = (await (await fetch(`${base}/api/state`)).json());
  await post('/api/automation-tasks', validInput({ roster: [] }));
  const after = (await (await fetch(`${base}/api/state`)).json());
  assert.equal(after.flows.length, before.flows.length, '校验失败不应新增 Flow');
  assert.equal(after.attachments.length, before.attachments.length, '校验失败不应新增附件');
});

test('启动不再 reset：重启后此前创建的任务仍留存（SQLite 持久化）', async () => {
  // 记录重启前状态：先前用例已成功创建 1 个任务（3 条内部 Flow）。
  const stateBefore = await (await fetch(`${base}/api/state`)).json();
  const createdFlowIds = stateBefore.flows.map(flow => flow.flowId);
  const createdAttachmentIds = stateBefore.attachments.map(item => item.taskAttachmentId);
  assert.ok(createdFlowIds.length >= 3, '重启前应至少有 3 条 Flow');

  await stopServer(child);
  child = await startServer();

  // 重启后同一数据目录：任务仍在，且启动没有清库/重置。
  const stateAfter = await (await fetch(`${base}/api/state`)).json();
  for (const fid of createdFlowIds) assert.ok(stateAfter.flows.some(flow => flow.flowId === fid), `重启后 flow ${fid} 应仍在`);
  for (const aid of createdAttachmentIds) assert.ok(stateAfter.attachments.some(item => item.taskAttachmentId === aid), `重启后附件 ${aid} 应仍在`);
  assert.equal(stateAfter.flows.length, stateBefore.flows.length, '重启不应改变 Flow 数量（未清库、未重复播种）');
});
