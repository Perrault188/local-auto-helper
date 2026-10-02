import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineService, scheduledEventId } from '../engine/index.mjs';

const runAt = '2026-08-01T10:00:00+08:00';
const dueUtc = '2026-08-01T02:00:00Z';
const beforeRunAt = '2026-08-01T09:59:59+08:00';
const afterRunAt = '2026-08-01T10:00:01+08:00';

async function dataDir() { return mkdtemp(join(tmpdir(), 'local-auto-helper-scheduler-')); }

function scheduledPublish(overrides = {}) {
  return {
    capabilities: ['publish'],
    taskName: '定时通知',
    groupId: 'group_schedule',
    publishText: '到点发送',
    noticeFilePath: '/demo/source/定时通知.pdf',
    publishAt: runAt,
    publishTrigger: 'scheduled',
    ...overrides
  };
}

function remindClosure(overrides = {}) {
  return {
    capabilities: ['collect', 'remind'],
    taskName: '到期催交',
    groupId: 'group_remind',
    deadlineAt: runAt,
    remindAt: runAt,
    collectRule: { allowedExtensions: ['.docx'], keyword: '作业' },
    nameTemplate: '{studentId}_{name}{originalExtension}',
    remindText: '请尽快提交',
    roster: [{ userId: '2100099999', name: '待交成员', studentId: '20249999' }],
    ...overrides
  };
}

test('到点前不执行，到点后自动派发一次，重复 tick 不重复', async () => {
  const service = new EngineService({ dataDir: await dataDir() });
  const created = await service.createAutomationTask(scheduledPublish());
  service.adapters.receiveFile({ fileId: 'notice_schedule', name: '定时通知.pdf', path: '/demo/source/定时通知.pdf' });
  const flow = await service.flows.get(created.flowIds[0]);

  assert.deepEqual(await service.tickScheduler(beforeRunAt), []);
  const first = await service.tickScheduler(runAt);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'succeeded');
  assert.equal(first[0].eventId, scheduledEventId(flow.flowId, runAt));
  assert.equal(service.adapters.snapshot().groupMessages.length, 1);

  assert.deepEqual(await service.tickScheduler(afterRunAt), []);
  assert.equal((await service.runs.listByFlow(flow.flowId)).length, 1);
  assert.equal(service.adapters.snapshot().groupMessages.length, 1);
  service.db.close();
});

test('paused 跨过 runAt 不执行，恢复后补触发一次', async () => {
  const service = new EngineService({ dataDir: await dataDir() });
  const created = await service.createAutomationTask(scheduledPublish({ taskName: '暂停后补触发' }));
  service.adapters.receiveFile({ fileId: 'notice_paused', name: '定时通知.pdf', path: '/demo/source/定时通知.pdf' });

  await service.setAutomationStatus(created.automationId, 'paused');
  assert.deepEqual(await service.tickScheduler(afterRunAt), []);
  await service.setAutomationStatus(created.automationId, 'enabled');
  assert.equal((await service.tickScheduler(afterRunAt)).length, 1);
  assert.deepEqual(await service.tickScheduler(afterRunAt), []);
  service.db.close();
});

test('SQLite 重启恢复未开始计划，跨过 runAt 后补触发', async () => {
  const dir = await dataDir();
  const first = new EngineService({ dataDir: dir });
  const created = await first.createAutomationTask(remindClosure({ taskName: '重启恢复催交' }));
  const remindFlowId = created.flowIds[1];
  assert.deepEqual(await first.tickScheduler(beforeRunAt), []);
  first.db.close();

  const restarted = new EngineService({ dataDir: dir });
  const runs = await restarted.tickScheduler(afterRunAt);
  assert.equal(runs.length, 1);
  assert.equal((await restarted.runs.listByFlow(remindFlowId)).length, 1);
  assert.equal(restarted.adapters.snapshot().directMessages.length, 1);
  restarted.db.close();
});

test('Flow 已有任何 Run 后，修改 runAt 也不自动二次执行', async () => {
  const service = new EngineService({ dataDir: await dataDir() });
  const created = await service.createAutomationTask(scheduledPublish({ taskName: '执行后改时点' }));
  service.adapters.receiveFile({ fileId: 'notice_edit', name: '定时通知.pdf', path: '/demo/source/定时通知.pdf' });
  await service.tickScheduler(runAt);

  const flow = await service.flows.get(created.flowIds[0]);
  flow.hook.params.runAt = '2026-08-01T11:00:00+08:00';
  flow.updatedAt = '2026-08-01T10:30:00+08:00';
  await service.saveFlow(flow);
  assert.deepEqual(await service.tickScheduler('2026-08-01T11:00:01+08:00'), []);
  assert.equal((await service.runs.listByFlow(flow.flowId)).length, 1);
  assert.equal(service.adapters.snapshot().groupMessages.length, 1);
  service.db.close();
});

test('多个同一时点 Flow 各执行一次且互不串扰', async () => {
  const service = new EngineService({ dataDir: await dataDir() });
  const a = await service.createAutomationTask(scheduledPublish({ taskName: '并列甲', groupId: 'group_a' }));
  const b = await service.createAutomationTask(scheduledPublish({ taskName: '并列乙', groupId: 'group_b' }));
  service.adapters.receiveFile({ fileId: 'notice_multi', name: '定时通知.pdf', path: '/demo/source/定时通知.pdf' });
  const runs = await service.tickScheduler(runAt);
  assert.equal(runs.length, 2);
  assert.equal((await service.runs.listByFlow(a.flowIds[0])).length, 1);
  assert.equal((await service.runs.listByFlow(b.flowIds[0])).length, 1);
  assert.deepEqual(new Set(service.adapters.snapshot().groupMessages.map(item => item.groupId)), new Set(['group_a', 'group_b']));
  service.db.close();
});

test('定时催交读取到期时的未交名单，重复 tick 不重复提醒', async () => {
  const service = new EngineService({ dataDir: await dataDir() });
  const created = await service.createAutomationTask(remindClosure());
  const remindFlowId = created.flowIds[1];
  const first = await service.tickScheduler(dueUtc);
  assert.equal(first.length, 1);
  assert.equal(first[0].flowId, remindFlowId);
  assert.equal(first[0].status, 'succeeded');
  assert.equal(service.adapters.snapshot().directMessages.length, 1);
  assert.deepEqual(await service.tickScheduler(afterRunAt), []);
  assert.equal(service.adapters.snapshot().directMessages.length, 1);
  service.db.close();
});

test('正式编辑接口在到期前改提醒时点和文案，旧时点不触发，新时点使用新配置', async () => {
  const service = new EngineService({ dataDir: await dataDir() });
  const created = await service.createAutomationTask(remindClosure());
  const remindFlowId = created.flowIds[1];
  const nextRunAt = '2026-08-01T11:00:00+08:00';
  await service.editAutomationTask(created.automationId, { deadlineAt: nextRunAt, remindText: '这是编辑后的提醒' });

  assert.deepEqual(await service.tickScheduler(runAt), []);
  const [run] = await service.tickScheduler(nextRunAt);
  assert.equal(run.flowId, remindFlowId);
  assert.equal(run.flowSnapshot.hook.params.runAt, nextRunAt);
  assert.equal(run.flowSnapshot.actions[2].params.text, '这是编辑后的提醒');
  assert.equal(service.adapters.snapshot().directMessages[0].text, '这是编辑后的提醒');
  service.db.close();
});

test('候选入队后暂停，执行前重读 Flow 并拒绝触发', async () => {
  let queuedTask;
  let release;
  const queued = new Promise(resolve => { release = resolve; });
  const enqueue = task => {
    queuedTask = task;
    return queued;
  };
  const service = new EngineService({ dataDir: await dataDir() });
  const created = await service.createAutomationTask(scheduledPublish({ taskName: '串行竞态' }));
  service.scheduler.enqueue = enqueue;
  const ticking = service.scheduler.tick(runAt);
  while (!queuedTask) await new Promise(resolve => setImmediate(resolve));
  await service.setAutomationStatus(created.automationId, 'paused');
  release(await queuedTask());
  assert.deepEqual(await ticking, []);
  assert.equal((await service.runs.list()).length, 0);
  service.db.close();
});

test('JSON 后端同样支持到点一次执行', async () => {
  const service = new EngineService({ backend: 'json', dataDir: await dataDir() });
  const created = await service.createAutomationTask(remindClosure({ taskName: 'JSON催交' }));
  const runs = await service.tickScheduler(runAt);
  assert.equal(runs.length, 1);
  assert.equal((await service.runs.listByFlow(created.flowIds[1])).length, 1);
  assert.deepEqual(await service.tickScheduler(afterRunAt), []);
});
