import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineService } from '../engine/index.mjs';

let tick = 0;
const now = () => `2026-07-29T10:00:${String(tick++).padStart(2, '0')}+08:00`;
const event = (id, groupId, senderUserId, name, path) => ({
  schemaVersion: '0.3-rc1',
  eventId: `event_${id}`,
  type: 'group_file_received',
  occurredAt: now(),
  payload: {
    messageId: `message_${id}`,
    groupId,
    senderUserId,
    text: name,
    file: { fileId: `file_${id}`, name, path }
  }
});

async function serviceAt(dataDir) {
  return new EngineService({ backend: 'sqlite', dataDir: dataDir ?? await mkdtemp(join(tmpdir(), 'local-auto-helper-domain-')), now });
}

function educationInput() {
  return {
    taskName: '班委作业',
    groupId: 'group_edu',
    publishText: '请提交作业。',
    noticeFilePath: '/source/作业.pdf',
    publishAt: '2026-07-30T09:00:00+08:00',
    deadlineAt: '2026-07-30T18:00:00+08:00',
    collectRule: { allowedExtensions: ['.pdf'], keyword: '作业' },
    remindText: '请尽快提交。',
    roster: [{ userId: '2000010001', name: '学生甲', studentId: 'E01' }]
  };
}

function financeInput() {
  return {
    domain: 'finance',
    taskName: '费用单据收件',
    groupId: 'group_finance',
    collectRule: { allowedExtensions: ['.pdf'], keyword: '单据' },
    submitters: [{ userId: '3000010001', name: '提交人甲', projectCode: 'P01' }]
  };
}

function retailInput() {
  return {
    domain: 'retail',
    taskName: '门店日报缺失提醒',
    groupId: 'group_retail',
    deadlineAt: '2026-07-30T18:00:00+08:00',
    remindAt: '2026-07-30T18:00:00+08:00',
    collectRule: { allowedExtensions: ['.pdf'], keyword: '日报' },
    remindText: '日报尚未登记，请尽快提交。',
    stores: [
      { storeId: 'S01', storeName: '一店', ownerUserId: '4000010001' },
      { storeId: 'S02', storeName: '二店', ownerUserId: '4000010002' }
    ]
  };
}

test('共同compiler创建三领域，使用同一能力注册与Action集合且数据隔离', async () => {
  const service = await serviceAt();
  const edu = await service.createAutomationTask(educationInput());
  const finance = await service.createAutomationTask(financeInput());
  const retail = await service.createAutomationTask(retailInput());
  const automations = await service.automations.list();
  assert.deepEqual(new Set(automations.map(item => item.domain)), new Set(['education', 'finance', 'retail']));
  assert.deepEqual((await service.automations.get(edu.automationId)).plan.capabilities, ['publish', 'collect', 'remind']);
  assert.deepEqual((await service.automations.get(finance.automationId)).plan.capabilities, ['collect']);
  assert.deepEqual((await service.automations.get(retail.automationId)).plan.capabilities, ['collect', 'remind']);
  const actionTypes = new Set((await service.flows.list()).flatMap(flow => flow.actions.map(action => action.type)));
  assert.deepEqual(actionTypes, new Set([
    'initialize_task_attachment', 'send_group_message_and_file',
    'match_person', 'rename_received_file', 'mark_submission', 'reply_to_sender',
    'read_unsubmitted', 'build_recipient_list', 'send_direct_message_batch'
  ]));
  assert.notEqual(edu.taskAttachmentId, finance.taskAttachmentId);
  assert.notEqual(finance.taskAttachmentId, retail.taskAttachmentId);
  service.db.close();
});

test('财务收件真实写入pending_review清单，保留人工审核边界且重复事件幂等', async () => {
  const service = await serviceAt();
  const created = await service.createAutomationTask(financeInput());
  const automation = await service.automations.get(created.automationId);
  const resource = await service.resources.get(created.resourceId);
  assert.equal(resource.kind, 'FinanceReceiptPack');
  assert.deepEqual(resource.payload.riskPolicy, {
    humanApprovalRequired: true,
    autoReview: false,
    autoPayment: false,
    autoBookkeeping: false
  });
  assert.deepEqual(automation.plan.riskPolicy, resource.payload.riskPolicy);

  const receiptEvent = event('finance_receipt', 'group_finance', '3000010001', '7月单据.pdf', '/inbox/7月单据.pdf');
  const [run] = await service.dispatch(receiptEvent);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.steps.map(step => step.actionType), [
    'match_person', 'rename_received_file', 'mark_submission', 'reply_to_sender'
  ]);
  const recordStore = await service.recordStores.get(created.recordStoreId);
  assert.equal(recordStore.schema.projectionKey, 'finance_receipt_v1');
  assert.equal(recordStore.records[0].reviewStatus, 'pending_review');
  assert.equal(recordStore.records[0].entityId, 'P01');
  assert.ok(recordStore.records[0].filePath);
  const replies = service.adapters.snapshot().replies;
  assert.match(replies[0].text, /待审核/);
  assert.match(replies[0].text, /不会自动审核、付款或入账/);
  const [duplicate] = await service.dispatch(receiptEvent);
  assert.equal(duplicate.runId, run.runId);
  assert.equal((await service.runs.listByFlow(run.flowId)).length, 1);
  service.db.close();
});

test('门店日报收取后定时只提醒缺失负责人，重复tick不重复运行', async () => {
  const service = await serviceAt();
  const created = await service.createAutomationTask(retailInput());
  const [collectRun] = await service.dispatch(event('retail_report', 'group_retail', '4000010001', '一店日报.pdf', '/inbox/一店日报.pdf'));
  assert.equal(collectRun.status, 'succeeded');
  const [remindFlow] = (await service.flows.list()).filter(flow => flow.templateId === 'homework_remind_v1');
  const timer = {
    schemaVersion: '0.3-rc1',
    eventId: 'event_retail_timer',
    type: 'timer_fired',
    occurredAt: '2026-07-30T18:00:00+08:00',
    payload: { scheduledFor: remindFlow.hook.params.runAt, timezone: 'Asia/Shanghai' }
  };
  const [remindRun] = await service.dispatch(timer);
  assert.equal(remindRun.status, 'succeeded');
  const directMessages = service.adapters.snapshot().directMessages;
  assert.deepEqual(directMessages.map(message => message.userId), ['4000010002']);
  const store = await service.recordStores.get(created.recordStoreId);
  assert.deepEqual(store.records.map(record => [record.storeId, record.reportStatus, record.reminderStatus]), [
    ['S01', 'received', 'not_needed'],
    ['S02', 'missing', 'sent']
  ]);
  const [again] = await service.dispatch(timer);
  assert.equal(again.runId, remindRun.runId);
  assert.equal(service.adapters.snapshot().directMessages.length, 1);
  service.db.close();
});

test('跨领域重启与管理重投影保留domain、Resource kind及对象ID', async () => {
  tick = 0;
  const dataDir = await mkdtemp(join(tmpdir(), 'local-auto-helper-domain-restart-'));
  const first = await serviceAt(dataDir);
  const finance = await first.createAutomationTask(financeInput());
  const retail = await first.createAutomationTask(retailInput());
  first.db.close();

  const restarted = await serviceAt(dataDir);
  const oldFinanceResourceId = finance.resourceId;
  const oldRetailStoreId = retail.recordStoreId;
  await restarted.editAutomationTask(finance.automationId, { taskName: '费用单据收件（更新）' });
  await restarted.editAutomationTask(retail.automationId, { remindText: '请补交今日日报。' });
  assert.equal((await restarted.automations.get(finance.automationId)).domain, 'finance');
  assert.equal((await restarted.resources.get(oldFinanceResourceId)).kind, 'FinanceReceiptPack');
  assert.equal((await restarted.recordStores.get(oldRetailStoreId)).schema.projectionKey, 'retail_daily_report_v1');
  assert.equal((await restarted.getAutomationView(retail.automationId)).labels.pending, '缺失');
  const scheduledRuns = await restarted.tickScheduler('2026-07-30T18:00:00+08:00');
  assert.equal(scheduledRuns.length, 1);
  assert.deepEqual(restarted.adapters.snapshot().directMessages.map(message => message.userId), ['4000010001', '4000010002']);
  assert.equal((await restarted.recordStores.get(oldRetailStoreId)).records.every(record => record.reminderStatus === 'sent'), true);
  restarted.db.close();
});

test('未知领域在创建边界返回结构化校验错误', async () => {
  const service = await serviceAt();
  await assert.rejects(
    () => service.createAutomationTask({ ...educationInput(), domain: 'unknown' }),
    error => error.code === 'CREATION_INPUT_INVALID'
      && error.errors.some(item => item.field === 'domain' && item.code === 'UNKNOWN')
  );
  service.db.close();
});

test('同一Service三领域真实运行后，Run与RecordStore按任务隔离', async () => {
  const service = await serviceAt();
  const edu = await service.createAutomationTask(educationInput());
  const finance = await service.createAutomationTask(financeInput());
  const retail = await service.createAutomationTask(retailInput());

  await service.dispatch(event('edu_isolated', 'group_edu', '2000010001', '作业.pdf', '/inbox/作业.pdf'));
  await service.dispatch(event('finance_isolated', 'group_finance', '3000010001', '单据.pdf', '/inbox/单据.pdf'));
  await service.dispatch(event('retail_isolated', 'group_retail', '4000010001', '一店日报.pdf', '/inbox/一店日报.pdf'));

  const byAutomation = new Map();
  for (const item of [edu, finance, retail]) {
    const automation = await service.automations.get(item.automationId);
    const runs = (await Promise.all(automation.flowIds.map(flowId => service.runs.listByFlow(flowId)))).flat();
    byAutomation.set(item.automationId, runs);
    assert.equal(runs.length, 1);
    assert.ok(runs.every(run => automation.flowIds.includes(run.flowId)));
  }
  assert.deepEqual(
    (await service.recordStores.get(edu.recordStoreId)).records.map(record => record.submissionStatus),
    ['submitted']
  );
  assert.deepEqual(
    (await service.recordStores.get(finance.recordStoreId)).records.map(record => record.reviewStatus),
    ['pending_review']
  );
  assert.deepEqual(
    (await service.recordStores.get(retail.recordStoreId)).records.map(record => record.reportStatus),
    ['received', 'missing']
  );
  assert.equal([...byAutomation.values()].flat().length, 3);
  service.db.close();
});

test('财务同一业务使用不同eventId重复到达，不重复建待审核记录或回复', async () => {
  const service = await serviceAt();
  const created = await service.createAutomationTask(financeInput());
  const firstEvent = event('finance_business_1', 'group_finance', '3000010001', '7月单据.pdf', '/inbox/7月单据.pdf');
  const secondEvent = event('finance_business_2', 'group_finance', '3000010001', '7月单据.pdf', '/inbox/7月单据.pdf');
  const [first] = await service.dispatch(firstEvent);
  const [second] = await service.dispatch(secondEvent);
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'succeeded_no_action');
  assert.notEqual(first.runId, second.runId);
  const store = await service.recordStores.get(created.recordStoreId);
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].reviewStatus, 'pending_review');
  assert.equal(service.adapters.snapshot().replies.length, 1);
  service.db.close();
});

test('门店全员已上报时提醒Run为succeeded_no_action且不发送私信', async () => {
  tick = 0;
  const service = await serviceAt();
  const created = await service.createAutomationTask(retailInput());
  await service.dispatch(event('retail_all_1', 'group_retail', '4000010001', '一店日报.pdf', '/inbox/一店日报.pdf'));
  await service.dispatch(event('retail_all_2', 'group_retail', '4000010002', '二店日报.pdf', '/inbox/二店日报.pdf'));
  const remindFlow = (await service.flows.list()).find(flow =>
    created.flowIds.includes(flow.flowId) && flow.templateId === 'homework_remind_v1'
  );
  const [run] = await service.dispatch({
    schemaVersion: '0.3-rc1',
    eventId: 'event_retail_all_timer',
    type: 'timer_fired',
    occurredAt: remindFlow.hook.params.runAt,
    payload: { scheduledFor: remindFlow.hook.params.runAt, timezone: 'Asia/Shanghai' }
  });
  assert.equal(run.status, 'succeeded_no_action');
  assert.equal(service.adapters.snapshot().directMessages.length, 0);
  assert.equal(run.steps.at(-1).status, 'skipped');
  service.db.close();
});
