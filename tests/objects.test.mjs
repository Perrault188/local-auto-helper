import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  EngineService, loadDemoSeed,
  createAutomation, validateAutomation,
  createResource, validateResource,
  createRecordStore, createEntityDirectory,
  packEducationAssignment, AUTOMATION_STATUSES
} from '../engine/index.mjs';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
let clockIndex = 0;
const now = () => `2026-07-21T10:00:${String(clockIndex++).padStart(2, '0')}+08:00`;
async function tempDir() { return mkdtemp(join(tmpdir(), 'local-auto-helper-objects-')); }

test('通用对象构造函数生成中性结构且带唯一 ID 与时间', () => {
  const automation = createAutomation({ name: '收群里的回复', domain: 'generic', createdAt: '2026-07-21T09:00:00+08:00' });
  assert.match(automation.automationId, /^automation_[a-f0-9]+$/);
  assert.equal(automation.status, 'draft');
  assert.deepEqual([automation.resourceIds, automation.recordStoreIds, automation.entityDirectoryIds, automation.flowIds], [[], [], [], []]);
  validateAutomation(automation);
  assert.ok(AUTOMATION_STATUSES.includes(automation.status));

  const resource = createResource({ kind: 'FileFolder', name: '归档目录', createdAt: '2026-07-21T09:00:00+08:00' });
  validateResource(resource);
  assert.throws(() => validateResource({ ...resource, kind: '未注册种类' }), /种类未注册/);
});

test('packEducationAssignment 把班委附件投影为 Resource/EntityDirectory/RecordStore', async () => {
  const seed = await loadDemoSeed(fixturesDir);
  const attachment = seed.attachments[0];
  const { resource, entityDirectory, recordStore } = packEducationAssignment(attachment, { automationId: 'automation_edu_demo' });
  assert.equal(resource.kind, 'EducationAssignmentPack');
  assert.equal(resource.payload.taskAttachmentId, attachment.taskAttachmentId);
  assert.equal(resource.payload.groupId, attachment.groupId);
  assert.equal(entityDirectory.matchKey, 'userId');
  assert.equal(entityDirectory.entities.length, attachment.members.length);
  assert.equal(entityDirectory.entities[0].userId, attachment.members[0].userId);
  assert.equal(recordStore.records.length, attachment.members.length);
  assert.equal(recordStore.records[0].submissionStatus, 'unsubmitted');
  assert.equal(recordStore.schema.entityKey, 'userId');
  // 投影只读，不改动原附件。
  assert.equal(attachment.members[0].submissionStatus, 'unsubmitted');
});

test('通用对象仓库在 SQLite 后端可 CRUD 且按 automationId 派生查询', async () => {
  clockIndex = 0;
  const service = new EngineService({ backend: 'sqlite', dataDir: await tempDir(), now });
  const automation = createAutomation({ name: 'A', createdAt: now() });
  await service.automations.save(automation);
  const resA = createResource({ automationId: automation.automationId, kind: 'ContactRoster', name: '名单A', createdAt: now() });
  const resB = createResource({ automationId: 'automation_other', kind: 'FileFolder', name: '别的资源', createdAt: now() });
  await service.resources.save(resA);
  await service.resources.save(resB);
  assert.equal((await service.resources.listByAutomation(automation.automationId)).length, 1);
  assert.equal((await service.resources.listByKind('ContactRoster')).length, 1);
  const got = await service.automations.get(automation.automationId);
  assert.equal(got.name, 'A');
  service.db.close();
});

test('门槛：SQLite 后端连续创建两个通用任务，重启后配置/名单/记录完整且互不串扰', async () => {
  clockIndex = 0;
  const dataDir = await tempDir();
  const seed = await loadDemoSeed(fixturesDir);
  const first = new EngineService({ backend: 'sqlite', dataDir, now });

  // 任务一：班委作业（用领域打包投影出通用对象并落库）。
  const a1 = createAutomation({ name: '软件工程第3周作业收集', domain: 'education', status: 'enabled', createdAt: now() });
  const packed1 = packEducationAssignment(seed.attachments[0], { automationId: a1.automationId });
  a1.resourceIds = [packed1.resource.resourceId];
  a1.entityDirectoryIds = [packed1.entityDirectory.entityDirectoryId];
  a1.recordStoreIds = [packed1.recordStore.recordStoreId];
  await first.automations.save(a1);
  await first.resources.save(packed1.resource);
  await first.entityDirectories.save(packed1.entityDirectory);
  await first.recordStores.save(packed1.recordStore);

  // 任务二：一个结构不同的通用任务（门店日报提醒），成员名单完全不同。
  const a2 = createAutomation({ name: '七月门店日报缺失提醒', domain: 'retail', status: 'enabled', createdAt: now() });
  const dir2 = createEntityDirectory({ automationId: a2.automationId, name: '门店目录', matchKey: 'storeId', entities: [{ storeId: 'S01', owner: '测试成员甲' }, { storeId: 'S02', owner: '测试成员乙' }], createdAt: now() });
  const store2 = createRecordStore({ automationId: a2.automationId, name: '日报记录', records: [{ storeId: 'S01', submitted: false }, { storeId: 'S02', submitted: false }], createdAt: now() });
  a2.entityDirectoryIds = [dir2.entityDirectoryId];
  a2.recordStoreIds = [store2.recordStoreId];
  await first.automations.save(a2);
  await first.entityDirectories.save(dir2);
  await first.recordStores.save(store2);

  first.db.close();

  // 模拟服务重启：新建 EngineService 指向同一目录，默认 SQLite，不 reset。
  const restarted = new EngineService({ backend: 'sqlite', dataDir, now });
  assert.equal((await restarted.automations.list()).length, 2);

  const r1 = await restarted.resources.listByAutomation(a1.automationId);
  const d1 = await restarted.entityDirectories.listByAutomation(a1.automationId);
  const s1 = await restarted.recordStores.listByAutomation(a1.automationId);
  const d2 = await restarted.entityDirectories.listByAutomation(a2.automationId);
  const s2 = await restarted.recordStores.listByAutomation(a2.automationId);

  // 任务一数据完整且是班委名单。
  assert.equal(r1.length, 1);
  assert.equal(r1[0].kind, 'EducationAssignmentPack');
  assert.equal(d1[0].entities.length, seed.attachments[0].members.length);
  assert.equal(s1[0].records[0].submissionStatus, 'unsubmitted');

  // 任务二数据完整且是门店名单，两个任务互不串扰。
  assert.equal(d2[0].matchKey, 'storeId');
  assert.equal(d2[0].entities[0].storeId, 'S01');
  assert.equal(s2[0].records.length, 2);
  // 任务一目录里不含门店实体，任务二目录里不含班委成员。
  assert.equal(d1[0].entities.some(e => e.storeId), false);
  assert.equal(d2[0].entities.some(e => e.userId), false);
  restarted.db.close();
});

test('resetDemo 清空通用对象表且现有班委链路数据回到种子', async () => {
  clockIndex = 0;
  const service = new EngineService({ backend: 'sqlite', dataDir: await tempDir(), now });
  const seed = await loadDemoSeed(fixturesDir);
  await service.resetDemo(seed);
  await service.automations.save(createAutomation({ name: '临时任务', createdAt: now() }));
  assert.equal((await service.automations.list()).length, 1);
  await service.resetDemo(seed);
  assert.equal((await service.automations.list()).length, 0);
  // 班委种子仍在。
  assert.equal((await service.flows.list()).length, seed.flows.length);
  assert.equal((await service.attachments.get('task_se_week03_demo')).members[0].submissionStatus, 'unsubmitted');
  service.db.close();
});

test('默认构造不自动清库：不调用 resetDemo 时旧数据留存', async () => {
  clockIndex = 0;
  const dataDir = await tempDir();
  const seed = await loadDemoSeed(fixturesDir);
  const first = new EngineService({ backend: 'sqlite', dataDir, now });
  await first.resetDemo(seed);
  await first.automations.save(createAutomation({ automationId: 'automation_keep', name: '应当留存', createdAt: now() }));
  first.db.close();

  // 重新构造，不 reset：automation_keep 必须还在。
  const again = new EngineService({ backend: 'sqlite', dataDir, now });
  assert.ok(await again.automations.get('automation_keep'));
  assert.equal((await again.flows.list()).length, seed.flows.length);
  again.db.close();
});
