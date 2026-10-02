import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const port = 43379;
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
    proc.stdout.on('data', chunk => {
      if (chunk.toString().includes('Demo已启动')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return proc;
}

async function stopServer(proc) {
  if (!proc) return;
  await new Promise(resolve => {
    proc.once('exit', resolve);
    proc.kill();
  });
}

async function jsonRequest(path, method = 'GET', value) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value)
  });
  const data = await response.json();
  return { response, data };
}

function taskInput(index) {
  const suffix = String(index).padStart(2, '0');
  return {
    taskName: `P2-S3第${index}次主演示`,
    groupId: `group_p2s3_${suffix}`,
    publishText: `第${index}次主演示通知`,
    noticeFilePath: `/demo/source/p2s3-${suffix}.pdf`,
    publishAt: `2026-08-${11 + index}T10:00:00+08:00`,
    deadlineAt: `2026-08-${15 + index}T18:00:00+08:00`,
    collectRule: { allowedExtensions: ['.docx'] },
    nameTemplate: '{studentId}_{name}{originalExtension}',
    remindText: `第${index}次主演示催交`,
    roster: [1, 2, 3].map(member => ({
      userId: `66${suffix}00000${member}`,
      name: `成员${index}-${member}`,
      studentId: `S${suffix}${member}`
    }))
  };
}

async function createTask(index) {
  const result = await jsonRequest('/api/automation-tasks', 'POST', taskInput(index));
  assert.equal(result.response.ok, true, JSON.stringify(result.data));
  return result.data.result;
}

async function mockRun(automationId, capability) {
  const result = await jsonRequest(`/api/automation-tasks/${automationId}/mock-run`, 'POST', { capability });
  assert.equal(result.response.ok, true, JSON.stringify(result.data));
  assert.ok(result.data.run, `${capability}应产生当前任务的Run`);
  return result.data;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'local-auto-helper-p2s3-'));
  child = await startServer();
});

after(() => stopServer(child));

test('P2-S3从空数据连续完成三次所选任务主演示', async () => {
  const initial = (await jsonRequest('/api/state')).data;
  assert.deepEqual(initial.automations, []);

  for (let index = 1; index <= 3; index += 1) {
    const task = await createTask(index);
    assert.equal((await mockRun(task.automationId, 'publish')).run.status, 'succeeded');
    assert.equal((await mockRun(task.automationId, 'collect')).run.status, 'succeeded');
    assert.equal((await mockRun(task.automationId, 'collect')).run.status, 'succeeded');
    assert.equal((await mockRun(task.automationId, 'remind')).run.status, 'succeeded');

    const evidence = await jsonRequest(`/api/automation-tasks/${task.automationId}/evidence`);
    assert.deepEqual(evidence.data.progress, { expected: 3, received: 2, missing: 1 });
    assert.equal(evidence.data.artifacts.length, 2);
    assert.equal(evidence.data.deliveries.group.succeeded, 1);
    assert.equal(evidence.data.deliveries.receipt.succeeded, 2);
    assert.equal(evidence.data.deliveries.reminder.succeeded, 1);
    assert.equal(evidence.data.messages.every(message => message.runId && message.actionId), true);
  }
});

test('P2-S3任务可暂停恢复，修改值可见且用于后续视图', async () => {
  const state = (await jsonRequest('/api/state')).data;
  const task = state.automations.find(item => item.name === 'P2-S3第1次主演示');
  assert.ok(task);
  assert.equal(task.publishText, '第1次主演示通知');
  assert.equal(task.remindText, '第1次主演示催交');

  let result = await jsonRequest(`/api/automation-tasks/${task.automationId}/status`, 'PATCH', { status: 'paused' });
  assert.equal(result.data.view.status, 'paused');
  assert.equal(result.data.view.flows.every(flow => flow.status === 'disabled'), true);

  result = await jsonRequest(`/api/automation-tasks/${task.automationId}/status`, 'PATCH', { status: 'enabled' });
  assert.equal(result.data.view.status, 'enabled');
  assert.equal(result.data.view.flows.every(flow => flow.status === 'enabled'), true);

  result = await jsonRequest(`/api/automation-tasks/${task.automationId}`, 'PATCH', {
    publishText: '修改后的主演示通知',
    remindText: '修改后的主演示催交'
  });
  assert.equal(result.data.view.publishText, '修改后的主演示通知');
  assert.equal(result.data.view.remindText, '修改后的主演示催交');
});

test('P2-S3服务重启后任务、运行、消息和汇报一致恢复', async () => {
  const beforeState = (await jsonRequest('/api/state')).data;
  const beforeEvidence = new Map();
  for (const task of beforeState.automations) {
    beforeEvidence.set(task.automationId, (await jsonRequest(`/api/automation-tasks/${task.automationId}/evidence`)).data);
  }

  await stopServer(child);
  child = await startServer();

  const afterState = (await jsonRequest('/api/state')).data;
  assert.equal(afterState.automations.length, 3);
  for (const task of afterState.automations) {
    const before = beforeEvidence.get(task.automationId);
    const after = (await jsonRequest(`/api/automation-tasks/${task.automationId}/evidence`)).data;
    assert.deepEqual(after.progress, before.progress);
    assert.deepEqual(after.artifacts, before.artifacts);
    assert.deepEqual(after.messages, before.messages);
    assert.equal(task.totalRuns, 4);
  }
});

test('纯收作业任务推进截止时先询问，确认后才发送催交', async () => {
  const input = {
    capabilities: ['collect'], taskName: 'P2-S3截止确认', groupId: 'group_deadline_check',
    deadlineAt: '2026-08-28T18:00:00+08:00', collectRule: { allowedExtensions: ['.docx'] },
    roster: [1, 2].map(index => ({ userId: `680000000${index}`, name: `截止成员${index}`, studentId: `D20260${index}` }))
  };
  const created = await jsonRequest('/api/automation-tasks', 'POST', input);
  assert.equal(created.response.ok, true, JSON.stringify(created.data));
  const automationId = created.data.result.automationId;
  const before = (await jsonRequest('/api/state')).data;
  const directBefore = before.adapters.directMessages.length;

  const checked = await jsonRequest(`/api/automation-tasks/${automationId}/deadline-check`, 'POST', {});
  assert.equal(checked.response.ok, true, JSON.stringify(checked.data));
  assert.equal(checked.data.check.missingCount, 2);
  assert.equal(checked.data.state.adapters.directMessages.length, directBefore);
  assert.deepEqual(checked.data.state.automations.find(item => item.automationId === automationId).capabilities, ['collect']);

  const reminded = await jsonRequest(`/api/automation-tasks/${automationId}/remind-now`, 'POST', {});
  assert.equal(reminded.response.ok, true, JSON.stringify(reminded.data));
  assert.equal(reminded.data.run.status, 'succeeded');
  assert.equal(reminded.data.sentCount, 2);
  assert.equal(reminded.data.state.adapters.directMessages.length, directBefore + 2);
  assert.deepEqual(reminded.data.view.capabilities, ['collect', 'remind']);
});
