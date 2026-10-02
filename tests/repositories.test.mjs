import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EngineService, createRepositories, openSqliteDatabase, loadDemoSeed } from '../engine/index.mjs';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const events = JSON.parse(await readFile(new URL('../fixtures/demo-events.json', import.meta.url), 'utf8'));
const event = id => structuredClone(events.find(item => item.eventId === id));
let clockIndex = 0;
const now = () => `2026-07-21T10:00:${String(clockIndex++).padStart(2, '0')}+08:00`;

async function tempDir() { return mkdtemp(join(tmpdir(), 'local-auto-helper-repo-')); }

test('SQLite 后端仓库实现统一接口的 CRUD 与 replaceAll', async () => {
  const db = await openSqliteDatabase(await tempDir());
  const { flows } = createRepositories({ kind: 'sqlite', db });
  assert.deepEqual(await flows.list(), []);
  const seed = await loadDemoSeed(fixturesDir);
  await flows.save(seed.flows[0]);
  const got = await flows.get(seed.flows[0].flowId);
  assert.equal(got.name, seed.flows[0].name);
  got.name = '改名';
  await flows.save(got);
  assert.equal((await flows.get(seed.flows[0].flowId)).name, '改名');
  await flows.replaceAll(seed.flows);
  assert.equal((await flows.list({ includeDeleted: true })).length, seed.flows.length);
  db.close();
});

test('SQLite 后端返回值与底层隔离，外部改动不污染存储', async () => {
  const db = await openSqliteDatabase(await tempDir());
  const { attachments } = createRepositories({ kind: 'sqlite', db });
  const seed = await loadDemoSeed(fixturesDir);
  await attachments.save(seed.attachments[0]);
  const first = await attachments.get(seed.attachments[0].taskAttachmentId);
  first.members[0].name = '被外部改动';
  const second = await attachments.get(seed.attachments[0].taskAttachmentId);
  assert.notEqual(second.members[0].name, '被外部改动');
  db.close();
});

test('FlowRepository 派生查询在 SQLite 后端与 JSON 后端行为一致', async () => {
  const seed = await loadDemoSeed(fixturesDir);
  const db = await openSqliteDatabase(await tempDir());
  const sqlite = createRepositories({ kind: 'sqlite', db });
  const jsonRepos = createRepositories({ kind: 'json', dataDir: await tempDir() });
  await sqlite.flows.replaceAll(seed.flows);
  await jsonRepos.flows.replaceAll(seed.flows);
  const deleted = { ...structuredClone(seed.flows[0]), flowId: 'flow_deleted_demo', status: 'deleted', deletedAt: '2026-07-21T09:00:00+08:00' };
  await sqlite.flows.save(deleted);
  await jsonRepos.flows.save(deleted);
  assert.equal((await sqlite.flows.list()).length, seed.flows.length);
  assert.equal((await jsonRepos.flows.list()).length, seed.flows.length);
  assert.equal((await sqlite.flows.list({ includeDeleted: true })).length, seed.flows.length + 1);
  assert.equal((await sqlite.flows.list({ status: 'enabled' })).length, (await jsonRepos.flows.list({ status: 'enabled' })).length);
  db.close();
});

test('RunRepository 的 listByFlow / findByEventFlow / unseenFailureCount 在 SQLite 后端可用', async () => {
  const db = await openSqliteDatabase(await tempDir());
  const { runs } = createRepositories({ kind: 'sqlite', db });
  const base = { flowId: 'flow_a', eventId: 'event_1', status: 'succeeded', startedAt: '2026-07-21T10:00:00+08:00', viewedAt: null };
  await runs.save({ ...base, runId: 'run_1' });
  await runs.save({ ...base, runId: 'run_2', startedAt: '2026-07-21T11:00:00+08:00', eventId: 'event_2' });
  await runs.save({ ...base, runId: 'run_3', flowId: 'flow_b', status: 'failed', eventId: 'event_3' });
  const byFlow = await runs.listByFlow('flow_a');
  assert.deepEqual(byFlow.map(r => r.runId), ['run_2', 'run_1']);
  assert.equal((await runs.findByEventFlow('event_1', 'flow_a')).runId, 'run_1');
  assert.equal(await runs.findByEventFlow('event_x', 'flow_a'), null);
  assert.equal(await runs.unseenFailureCount(), 1);
  db.close();
});

test('SQLite 后端重启（重新打开同一目录）后配置、名单、历史仍完整留存', async () => {
  clockIndex = 0;
  const dataDir = await tempDir();
  const first = await EngineService.create({ backend: 'sqlite', dataDir, now });
  const seed = await loadDemoSeed(fixturesDir);
  await first.reset(seed);
  await first.dispatch(event('event_submit_normal'));
  const memberBefore = (await first.attachments.get('task_se_week03_demo')).members[0];
  assert.equal(memberBefore.submissionStatus, 'submitted');
  const runCountBefore = (await first.runs.list()).length;
  assert.ok(runCountBefore >= 1);
  first.db.close();

  // 模拟服务重启：新建 EngineService 指向同一目录，不再 reset。
  const restarted = await EngineService.create({ backend: 'sqlite', dataDir, now });
  assert.equal((await restarted.flows.list()).length, seed.flows.length);
  assert.equal((await restarted.attachments.get('task_se_week03_demo')).members[0].submissionStatus, 'submitted');
  assert.equal((await restarted.runs.list()).length, runCountBefore);
  restarted.db.close();
});

test('SQLite 后端跑通完整班委执行链路，行为与 JSON 后端一致', async () => {
  clockIndex = 0;
  const service = await EngineService.create({ backend: 'sqlite', dataDir: await tempDir(), now });
  const seed = await loadDemoSeed(fixturesDir);
  await service.reset(seed);

  const [publish] = await service.dispatch(event('event_publish_normal'));
  assert.equal(publish.status, 'succeeded');
  const [submit] = await service.dispatch(event('event_submit_normal'));
  assert.equal(submit.status, 'succeeded');
  const [unmapped] = await service.dispatch(event('event_submit_unmapped'));
  assert.equal(unmapped.status, 'failed');
  assert.equal(unmapped.error.code, 'PERSON_NOT_FOUND');
  const [duplicate] = await service.dispatch(event('event_submit_duplicate'));
  assert.equal(duplicate.status, 'succeeded_no_action');
  assert.equal(await service.unseenFailureCount(), 1);

  const member = (await service.attachments.get('task_se_week03_demo')).members[0];
  assert.equal(member.submissionStatus, 'submitted');
  assert.match(member.filePath, /20240001_合成成员甲\.DOCX$/);
  assert.equal(service.adapters.snapshot().replies.length, 1);
  service.db.close();
});

test('两个不同任务在 SQLite 后端互不串扰', async () => {
  clockIndex = 0;
  const service = await EngineService.create({ backend: 'sqlite', dataDir: await tempDir(), now });
  const seed = await loadDemoSeed(fixturesDir);
  await service.reset(seed);

  // 第二个任务：不同 taskAttachmentId、不同群，成员独立。
  const second = structuredClone(seed.attachments[0]);
  second.taskAttachmentId = 'task_se_week04_demo';
  second.taskName = '软件工程第4周作业';
  await service.saveAttachment(second);

  await service.dispatch(event('event_submit_normal'));
  // 第一个任务成员被登记，第二个任务成员不受影响。
  assert.equal((await service.attachments.get('task_se_week03_demo')).members[0].submissionStatus, 'submitted');
  assert.equal((await service.attachments.get('task_se_week04_demo')).members[0].submissionStatus, 'unsubmitted');
  service.db.close();
});
