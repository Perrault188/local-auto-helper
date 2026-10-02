import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EngineService, loadDemoSeed } from '../engine/index.mjs';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const tempDir = () => mkdtemp(join(tmpdir(), 'local-auto-helper-p2-m1-recovery-'));
const incoming = (id, { groupId = 'group_se_2024_1', userId = '1000012345' } = {}) => ({
  schemaVersion: '0.3-rc1', eventId: `event_${id}`, type: 'group_file_received', occurredAt: '2026-08-01T20:00:00+08:00',
  payload: { messageId: `message_${id}`, groupId, senderUserId: userId, text: '作业提交', file: { fileId: `file_${id}`, name: '作业.docx', path: `/demo/inbox/${id}.docx` } }
});
const taskInput = () => ({
  capabilities: ['collect'], taskName: '故障隔离任务', groupId: 'group_fault',
  collectRule: { allowedExtensions: ['.docx'], keyword: '作业' },
  nameTemplate: '{studentId}_{name}{originalExtension}',
  roster: [{ userId: '6300012345', name: '故障成员', studentId: 'FAULT01' }]
});

async function createService(dataDir, faultInjector) {
  return new EngineService({ dataDir, now: () => '2026-08-01T20:00:01+08:00', faultInjector });
}
async function close(service) { service.adapters.closeConnectorJournal?.(); service.db?.close(); }

async function assertRecoveredExactlyOnce(service, event, expectedRunId, taskAttachmentId = 'task_se_week03_demo') {
  const runs = (await service.runs.list()).filter(item => item.eventId === event.eventId);
  assert.equal(runs.length, 1, '恢复后必须恰好一个Run');
  assert.equal(runs[0].runId, expectedRunId);
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].steps.every(item => item.status === 'succeeded'), true);

  const messages = await service.messageLogs.findByEvent(event.eventId);
  assert.equal(messages.filter(item => item.direction === 'inbound').length, 1);
  const replies = messages.filter(item => item.direction === 'outbound');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].deliveryStatus, 'mock_recorded');
  assert.ok(replies[0].actionKey);
  assert.equal(messages.some(item => item.deliveryStatus === 'pending'), false);

  const member = (await service.attachments.get(taskAttachmentId)).members[0];
  assert.equal(member.submissionStatus, 'submitted');
  const actionClaims = await service.actionClaims.listByRun(expectedRunId);
  assert.equal(actionClaims.length, 4);
  assert.equal(actionClaims.every(item => item.status === 'committed'), true);
  assert.equal((await service.effects.listByRun(expectedRunId)).length, 4);
  const outbox = await service.outbox.listByRun(expectedRunId);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].status, 'mock_recorded');
}

test('B1：Run Schema接受DELIVERY_OUTCOME_UNKNOWN并拒绝未声明错误码', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/run-record.schema.json', import.meta.url), 'utf8'));
  const errorSchema = schema.$defs.error;
  const accepts = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (!errorSchema.required.every(key => Object.hasOwn(value, key))) return false;
    if (errorSchema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(errorSchema.properties, key))) return false;
    return errorSchema.properties.code.enum.includes(value.code)
      && typeof value.message === 'string' && value.message.length >= errorSchema.properties.message.minLength && value.message.length <= errorSchema.properties.message.maxLength
      && typeof value.recoverable === 'boolean';
  };
  const positive = { code: 'DELIVERY_OUTCOME_UNKNOWN', message: 'Connector执行结果未知，禁止自动重试', recoverable: false };
  const negative = { ...positive, code: 'DELIVERY_OUTCOME_UNCERTAIN' };
  assert.equal(errorSchema.properties.code.enum.includes('DELIVERY_OUTCOME_UNKNOWN'), true);
  assert.equal(accepts(positive), true);
  assert.equal(accepts(negative), false);
});

test('P2-M1红灯：五个事务故障点重启后均沿稳定runId恢复为一次完整成功', async t => {
  const points = ['ingress_after_commit', 'run_after_reserve', 'action_after_business_state', 'action_after_message', 'run_before_terminal'];
  for (const point of points) await t.test(point, async () => {
    const dataDir = await tempDir();
    let injected = false;
    const first = await createService(dataDir, ({ point: current }) => {
      if (!injected && current === point) {
        injected = true;
        const error = new Error(`fault:${point}`);
        error.code = 'INJECTED_CRASH';
        throw error;
      }
    });
    await first.resetDemo(await loadDemoSeed(fixturesDir));
    const event = incoming(point.replaceAll('_', '-'));
    const expectedRunId = first.runIdFor(event.eventId, 'flow_collect_demo');
    await assert.rejects(first.dispatch(event), /fault:/);
    await close(first);

    const restarted = await createService(dataDir);
    await restarted.recoverPendingWork();
    await assertRecoveredExactlyOnce(restarted, event, expectedRunId);
    await close(restarted);
  });
});

test('B1：有幂等Connector在崩溃重入后以稳定effectKey命中同一持久receipt，外部事实精确一次', async () => {
  const dataDir = await tempDir();
  let injected = false;
  const event = incoming('b1-idempotent-receipt');
  const first = await createService(dataDir, ({ point }) => {
    if (!injected && point === 'connector_after_perform') {
      injected = true;
      const error = new Error('fault:connector_after_perform'); error.code = 'INJECTED_CRASH'; throw error;
    }
  });
  await first.resetDemo(await loadDemoSeed(fixturesDir));
  await assert.rejects(first.dispatch(event), /fault:connector_after_perform/);
  const [reserved] = (await first.effects.list()).filter(item => item.actionId === 'action_reply_received');
  const beforeReceipts = first.adapters.connectorReceipts();
  const beforePerforms = first.adapters.connectorPerforms();
  assert.equal(reserved.status, 'performing');
  assert.equal(reserved.deliveryMode, 'idempotent');
  assert.equal(beforeReceipts.length, 1);
  assert.equal(beforePerforms.length, 1);
  assert.equal(beforeReceipts[0].effectKey, reserved.effectKey);
  assert.equal(beforeReceipts[0].output.connectorReceipt.effectKey, reserved.effectKey);
  await close(first);

  const restarted = await createService(dataDir);
  await restarted.recoverPendingWork();
  const recovered = await restarted.effects.get(reserved.effectKey);
  const receipts = restarted.adapters.connectorReceipts();
  const performs = restarted.adapters.connectorPerforms();
  const actionClaim = (await restarted.actionClaims.listByRun(recovered.runId)).find(item => item.actionId === recovered.actionId);
  const terminalRuns = (await restarted.runs.list()).filter(item => item.eventId === event.eventId);
  const outbox = await restarted.outbox.listByRun(recovered.runId);
  const outbound = (await restarted.messageLogs.findByEvent(event.eventId)).filter(item => item.direction === 'outbound');
  assert.equal(terminalRuns.length, 1);
  assert.equal(terminalRuns[0].status, 'succeeded');
  assert.equal(terminalRuns[0].steps.every(item => item.status === 'succeeded'), true);
  assert.equal(recovered.status, 'applied');
  assert.equal(recovered.output.connectorReceipt.receiptId, receipts[0].output.connectorReceipt.receiptId);
  assert.equal(receipts.length, 1, '同一effectKey只能存在一个外部receipt');
  assert.equal(performs.length, 1, '崩溃重入不得重复产生外部事实');
  assert.equal(actionClaim.actionKey, recovered.effectKey);
  assert.equal(receipts[0].effectKey, recovered.effectKey);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].journalStatus, 'committed');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].deliveryStatus, 'mock_recorded');
  assert.equal(outbox[0].effectKey, recovered.effectKey);
  assert.equal(outbound[0].effectKey, recovered.effectKey);
  assert.equal(outbox[0].actionKey, outbound[0].actionKey);
  assert.notEqual(outbound[0].actionKey, outbound[0].effectKey, 'reply同样保留父effectKey与recipient子actionKey，不设特例');
  await close(restarted);
});

test('B1：无幂等Connector正常路径只perform一次且不伪造receipt', async () => {
  const service = await createService(await tempDir());
  await service.resetDemo(await loadDemoSeed(fixturesDir));
  service.adapters.setIdempotencySupport(false);
  const event = incoming('b1-non-idempotent-once');
  const [run] = await service.dispatch(event);
  const effect = (await service.effects.listByRun(run.runId)).find(item => item.actionId === 'action_reply_received');
  assert.equal(run.status, 'succeeded');
  assert.equal(effect.deliveryMode, 'non_idempotent');
  assert.equal(effect.status, 'applied');
  assert.equal(service.adapters.connectorPerforms().length, 1);
  assert.equal(service.adapters.connectorReceipts().length, 0);
  assert.equal((await service.messageLogs.findByEvent(event.eventId)).filter(item => item.direction === 'outbound').length, 1);
  await close(service);
});

test('B1：无幂等Connector在perform后崩溃持久化DELIVERY_OUTCOME_UNKNOWN且恢复不盲重试', async () => {
  const dataDir = await tempDir();
  let injected = false;
  const event = incoming('b1-non-idempotent-unknown');
  const first = await createService(dataDir, ({ point }) => {
    if (!injected && point === 'connector_after_perform') {
      injected = true;
      const error = new Error('fault:non-idempotent-after-perform'); error.code = 'INJECTED_CRASH'; throw error;
    }
  });
  await first.resetDemo(await loadDemoSeed(fixturesDir));
  first.adapters.setIdempotencySupport(false);
  await assert.rejects(first.dispatch(event), /fault:non-idempotent-after-perform/);
  const [reserved] = (await first.effects.list()).filter(item => item.actionId === 'action_reply_received');
  assert.equal(reserved.status, 'performing');
  assert.equal(reserved.deliveryMode, 'non_idempotent');
  assert.equal(first.adapters.connectorPerforms().length, 1);
  assert.equal(first.adapters.connectorReceipts().length, 0);
  await close(first);

  const restarted = await createService(dataDir);
  const [run] = await restarted.recoverPendingWork();
  const unknown = await restarted.effects.get(reserved.effectKey);
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'DELIVERY_OUTCOME_UNKNOWN');
  assert.equal(run.error.recoverable, false);
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.deliveryMode, 'non_idempotent');
  assert.equal(unknown.error.code, 'DELIVERY_OUTCOME_UNKNOWN');
  assert.equal(restarted.adapters.connectorPerforms().length, 1, '恢复不得再次调用无幂等Connector');
  assert.equal(restarted.adapters.connectorReceipts().length, 0);
  await restarted.recoverPendingWork();
  await restarted.dispatch(event);
  assert.equal(restarted.adapters.connectorPerforms().length, 1, '重复恢复与事件重放均不得盲重试');
  const outbound = (await restarted.messageLogs.findByEvent(event.eventId)).filter(item => item.direction === 'outbound');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].deliveryStatus, 'failed');
  await close(restarted);
});

test('B2：终态Run提交后首条outbound Message写前崩溃，重启与重放确定性补齐且不重复', async () => {
  const dataDir = await tempDir();
  let injected = false;
  const event = incoming('b2-terminal-run-before-message');
  const first = await createService(dataDir, ({ point }) => {
    if (!injected && point === 'run_terminal_before_outbound_message') {
      injected = true;
      const error = new Error('fault:run_terminal_before_outbound_message'); error.code = 'INJECTED_CRASH'; throw error;
    }
  });
  await first.resetDemo(await loadDemoSeed(fixturesDir));
  const expectedRunId = first.runIdFor(event.eventId, 'flow_collect_demo');
  await assert.rejects(first.dispatch(event), /fault:run_terminal_before_outbound_message/);

  const splitRuns = (await first.runs.list()).filter(item => item.eventId === event.eventId);
  const splitMessages = await first.messageLogs.findByEvent(event.eventId);
  const splitClaim = await first.eventClaims.get(event.eventId);
  const splitOutbox = await first.outbox.listByRun(expectedRunId);
  assert.equal(splitRuns.length, 1);
  assert.equal(splitRuns[0].runId, expectedRunId);
  assert.equal(splitRuns[0].status, 'succeeded');
  assert.equal(splitRuns[0].steps.every(item => item.status === 'succeeded'), true);
  assert.equal(splitMessages.filter(item => item.direction === 'inbound').length, 1);
  assert.equal(splitMessages.filter(item => item.direction === 'outbound').length, 0, '故障窗口必须尚未首写outbound Message');
  assert.equal((await first.messageRunLinks.listByRun(expectedRunId)).length, 0);
  assert.equal(splitClaim.status, 'claimed');
  assert.deepEqual(splitClaim.runIds, []);
  assert.equal(splitOutbox.length, 1);
  assert.equal(splitOutbox[0].journalStatus, 'pending');
  assert.equal(first.adapters.connectorPerforms().length, 1);
  await close(first);

  const restarted = await createService(dataDir);
  const [recovered] = await restarted.recoverPendingWork();
  const storedRuns = (await restarted.runs.list()).filter(item => item.eventId === event.eventId);
  const messagesAfterRecovery = await restarted.messageLogs.findByEvent(event.eventId);
  const inbound = messagesAfterRecovery.filter(item => item.direction === 'inbound');
  const outbound = messagesAfterRecovery.filter(item => item.direction === 'outbound');
  const links = await restarted.messageRunLinks.listByRun(expectedRunId);
  const completedClaim = await restarted.eventClaims.get(event.eventId);
  const committedOutbox = await restarted.outbox.listByRun(expectedRunId);
  assert.equal(recovered.runId, expectedRunId);
  assert.deepEqual(recovered, splitRuns[0], '补齐Message不得改写已提交终态Run');
  assert.equal(storedRuns.length, 1);
  assert.deepEqual(storedRuns[0], splitRuns[0]);
  assert.equal(inbound.length, 1);
  assert.equal(outbound.length, 1, '重启恢复必须恰好补齐一条首outbound Message');
  assert.equal(outbound[0].deliveryStatus, 'mock_recorded');
  assert.equal(links.length, 1);
  assert.equal(links[0].messageId, inbound[0].messageId);
  assert.equal(links[0].runId, expectedRunId);
  assert.equal(completedClaim.status, 'completed');
  assert.deepEqual(completedClaim.runIds, [expectedRunId]);
  assert.equal(committedOutbox.length, 1);
  assert.equal(committedOutbox[0].journalStatus, 'committed');
  assert.equal(committedOutbox[0].messageId, outbound[0].messageId);
  assert.equal(restarted.adapters.connectorPerforms().length, 1, 'Message补齐不得重放已完成的外部效果');

  await restarted.recoverPendingWork();
  const replayed = await restarted.dispatch(event);
  assert.deepEqual(replayed.map(item => item.runId), [expectedRunId]);
  const stableMessages = await restarted.messageLogs.findByEvent(event.eventId);
  assert.equal(stableMessages.filter(item => item.direction === 'inbound').length, 1);
  assert.equal(stableMessages.filter(item => item.direction === 'outbound').length, 1);
  assert.equal((await restarted.messageRunLinks.listByRun(expectedRunId)).length, 1);
  assert.equal((await restarted.runs.list()).filter(item => item.eventId === event.eventId).length, 1);
  assert.equal((await restarted.eventClaims.get(event.eventId)).status, 'completed');
  assert.equal(restarted.adapters.connectorPerforms().length, 1);
  await close(restarted);
});

test('P2-M1阻塞复核：T1在Message与EventClaim之间崩溃必须整体回滚且可重放', async () => {
  const dataDir = await tempDir();
  let injected = false;
  const first = await createService(dataDir, ({ point }) => {
    if (!injected && point === 'ingress_between_message_and_claim') {
      injected = true;
      const error = new Error('fault:ingress_between_message_and_claim'); error.code = 'INJECTED_CRASH'; throw error;
    }
  });
  await first.resetDemo(await loadDemoSeed(fixturesDir));
  const event = incoming('t1_atomic');
  await assert.rejects(first.dispatch(event), /fault:/);
  assert.equal((await first.messageLogs.list()).length, 0);
  assert.equal((await first.eventClaims.list()).length, 0);
  assert.equal((await first.conversations.list()).length, 0);
  await close(first);

  const restarted = await createService(dataDir);
  const [run] = await restarted.dispatch(event);
  assert.equal(run.status, 'succeeded');
  assert.equal((await restarted.messageLogs.findByEvent(event.eventId)).filter(item => item.direction === 'inbound').length, 1);
  await close(restarted);
});

test('P2-M1红灯：重复恢复不改变已提交Message、claim、effect与outbox', async () => {
  const dataDir = await tempDir();
  const service = await createService(dataDir);
  await service.resetDemo(await loadDemoSeed(fixturesDir));
  const event = incoming('repeat-recovery');
  await service.dispatch(event);
  const names = ['messageLogs', 'eventClaims', 'runClaims', 'actionClaims', 'effects', 'outbox'];
  const before = Object.fromEntries(await Promise.all(names.map(async name => [name, await service[name].list()])));
  await service.recoverPendingWork();
  await service.recoverPendingWork();
  const after = Object.fromEntries(await Promise.all(names.map(async name => [name, await service[name].list()])));
  assert.deepEqual(after, before);
  const actionKeys = after.messageLogs.filter(item => item.direction === 'outbound').map(item => item.actionKey);
  assert.equal(new Set(actionKeys).size, actionKeys.length);
  await close(service);
});

test('P2-M1红灯：登记已提交后reply失败不回滚业务状态，但只记录failed回执与失败Run', async () => {
  const service = await createService(await tempDir());
  const task = await service.createAutomationTask(taskInput());
  service.adapters.replyToSender = () => { const error = new Error('模拟回执写入失败'); error.code = 'ADAPTER_ERROR'; throw error; };
  const event = incoming('reply-failed', { groupId: 'group_fault', userId: '6300012345' });
  const [run] = await service.dispatch(event);
  assert.equal(run.status, 'failed');
  assert.equal(run.steps.at(-1).status, 'failed');

  const attachment = await service.attachments.get(task.taskAttachmentId);
  assert.equal(attachment.members[0].submissionStatus, 'submitted');
  const recordStore = await service.recordStores.get(task.recordStoreId);
  assert.equal(recordStore.records[0].submissionStatus, 'submitted');
  const replies = (await service.messageLogs.findByEvent(event.eventId)).filter(item => item.direction === 'outbound');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].deliveryStatus, 'failed');
  assert.equal(service.adapters.snapshot().replies.length, 0);
  await close(service);
});

test('P2-M1红灯：批量私信第N人失败时每人独立actionKey与状态，成功投影不含失败项', async () => {
  const service = await createService(await tempDir());
  await service.resetDemo(await loadDemoSeed(fixturesDir));
  service.adapters.setFailure({ operation: 'direct_message', recipientKey: '1000012347', code: 'ADAPTER_ERROR' });
  const timer = {
    schemaVersion: '0.3-rc1', eventId: 'event_batch_partial', type: 'timer_fired', occurredAt: '2026-07-25T18:00:00+08:00',
    payload: { scheduledFor: '2026-07-25T18:00:00+08:00', timezone: 'Asia/Shanghai' }
  };
  const [run] = await service.dispatch(timer);
  assert.equal(run.status, 'failed');
  const effect = (await service.effects.listByRun(run.runId)).find(item => item.actionId === 'action_send_reminder');
  const actionClaim = (await service.actionClaims.listByRun(run.runId)).find(item => item.actionId === 'action_send_reminder');
  const receipts = service.adapters.connectorReceipts();
  const outbox = await service.outbox.listByRun(run.runId);
  const messages = (await service.messageLogs.findByEvent(timer.eventId)).filter(item => item.direction === 'outbound');
  assert.equal(actionClaim.actionKey, effect.effectKey);
  assert.equal(receipts.length, 1, 'batch只产生一个父receipt');
  assert.equal(receipts[0].effectKey, effect.effectKey);
  assert.equal(outbox.length, 5);
  assert.equal(messages.length, 5);
  assert.equal(messages.filter(item => item.deliveryStatus === 'mock_recorded').length, 4);
  assert.equal(messages.filter(item => item.deliveryStatus === 'failed').length, 1);
  assert.equal(new Set(outbox.map(item => item.effectKey)).size, 1);
  assert.equal(new Set(messages.map(item => item.effectKey)).size, 1);
  assert.equal(outbox.every(item => item.effectKey === effect.effectKey), true);
  assert.equal(messages.every(item => item.effectKey === effect.effectKey), true);
  assert.equal(new Set(outbox.map(item => item.actionKey)).size, 5);
  assert.equal(new Set(messages.map(item => item.actionKey)).size, 5);
  assert.deepEqual(new Set(messages.map(item => item.actionKey)), new Set(outbox.map(item => item.actionKey)));
  assert.equal(messages.every(item => item.actionKey !== item.effectKey), true, '每个recipient子actionKey必须区别于batch父effectKey');
  assert.equal(service.adapters.snapshot().directMessages.length, 4);
  const attachment = await service.attachments.get('task_se_week03_demo');
  assert.equal(attachment.members.find(item => item.userId === '1000012347').reminderStatus, 'pending');
  assert.equal(attachment.members.filter(item => item.userId !== '1000012347').every(item => item.reminderStatus === 'sent'), true);
  await close(service);
});

test('P2-M1红灯：reset清空全部运行期消息事实但保留迁移元数据', async () => {
  const service = await createService(await tempDir());
  const seed = await loadDemoSeed(fixturesDir);
  await service.resetDemo(seed);
  await service.migrateMessageStore();
  await service.dispatch(incoming('reset-all'));
  const conversation = (await service.conversations.list())[0];
  await service.bindConversation({ conversationId: conversation.conversationId, automationId: 'automation_test', capability: 'collect', source: 'test' }, { allowMissingAutomation: true });
  const migrationBefore = await service.migrations.list();
  await service.resetDemo(seed);
  for (const name of ['conversations', 'conversationBindings', 'messageLogs', 'messageRunLinks', 'eventClaims', 'runClaims', 'actionClaims', 'effects', 'outbox']) {
    assert.equal((await service[name].list()).length, 0, `${name}必须被reset清空`);
  }
  assert.deepEqual(await service.migrations.list(), migrationBefore);
  await close(service);
});

test('P2-M1红灯：旧0.2/0.3历史Run快照升级后逐字段不变，迁移不伪造消息', async () => {
  const dataDir = await tempDir();
  const first = await createService(dataDir);
  const seed = await loadDemoSeed(fixturesDir);
  await first.resetDemo(seed);
  const oldRun = {
    schemaVersion: '0.2-rc1', runId: 'run_legacy_snapshot', flowId: 'flow_collect_demo', eventId: 'event_legacy_snapshot',
    status: 'succeeded', startedAt: '2026-07-24T10:00:00+08:00', finishedAt: '2026-07-24T10:00:01+08:00', viewedAt: null, error: null,
    flowSnapshot: structuredClone(seed.flows.find(item => item.flowId === 'flow_collect_demo')),
    eventSnapshot: incoming('legacy_snapshot'), steps: []
  };
  await first.runs.save(oldRun);
  await close(first);

  const second = await createService(dataDir);
  await second.migrateMessageStore();
  await second.migrateMessageStore();
  assert.equal((await second.flows.list()).length, seed.flows.length);
  assert.equal((await second.attachments.list()).length, seed.attachments.length);
  assert.deepEqual(await second.runs.get(oldRun.runId), oldRun);
  assert.equal((await second.messageLogs.list()).length, 0, '不得从旧Run或内存数组伪造历史消息');
  await close(second);
});
