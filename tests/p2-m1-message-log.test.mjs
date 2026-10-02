import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { EngineService, loadDemoSeed, stableHash, validateMessage } from '../engine/index.mjs';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const tempDir = () => mkdtemp(join(tmpdir(), 'local-auto-helper-p2-m1-log-'));
let sequence = 0;
const now = () => `2026-08-01T18:00:${String(sequence++ % 60).padStart(2, '0')}+08:00`;
const event = (id, overrides = {}) => ({
  schemaVersion: '0.3-rc1',
  eventId: `event_${id}`,
  type: 'group_file_received',
  occurredAt: '2026-08-01T18:10:00+08:00',
  payload: {
    messageId: `message_${id}`,
    groupId: 'group_se_2024_1',
    senderUserId: '1000012345',
    text: '作业提交',
    file: { fileId: `file_${id}`, name: '第三周作业.docx', path: `/demo/inbox/${id}.docx` },
    ...overrides
  }
});

async function setup(dataDir) {
  sequence = 0;
  dataDir ??= await tempDir();
  const service = new EngineService({ dataDir, now });
  const seed = await loadDemoSeed(fixturesDir);
  await service.resetDemo(seed);
  return { service, seed, dataDir };
}

async function close(service) {
  service.stopScheduler();
  service.adapters.closeConnectorJournal?.();
  service.db?.close();
}

async function integritySnapshot(service) {
  const repositories = ['messageLogs', 'messageRunLinks', 'eventClaims', 'runClaims', 'actionClaims', 'effects', 'outbox', 'runs', 'attachments', 'recordStores'];
  return Object.fromEntries(await Promise.all(repositories.map(async name => [name, await service[name].list()])));
}

const b3WorkerSource = String.raw`
const [engineUrl, dataDir, fixturesDir, role, eventJson] = process.argv.slice(1);
const { EngineService, loadDemoSeed } = await import(engineUrl);
let service;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
try {
  service = new EngineService({ dataDir });
  if (role === 'seed-worker') await service.resetDemo(await loadDemoSeed(fixturesDir));
  emit({ type: 'ready', role, pid: process.pid });
  await new Promise((resolve, reject) => {
    process.stdin.once('data', resolve);
    process.stdin.once('error', reject);
  });
  const event = JSON.parse(eventJson);
  const runs = await service.dispatch(event);
  const messages = await service.messageLogs.findByEvent(event.eventId);
  emit({
    type: 'result', role, pid: process.pid,
    runIds: runs.map(item => item.runId), statuses: runs.map(item => item.status),
    counts: {
      eventClaims: (await service.eventClaims.list(item => item.eventId === event.eventId)).length,
      runs: (await service.runs.list()).filter(item => item.eventId === event.eventId).length,
      inbound: messages.filter(item => item.direction === 'inbound').length,
      outbound: messages.filter(item => item.direction === 'outbound').length,
      outbox: (await service.outbox.listByRun(runs[0]?.runId)).length,
      performs: service.adapters.connectorPerforms().length,
      receipts: service.adapters.connectorReceipts().length
    }
  });
} catch (error) {
  emit({ type: 'error', role, pid: process.pid, code: error?.code ?? null, message: error?.message ?? String(error) });
  process.exitCode = 1;
} finally {
  service?.adapters.closeConnectorJournal?.();
  service?.db?.close();
}
`;

function spawnB3Worker({ role, dataDir, event }) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', b3WorkerSource, new URL('../engine/index.mjs', import.meta.url).href, dataDir, fixturesDir, role, JSON.stringify(event)], {
    cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let stderr = '';
  let readyResolve; let readyReject; let resultResolve; let resultReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const boundary = buffer.indexOf('\n');
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.type === 'ready') readyResolve(message);
      else if (message.type === 'result') resultResolve(message);
      else if (message.type === 'error') {
        const error = new Error(`${message.role}:${message.code ?? 'ERROR'}:${message.message}`);
        readyReject(error); resultReject(error);
      }
    }
  });
  const exit = new Promise(resolve => child.once('exit', code => {
    if (code !== 0) {
      const error = new Error(`${role}异常退出 ${code}: ${stderr}`);
      readyReject(error); resultReject(error);
    }
    resolve(code);
  }));
  return { child, ready, result, exit, stderr: () => stderr };
}

async function within(promise, label, timeoutMs = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

test('P2-M1红灯：MessageLog唯一权威，三类兼容投影重启后数量、顺序和ID稳定', async () => {
  const { service, dataDir } = await setup();
  const requiredRepos = ['conversations', 'conversationBindings', 'messageLogs', 'messageRunLinks', 'eventClaims', 'runClaims', 'actionClaims', 'effects', 'outbox'];
  assert.ok(requiredRepos.every(name => service[name]), '必须挂载完整消息事实、绑定、claim、effect与outbox仓库');

  await service.dispatch({
    schemaVersion: '0.3-rc1', eventId: 'event_projection_publish', type: 'self_message_sent', occurredAt: '2026-08-01T18:05:00+08:00',
    payload: { messageId: 'message_projection_publish', conversationId: 'assistant_main', senderUserId: '9000012345', text: '发布本周作业' }
  });
  await service.dispatch(event('projection_reply'));
  await service.dispatch({
    schemaVersion: '0.3-rc1', eventId: 'event_projection_direct', type: 'timer_fired', occurredAt: '2026-07-25T18:00:00+08:00',
    payload: { scheduledFor: '2026-07-25T18:00:00+08:00', timezone: 'Asia/Shanghai' }
  });

  const beforeMessages = await service.messageLogs.list();
  const beforeConversations = await service.conversations.list();
  const beforeProjection = await service.messageSnapshot();
  const beforeAdapterProjection = service.adapters.snapshot();
  for (const key of ['groupMessages', 'directMessages', 'replies']) {
    assert.ok(beforeProjection[key].length > 0, `${key}必须由持久日志投影`);
    assert.deepEqual(beforeAdapterProjection[key], beforeProjection[key]);
  }
  service.adapters.state.groupMessages.push({ messageId: 'fake_process_mirror', groupId: 'fake', text: 'fake', filePath: '/fake' });
  assert.equal(service.adapters.snapshot().groupMessages.some(item => item.messageId === 'fake_process_mirror'), false, '直接篡改进程镜像不能影响公开投影');
  await close(service);

  const restarted = new EngineService({ dataDir, now });
  assert.deepEqual(await restarted.messageLogs.list(), beforeMessages);
  assert.deepEqual(await restarted.conversations.list(), beforeConversations);
  assert.deepEqual(await restarted.messageSnapshot(), beforeProjection);
  assert.deepEqual(restarted.adapters.snapshot().groupMessages, beforeProjection.groupMessages);
  assert.deepEqual(restarted.adapters.snapshot().directMessages, beforeProjection.directMessages);
  assert.deepEqual(restarted.adapters.snapshot().replies, beforeProjection.replies);
  await close(restarted);
});

test('B4：Message JSON Schema与runtime validator接受合法双向事实并共同拒绝契约反例', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/message.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.required.includes('effectKey'), true);
  assert.equal(schema.required.includes('actionKey'), true);
  assert.match(schema.$comment, /effectKey and actionKey MUST differ/);
  const directionRule = schema.allOf[0];
  assert.equal(directionRule.then.properties.effectKey.type, 'null');
  assert.equal(directionRule.else.properties.effectKey.$ref, '#/$defs/actionKey');
  assert.equal(directionRule.else.properties.actionKey.$ref, '#/$defs/actionKey');

  const { service } = await setup();
  const input = event('b4-message-schema');
  const publish = {
    schemaVersion: '0.3-rc1', eventId: 'event_b4_message_file', type: 'self_message_sent', occurredAt: '2026-08-01T18:05:00+08:00',
    payload: { messageId: 'message_b4_message_file', conversationId: 'assistant_main', senderUserId: '9000012345', text: '发布本周作业' }
  };
  await service.dispatch(input);
  await service.dispatch(publish);
  const messages = await service.messageLogs.findByEvent(input.eventId);
  const publishMessages = await service.messageLogs.findByEvent(publish.eventId);
  const inbound = messages.find(item => item.direction === 'inbound');
  const outbound = messages.find(item => item.direction === 'outbound');
  const fileOutbound = publishMessages.find(item => item.direction === 'outbound');
  assert.ok(inbound && outbound && fileOutbound?.file);
  for (const valid of [inbound, outbound, fileOutbound]) {
    assert.deepEqual(Object.keys(valid).sort(), [...schema.required].sort());
    assert.equal(validateSchema(structuredClone(valid)), true, JSON.stringify(validateSchema.errors));
    assert.doesNotThrow(() => validateMessage(structuredClone(valid)));
  }

  const unknownField = { ...structuredClone(inbound), undeclared: true };
  const missingParentEffect = structuredClone(outbound); delete missingParentEffect.effectKey;
  const inboundWithEffect = { ...structuredClone(inbound), effectKey: outbound.effectKey };
  const outboundReceived = { ...structuredClone(outbound), deliveryStatus: 'received' };
  const textNull = { ...structuredClone(outbound), text: null };
  const fileIdNull = structuredClone(fileOutbound); fileIdNull.file.fileId = null;
  const fileIdEmpty = structuredClone(fileOutbound); fileIdEmpty.file.fileId = '';
  const nameNumber = structuredClone(fileOutbound); nameNumber.file.name = 123;
  const sourceRefNumber = structuredClone(fileOutbound); sourceRefNumber.file.sourceRef = 456;
  const equalParentAndChild = structuredClone(outbound);
  equalParentAndChild.actionKey = equalParentAndChild.effectKey;
  equalParentAndChild.immutableFingerprint = stableHash({ actionKey: equalParentAndChild.actionKey, recipientKey: equalParentAndChild.recipientKey });
  const rejectsBoth = (invalid, runtimePattern) => {
    assert.equal(validateSchema(structuredClone(invalid)), false, `Schema意外接受：${JSON.stringify(invalid)}`);
    assert.throws(() => validateMessage(structuredClone(invalid)), runtimePattern);
  };
  rejectsBoth(unknownField, /字段集合非法/);
  rejectsBoth(missingParentEffect, /字段集合非法/);
  rejectsBoth(inboundWithEffect, /入站Message状态非法/);
  rejectsBoth(outboundReceived, /出站Message状态非法/);
  rejectsBoth(textNull, /文本Message内容非法/);
  rejectsBoth(fileIdNull, /文件引用非法/);
  rejectsBoth(fileIdEmpty, /文件引用非法/);
  rejectsBoth(nameNumber, /文件引用非法/);
  rejectsBoth(sourceRefNumber, /文件引用非法/);
  assert.equal(validateSchema(structuredClone(equalParentAndChild)), true, '标准JSON Schema无$data时不能表达跨字段不等');
  assert.throws(() => validateMessage(structuredClone(equalParentAndChild)), /父子键必须不同/);
  await close(service);
});

test('P2-M1红灯：同一事件20并发只保留一个Run、一个入站事实和一个回执', async () => {
  const { service } = await setup();
  const same = event('concurrent');
  const results = await Promise.all(Array.from({ length: 20 }, () => service.dispatch(structuredClone(same))));
  const runIds = new Set(results.flat().map(item => item.runId));
  assert.equal(runIds.size, 1);
  assert.equal((await service.runs.list()).filter(item => item.eventId === same.eventId).length, 1);
  const messages = await service.messageLogs.findByEvent(same.eventId);
  assert.equal(messages.filter(item => item.direction === 'inbound').length, 1);
  assert.equal(messages.filter(item => item.direction === 'outbound').length, 1);
  await close(service);
});

test('P2-M1红灯：物理消息同fingerprint跨event收敛，异fingerprint冲突且全量事实不变', async () => {
  const { service } = await setup();
  const first = event('conflict');
  const firstRuns = await service.dispatch(first);
  const inbound = (await service.messageLogs.findByEvent(first.eventId)).find(item => item.direction === 'inbound');
  assert.ok(inbound?.externalMessageId === first.payload.messageId);

  const alias = structuredClone(first);
  alias.eventId = 'event_conflict_alias';
  const aliasRuns = await service.dispatch(alias);
  assert.deepEqual(aliasRuns.map(item => item.runId), firstRuns.map(item => item.runId), '同一物理消息应收敛到首次Runs');
  const physical = await service.messageLogs.findByExternal('mock', inbound.conversationId, first.payload.messageId);
  assert.equal(physical.messageId, inbound.messageId);
  const stable = await integritySnapshot(service);

  const messageConflict = structuredClone(alias);
  messageConflict.eventId = 'event_conflict_message_changed';
  messageConflict.payload.text = '被篡改';
  await assert.rejects(service.dispatch(messageConflict), error => error?.code === 'MESSAGE_ID_CONFLICT');
  assert.deepEqual(await integritySnapshot(service), stable, '物理消息冲突不得产生任何副作用');

  const eventConflict = structuredClone(first);
  eventConflict.payload.text = '同事件不同内容';
  await assert.rejects(service.dispatch(eventConflict), error => error?.code === 'EVENT_ID_CONFLICT');
  assert.deepEqual(await integritySnapshot(service), stable, '事件冲突不得产生任何副作用');
  await close(service);
});

test('P2-M1红灯：不同Conversation可合法复用相同externalMessageId', async () => {
  const { service } = await setup();
  const first = event('same_external_first');
  first.payload.messageId = 'external_same_scoped';
  const second = event('same_external_second');
  second.payload.messageId = 'external_same_scoped';
  second.payload.groupId = 'group_other_scope';
  await service.createAutomationTask({
    capabilities: ['collect'], taskName: '另一会话收取链', groupId: 'group_other_scope',
    collectRule: { allowedExtensions: ['.docx'], keyword: '作业' },
    nameTemplate: '{studentId}_{name}{originalExtension}',
    roster: [{ userId: '1000012345', name: '另一会话成员', studentId: 'SCOPE01' }]
  });
  await service.dispatch(first);
  await service.dispatch(second);
  const inbound = (await service.messageLogs.list()).filter(item => item.direction === 'inbound' && item.externalMessageId === 'external_same_scoped');
  assert.equal(inbound.length, 2);
  assert.equal(new Set(inbound.map(item => item.conversationId)).size, 2);
  await close(service);
});

test('P2-M1红灯：多Flow单消息Link唯一、引用完整，重复与并发dispatch不增不丢', async () => {
  const { service } = await setup();
  const original = await service.flows.get('flow_collect_demo');
  await service.saveFlow({ ...original, flowId: 'flow_collect_second', name: '第二条收取链', actions: original.actions.map((action, index) => ({ ...action, actionId: `action_second_${index}` })) });
  const incoming = event('multi_flow');
  const runs = await service.dispatch(incoming);
  assert.equal(runs.length, 2);
  const inbound = (await service.messageLogs.findByEvent(incoming.eventId)).find(item => item.direction === 'inbound');
  assert.ok(inbound);
  assert.equal(inbound.flowId, null);
  assert.equal(inbound.runId, null);

  await service.dispatch(structuredClone(incoming));
  await Promise.all(Array.from({ length: 10 }, () => service.dispatch(structuredClone(incoming))));
  const links = await service.messageRunLinks.listByMessage(inbound.messageId);
  assert.equal(links.length, 2);
  assert.equal(new Set(links.map(item => `${item.messageId}:${item.runId}`)).size, 2);
  assert.deepEqual(new Set(links.map(item => item.runId)), new Set(runs.map(item => item.runId)));
  for (const link of links) {
    assert.ok(await service.messageLogs.get(link.messageId));
    assert.ok(await service.runs.get(link.runId));
  }
  await close(service);
});

test('P2-M1红灯：deliveryStatus不把本地Mock伪装为真实送达', async () => {
  const { service } = await setup();
  const incoming = event('delivery');
  await service.dispatch(incoming);
  const messages = await service.messageLogs.findByEvent(incoming.eventId);
  assert.equal(messages.find(item => item.direction === 'inbound').deliveryStatus, 'received');
  const outbound = messages.filter(item => item.direction === 'outbound');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].deliveryStatus, 'mock_recorded');
  assert.ok(outbound[0].actionKey);
  assert.equal(messages.some(item => item.deliveryStatus === 'pending'), false, '终态Run不能残留pending');
  const publicResult = JSON.stringify({ messages, projection: await service.messageSnapshot() });
  assert.equal(/delivered|read/.test(publicResult), false);
  await close(service);
});

test('P2-M1红灯：Agent草稿、凭据和上下文绝不写入业务消息事实源', async () => {
  const { service } = await setup();
  const conversationId = 'agentconv_p2m1_secret';
  const created = await service.agent.create({ conversationId });
  const secret = 'P2M1_AGENT_SECRET_SENTINEL';
  await service.agent.message(created.draftId, {
    conversationId,
    draftToken: created.draftToken,
    message: secret
  });
  assert.equal((await service.messageLogs.list()).length, 0);
  assert.equal((await service.conversations.list()).length, 0);
  const serialized = JSON.stringify(await service.messageSnapshot());
  for (const forbidden of [secret, created.draftId, created.draftToken, 'draftTokenHash', 'trustedContext', 'planSpec']) {
    assert.equal(serialized.includes(forbidden), false, `消息事实不得包含 ${forbidden}`);
  }
  await close(service);
});

test('P2-M1阻塞复核：两个EngineService并发同事件由SQLite唯一claim收敛', async () => {
  const { service: first, dataDir } = await setup();
  const second = new EngineService({ dataDir, now });
  const same = event('two_services');
  const results = await Promise.all([
    ...Array.from({ length: 10 }, () => first.dispatch(structuredClone(same))),
    ...Array.from({ length: 10 }, () => second.dispatch(structuredClone(same)))
  ]);
  assert.equal(new Set(results.flat().map(item => item.runId)).size, 1);
  assert.equal((await first.runs.list()).filter(item => item.eventId === same.eventId).length, 1);
  assert.equal((await first.messageLogs.findByEvent(same.eventId)).filter(item => item.direction === 'inbound').length, 1);
  assert.equal((await first.messageLogs.findByEvent(same.eventId)).filter(item => item.direction === 'outbound').length, 1);
  await close(second);
  await close(first);
});

test('B3：两个独立Node进程并发初始化并dispatch同一事件，loser等待并返回winner同一终态Run', async () => {
  const dataDir = await tempDir();
  const same = event('two_processes');
  const workers = [
    spawnB3Worker({ role: 'seed-worker', dataDir, event: same }),
    spawnB3Worker({ role: 'peer-worker', dataDir, event: same })
  ];
  let inspector = null;
  try {
    const ready = await within(Promise.all(workers.map(item => item.ready)), '双进程并发初始化');
    assert.notEqual(ready[0].pid, ready[1].pid);
    assert.equal(ready.every(item => item.pid !== process.pid), true);
    for (const worker of workers) worker.child.stdin.end('go\n');
    const results = await within(Promise.all(workers.map(item => item.result)), '双进程并发dispatch');
    const exitCodes = await within(Promise.all(workers.map(item => item.exit)), '双进程退出');
    assert.deepEqual(exitCodes, [0, 0]);
    assert.equal(workers.every(item => !/SQLITE_BUSY|database (?:table )?is locked/i.test(item.stderr())), true, workers.map(item => item.stderr()).join('\n'));
    assert.equal(results.every(item => item.runIds.length === 1), true, 'winner与loser都必须返回非空Run');
    assert.equal(results.every(item => item.statuses.length === 1 && item.statuses[0] === 'succeeded'), true);
    assert.equal(new Set(results.flatMap(item => item.runIds)).size, 1);
    const [stableRunId] = results[0].runIds;
    for (const result of results) {
      assert.deepEqual(result.runIds, [stableRunId]);
      assert.deepEqual(result.counts, { eventClaims: 1, runs: 1, inbound: 1, outbound: 1, outbox: 1, performs: 1, receipts: 1 });
    }

    inspector = new EngineService({ dataDir, now });
    const claims = await inspector.eventClaims.list(item => item.eventId === same.eventId);
    const runs = (await inspector.runs.list()).filter(item => item.eventId === same.eventId);
    const messages = await inspector.messageLogs.findByEvent(same.eventId);
    const outbox = await inspector.outbox.listByRun(stableRunId);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].status, 'completed');
    assert.deepEqual(claims[0].runIds, [stableRunId]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, stableRunId);
    assert.equal(runs[0].status, 'succeeded');
    assert.equal(messages.filter(item => item.direction === 'inbound').length, 1);
    assert.equal(messages.filter(item => item.direction === 'outbound').length, 1);
    assert.equal((await inspector.messageRunLinks.listByRun(stableRunId)).length, 1);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].journalStatus, 'committed');
    assert.equal(inspector.adapters.connectorPerforms().length, 1);
    assert.equal(inspector.adapters.connectorReceipts().length, 1);
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
    if (inspector) await close(inspector);
  }
});

test('P2-M1阻塞复核：self_message_sent入站持久化且只使用immutableFingerprint', async () => {
  const { service } = await setup();
  const input = {
    schemaVersion: '0.3-rc1', eventId: 'event_self_message_fact', type: 'self_message_sent', occurredAt: '2026-08-01T18:05:00+08:00',
    payload: { messageId: 'message_self_message_fact', conversationId: 'assistant_main', senderUserId: '9000012345', text: '发布本周作业' }
  };
  await service.dispatch(input);
  const inbound = (await service.messageLogs.findByEvent(input.eventId)).find(item => item.direction === 'inbound');
  assert.ok(inbound);
  assert.match(inbound.immutableFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(inbound, 'fingerprint'), false);
  assert.equal((await service.conversations.get(inbound.conversationId)).kind, 'assistant');
  await close(service);
});
