import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const port = 43173;
const base = `http://127.0.0.1:${port}`;
let child;

async function api(path, method = 'GET', value) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const data = await response.json();
  assert.equal(response.ok, true, data.error);
  return data;
}

before(async () => {
  child = spawn(process.execPath, ['demo/server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), AUTO_HELPER_DATA_DIR: await mkdtemp(join(tmpdir(), 'local-auto-helper-demo-api-')), AUTO_HELPER_SCHEDULER_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('本地Demo服务启动超时')), 5000);
    child.once('exit', code => reject(new Error(`本地Demo服务异常退出 ${code}`)));
    child.stdout.on('data', chunk => { if (chunk.toString().includes('Demo已启动')) { clearTimeout(timeout); resolve(); } });
  });
});
after(() => child?.kill());

test('一条命令启动后同时提供前端；启动即空，显式恢复演示数据后有权威状态', async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /本地助手自动帮办Demo/);
  // 播种策略 B：启动即空，无任何 Flow/附件。
  const empty = await api('/api/state');
  assert.equal(empty.flows.length, 0);
  assert.equal(empty.attachments.length, 0);
  // 显式恢复主演示初始状态（/api/reset -> resetDemo）后，班委演示数据到位。
  await api('/api/reset', 'POST');
  const state = await api('/api/state');
  assert.equal(state.flows.length, 3);
  assert.equal(state.attachments[0].members.length, 5);
  assert.equal(state.runs.length, 0);
});

test('发布、正常提交、映射失败、重复提交和到期全部经EngineService分发', async () => {
  await api('/api/reset', 'POST');
  assert.equal((await api('/api/events/event_publish_normal/dispatch', 'POST')).runs[0].status, 'succeeded');
  assert.equal((await api('/api/events/event_submit_normal/dispatch', 'POST')).runs[0].status, 'succeeded');
  assert.equal((await api('/api/events/event_submit_unmapped/dispatch', 'POST')).runs[0].error.code, 'PERSON_NOT_FOUND');
  assert.equal((await api('/api/events/event_submit_duplicate/dispatch', 'POST')).runs[0].status, 'succeeded_no_action');
  const reminded = await api('/api/events/event_timer_with_pending/dispatch', 'POST');
  assert.equal(reminded.runs[0].status, 'succeeded');
  assert.equal(reminded.state.adapters.groupMessages.length, 1);
  assert.equal(reminded.state.adapters.replies.length, 1);
  assert.equal(reminded.state.adapters.files.filter(file => file.sourcePath).length, 1);
  assert.equal(reminded.state.adapters.directMessages.length, 4);
  assert.equal(reminded.state.unseenFailureCount, 1);
});

test('查看失败详情后异常徽标清零', async () => {
  const state = await api('/api/state');
  const failed = state.runs.find(run => run.status === 'failed');
  const viewed = await api(`/api/runs/${failed.runId}/viewed`, 'POST');
  assert.equal(viewed.unseenFailureCount, 0);
  assert.ok(viewed.runs.find(run => run.runId === failed.runId).viewedAt);
});

test('前端参数生成的Flow可保存、停用、启用和软删除', async () => {
  await api('/api/reset', 'POST');
  const state = await api('/api/state');
  const flow = structuredClone(state.flows.find(item => item.flowId === 'flow_publish_demo'));
  flow.name = '前端参数生成的发布帮办';
  flow.actions[1].params.text = '这是前端填写的通知';
  flow.updatedAt = '2026-07-21T11:00:00+08:00';
  assert.equal((await api('/api/flows', 'POST', flow)).flows.find(item => item.flowId === flow.flowId).name, flow.name);
  assert.equal((await api(`/api/flows/${flow.flowId}/status`, 'PATCH', { status: 'disabled' })).flows.find(item => item.flowId === flow.flowId).status, 'disabled');
  assert.equal((await api(`/api/flows/${flow.flowId}/status`, 'PATCH', { status: 'enabled' })).flows.find(item => item.flowId === flow.flowId).status, 'enabled');
  assert.equal((await api(`/api/flows/${flow.flowId}/status`, 'PATCH', { status: 'deleted' })).flows.some(item => item.flowId === flow.flowId), false);
});

test('连续重置并演示三次不产生脏数据或重复发送', async () => {
  for (let index = 0; index < 3; index += 1) {
    const reset = await api('/api/reset', 'POST');
    assert.equal(reset.runs.length, 0);
    assert.equal(reset.adapters.groupMessages.length, 0);
    const first = await api('/api/events/event_publish_normal/dispatch', 'POST');
    const second = await api('/api/events/event_publish_normal/dispatch', 'POST');
    assert.equal(first.runs[0].runId, second.runs[0].runId);
    assert.equal(second.state.runs.length, 1);
    assert.equal(second.state.adapters.groupMessages.length, 1);
  }
});
