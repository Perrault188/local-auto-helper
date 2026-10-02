import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EngineService, instantiateTemplate, loadDemoSeed, validateFlow } from '../engine/index.mjs';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const events = JSON.parse(await readFile(new URL('../fixtures/demo-events.json', import.meta.url), 'utf8'));
const event = id => structuredClone(events.find(item => item.eventId === id));
let clockIndex = 0;
const now = () => `2026-07-21T10:00:${String(clockIndex++).padStart(2, '0')}+08:00`;

async function setup(options = {}) {
  clockIndex = 0;
  const dataDir = await mkdtemp(join(tmpdir(), 'local-auto-helper-engine-'));
  const service = new EngineService({ dataDir, now, ...options });
  const seed = await loadDemoSeed(fixturesDir);
  await service.reset(seed);
  return { service, seed, dataDir };
}

test('三个模板机械实例化且每条Flow只有一个Hook、Action顺序固定', async () => {
  const seed = await loadDemoSeed(fixturesDir); const attachment = seed.attachments[0];
  const common = { taskAttachmentId: attachment.taskAttachmentId, groupId: attachment.groupId, status: 'enabled', name: '测试', flowId: 'flow_test' };
  const publish = instantiateTemplate('homework_publish_v1', { ...common, hook: { type: 'self_message', params: { conversationId: 'assistant_main', keyword: '发布' } }, text: '通知', filePath: '/demo/source/a.pdf' }, attachment);
  const collect = instantiateTemplate('homework_collect_v1', { ...common, keyword: ' 作业 ', allowedExtensions: ['.docx'] }, attachment);
  const remind = instantiateTemplate('homework_remind_v1', { ...common, runAt: attachment.deadlineAt, text: '催交' }, attachment);
  assert.deepEqual([publish.hook.type, collect.hook.type, remind.hook.type], ['self_message','group_file_received','scheduled']);
  assert.deepEqual(publish.actions.map(a => a.type), ['initialize_task_attachment','send_group_message_and_file']);
  assert.deepEqual(collect.actions.map(a => a.type), ['match_person','rename_received_file','mark_submission','reply_to_sender']);
  assert.deepEqual(remind.actions.map(a => a.type), ['read_unsubmitted','build_recipient_list','send_direct_message_batch']);
  assert.equal(collect.hook.params.keyword, '作业');
  assert.throws(() => validateFlow({ ...publish, hook: [publish.hook] }, attachment));
  assert.throws(() => validateFlow({ ...publish, actions: [...publish.actions].reverse() }, attachment));
});

test('发布先初始化附件并成功发送群消息和文件', async () => {
  const { service } = await setup(); const [run] = await service.dispatch(event('event_publish_normal'));
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.steps.map(s => s.actionType), ['initialize_task_attachment','send_group_message_and_file']);
  assert.equal(service.adapters.snapshot().groupMessages.length, 1);
});

test('人员映射成功后改名、登记、迁移催交状态并回复', async () => {
  const { service } = await setup(); const [run] = await service.dispatch(event('event_submit_normal'));
  assert.equal(run.status, 'succeeded'); assert.ok(run.steps.every(step => step.status === 'succeeded'));
  const member = (await service.attachments.get('task_se_week03_demo')).members[0];
  assert.equal(member.submissionStatus, 'submitted'); assert.equal(member.reminderStatus, 'not_needed');
  assert.match(member.filePath, /20240001_合成成员甲\.DOCX$/); assert.equal(service.adapters.snapshot().replies.length, 1);
});

test('人员映射失败后后续步骤全部skipped并派生未查看失败数', async () => {
  const { service } = await setup(); const [run] = await service.dispatch(event('event_submit_unmapped'));
  assert.equal(run.status, 'failed'); assert.equal(run.error.code, 'PERSON_NOT_FOUND');
  assert.deepEqual(run.steps.map(step => step.status), ['failed','skipped','skipped','skipped']);
  assert.equal(service.adapters.snapshot().replies.length, 0); assert.equal(await service.unseenFailureCount(), 1);
  await service.markRunViewed(run.runId); assert.equal(await service.unseenFailureCount(), 0);
});

test('重复提交succeeded_no_action且不覆盖首次文件', async () => {
  const { service } = await setup(); await service.dispatch(event('event_submit_normal'));
  const firstPath = (await service.attachments.get('task_se_week03_demo')).members[0].filePath;
  const [run] = await service.dispatch(event('event_submit_duplicate'));
  assert.equal(run.status, 'succeeded_no_action'); assert.equal(run.steps[0].output.isDuplicate, true);
  assert.deepEqual(run.steps.map(step => step.status), ['succeeded','skipped','skipped','skipped']);
  assert.equal((await service.attachments.get('task_se_week03_demo')).members[0].filePath, firstPath);
});

test('有未交人员时统一群发并迁移reminderStatus', async () => {
  const { service } = await setup(); const [run] = await service.dispatch(event('event_timer_with_pending'));
  assert.equal(run.status, 'succeeded'); assert.equal(run.steps[2].output.sentCount, 5);
  const attachment = await service.attachments.get('task_se_week03_demo');
  assert.ok(attachment.members.every(member => member.reminderStatus === 'sent' && member.remindedAt));
});

test('无人未交时发送步骤skipped并succeeded_no_action', async () => {
  const { service } = await setup(); const attachment = await service.attachments.get('task_se_week03_demo');
  for (const member of attachment.members) { member.submissionStatus = 'submitted'; member.lastSubmittedAt = '2026-07-24T10:00:00+08:00'; member.filePath = `/demo/submissions/${member.studentId}.docx`; member.reminderStatus = 'not_needed'; }
  await service.saveAttachment(attachment);
  const [run] = await service.dispatch(event('event_timer_empty'));
  assert.equal(run.status, 'succeeded_no_action'); assert.deepEqual(run.steps.map(step => step.status), ['succeeded','succeeded','skipped']);
  assert.equal(service.adapters.snapshot().directMessages.length, 0);
});

test('软删除和停用均不接受新事件', async () => {
  const { service } = await setup();
  await service.setFlowStatus('flow_publish_demo', 'deleted'); assert.deepEqual(await service.dispatch(event('event_publish_normal')), []);
  await service.setFlowStatus('flow_collect_demo', 'disabled'); assert.deepEqual(await service.dispatch(event('event_submit_normal')), []);
  assert.equal((await service.flows.list()).some(flow => flow.flowId === 'flow_publish_demo'), false);
  assert.ok(await service.flows.get('flow_publish_demo'));
});

test('当前运行不因执行中停用而中断', async () => {
  let service; let disabled = false;
  ({ service } = await setup({ beforeAction: async ({ index, flow }) => { if (index === 0 && !disabled) { disabled = true; await service.setFlowStatus(flow.flowId, 'disabled'); } } }));
  const [run] = await service.dispatch(event('event_submit_normal'));
  assert.equal(run.status, 'succeeded'); assert.ok(run.steps.every(step => step.status === 'succeeded'));
  assert.equal((await service.flows.get('flow_collect_demo')).status, 'disabled');
});

test('Flow和事件快照不被后续修改覆盖', async () => {
  const { service } = await setup(); const submitted = event('event_submit_normal'); const [run] = await service.dispatch(submitted);
  const flow = await service.flows.get('flow_collect_demo'); flow.name = '修改后的名称'; await service.saveFlow(flow); submitted.payload.file.name = '已篡改.docx';
  const stored = await service.runs.get(run.runId); assert.notEqual(stored.flowSnapshot.name, flow.name); assert.equal(stored.eventSnapshot.payload.file.name, '第三周作业.DOCX');
});

test('同一事件和Flow不重复执行', async () => {
  const { service } = await setup(); const same = event('event_publish_normal'); const first = await service.dispatch(same); const second = await service.dispatch(same);
  assert.equal(first[0].runId, second[0].runId); assert.equal((await service.runs.listByFlow('flow_publish_demo')).length, 1); assert.equal(service.adapters.snapshot().groupMessages.length, 1);
});

test('Demo重置恢复种子并清空运行和适配器输出', async () => {
  const { service, seed } = await setup(); await service.dispatch(event('event_submit_normal')); await service.setFlowStatus('flow_collect_demo', 'deleted');
  await service.reset(seed);
  assert.equal((await service.flows.get('flow_collect_demo')).status, 'enabled'); assert.equal((await service.runs.list()).length, 0);
  assert.equal((await service.attachments.get('task_se_week03_demo')).members[0].submissionStatus, 'unsubmitted');
  assert.equal(service.adapters.snapshot().replies.length, 0);
});
