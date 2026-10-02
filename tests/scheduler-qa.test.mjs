import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { EngineService } from '../engine/index.mjs';

const runAt = '2026-08-01T10:00:00+08:00';
const dueUtc = '2026-08-01T02:00:00Z';

async function dataDir() { return mkdtemp(join(tmpdir(), 'local-auto-helper-scheduler-qa-')); }

function scheduledPublish(overrides = {}) {
  return {
    capabilities: ['publish'],
    taskName: 'QA定时通知',
    groupId: 'group_qa',
    publishText: '到点发送',
    noticeFilePath: '/demo/source/qa.pdf',
    publishAt: runAt,
    publishTrigger: 'scheduled',
    ...overrides
  };
}

test('ended 与 deleted 任务到期及重启后均不补触发', async () => {
  for (const status of ['ended', 'deleted']) {
    const dir = await dataDir();
    const first = new EngineService({ dataDir: dir });
    const created = await first.createAutomationTask(scheduledPublish({ taskName: `QA-${status}` }));
    await first.setAutomationStatus(created.automationId, status);
    assert.deepEqual(await first.tickScheduler(dueUtc), []);
    first.db.close();

    const restarted = new EngineService({ dataDir: dir });
    assert.deepEqual(await restarted.tickScheduler('2026-08-01T02:01:00Z'), []);
    assert.equal((await restarted.runs.listByFlow(created.flowIds[0])).length, 0);
    restarted.db.close();
  }
});

test('执行前编辑 runAt 后旧时点失效，新时点执行一次', async () => {
  const service = new EngineService({ dataDir: await dataDir() });
  const created = await service.createAutomationTask(scheduledPublish());
  service.adapters.receiveFile({ fileId: 'qa_notice', name: 'qa.pdf', path: '/demo/source/qa.pdf' });
  const flow = await service.flows.get(created.flowIds[0]);
  flow.hook.params.runAt = '2026-08-01T11:00:00+08:00';
  await service.saveFlow(flow);

  assert.deepEqual(await service.tickScheduler(runAt), []);
  assert.equal((await service.tickScheduler('2026-08-01T11:00:00+08:00')).length, 1);
  assert.deepEqual(await service.tickScheduler('2026-08-01T12:00:00+08:00'), []);
  service.db.close();
});

test('runAt 以绝对时间比较，等价 UTC 时刻可触发', async () => {
  const service = new EngineService({ dataDir: await dataDir() });
  const created = await service.createAutomationTask(scheduledPublish());
  service.adapters.receiveFile({ fileId: 'qa_utc', name: 'qa.pdf', path: '/demo/source/qa.pdf' });
  const runs = await service.tickScheduler(dueUtc);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].eventSnapshot.payload.scheduledFor, runAt);
  assert.equal(Date.parse(runs[0].eventSnapshot.occurredAt), Date.parse(dueUtc));
  assert.equal((await service.runs.listByFlow(created.flowIds[0])).length, 1);
  service.db.close();
});

test('动作失败产生 failed Run，后续扫描及重启均不自动重试', async () => {
  const dir = await dataDir();
  const first = new EngineService({ dataDir: dir });
  const created = await first.createAutomationTask(scheduledPublish());
  const firstRuns = await first.tickScheduler(dueUtc);
  assert.equal(firstRuns.length, 1);
  assert.equal(firstRuns[0].status, 'failed');
  assert.equal(firstRuns[0].error.code, 'FILE_NOT_FOUND');
  assert.deepEqual(await first.tickScheduler('2026-08-01T02:01:00Z'), []);
  first.db.close();

  const restarted = new EngineService({ dataDir: dir });
  restarted.adapters.receiveFile({ fileId: 'qa_late', name: 'qa.pdf', path: '/demo/source/qa.pdf' });
  assert.deepEqual(await restarted.tickScheduler('2026-08-01T02:02:00Z'), []);
  assert.equal((await restarted.runs.listByFlow(created.flowIds[0])).length, 1);
  restarted.db.close();
});

test('后台调度 start 幂等、使用 enqueue 串行入口，stop 后不再扫描', async () => {
  let now = new Date('2026-08-01T01:59:59Z');
  let enqueued = 0;
  const service = new EngineService({
    dataDir: await dataDir(),
    schedulerClock: () => now,
    schedulerIntervalMs: 10
  });
  await service.createAutomationTask(scheduledPublish());
  service.adapters.receiveFile({ fileId: 'qa_lifecycle', name: 'qa.pdf', path: '/demo/source/qa.pdf' });
  const enqueue = task => { enqueued += 1; return task(); };

  service.startScheduler({ enqueue });
  service.startScheduler({ enqueue });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await service.runs.list()).length, 0);

  now = new Date(dueUtc);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await service.runs.list()).length, 1);
  assert.ok(enqueued >= 1, '到期扫描应经过 enqueue 串行入口');

  service.stopScheduler();
  service.stopScheduler();
  const enqueueCount = enqueued;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(enqueued, enqueueCount);
  service.db.close();
});

test('HTTP服务生命周期：重启后后台调度补触发，重复扫描仍只有一次', async () => {
  const dir = await dataDir();
  const port = 43573;
  const base = `http://127.0.0.1:${port}`;
  let child;
  const start = async disabled => {
    const proc = spawn(process.execPath, ['demo/server.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        PORT: String(port),
        AUTO_HELPER_DATA_DIR: dir,
        ...(disabled ? { AUTO_HELPER_SCHEDULER_DISABLED: '1' } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('QA HTTP服务启动超时')), 5000);
      proc.once('exit', code => reject(new Error(`QA HTTP服务异常退出 ${code}`)));
      proc.stdout.on('data', chunk => {
        if (chunk.toString().includes('Demo已启动')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    return proc;
  };
  const stop = async proc => {
    if (!proc || proc.exitCode !== null) return;
    await new Promise(resolve => {
      proc.once('exit', resolve);
      proc.kill();
    });
  };
  const state = async () => (await fetch(`${base}/api/state`)).json();

  try {
    child = await start(true);
    const response = await fetch(`${base}/api/automation-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scheduledPublish({
        taskName: 'HTTP重启恢复',
        publishAt: '2020-01-01T10:00:00+08:00'
      }))
    });
    assert.equal(response.ok, true);
    const created = (await response.json()).result;
    assert.equal((await state()).runs.length, 0, '关闭调度时不应执行');
    await stop(child);

    child = await start(false);
    const deadline = Date.now() + 3500;
    let current;
    do {
      current = await state();
      if (current.runs.some(item => created.flowIds.includes(item.flowId))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    const runs = current.runs.filter(item => created.flowIds.includes(item.flowId));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded');

    await new Promise(resolve => setTimeout(resolve, 1100));
    const after = await state();
    assert.equal(after.runs.filter(item => created.flowIds.includes(item.flowId)).length, 1);
  } finally {
    await stop(child);
  }
});
