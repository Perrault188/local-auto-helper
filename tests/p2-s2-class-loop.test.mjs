import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mockArtifactContent } from '../engine/mock-adapters.mjs';
import { MockArtifactStore } from '../engine/artifacts.mjs';

const port = 43378;
const base = `http://127.0.0.1:${port}`;
let dataDir;
let child;
let sequence = 0;
let classTask;

async function startServer() {
  const proc = spawn(process.execPath, ['demo/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), AUTO_HELPER_DATA_DIR: dataDir, AUTO_HELPER_SCHEDULER_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('本地Demo服务启动超时')), 5000);
    proc.once('exit', code => reject(new Error(`本地Demo服务异常退出 ${code}`)));
    proc.stdout.on('data', chunk => { if (chunk.toString().includes('Demo已启动')) { clearTimeout(timeout); resolve(); } });
  });
  return proc;
}

async function stopServer(proc) {
  if (!proc) return;
  await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); });
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

const eventId = label => `event_p2s2_${label}_${Date.now()}_${sequence++}`;
const messageId = label => `message_p2s2_${label}_${Date.now()}_${sequence++}`;

function input(overrides = {}) {
  return {
    taskName: '软件工程第3周作业',
    groupId: 'group_se_p2s2',
    publishText: '请在截止前私聊提交作业文件。',
    noticeFilePath: '/demo/source/软件工程第3周作业.pdf',
    publishAt: '2026-08-11T10:00:00+08:00',
    deadlineAt: '2026-08-15T18:00:00+08:00',
    collectRule: { allowedExtensions: ['.docx'] },
    nameTemplate: '{studentId}_{name}{originalExtension}',
    remindText: '还没交第3周作业，请尽快提交。',
    roster: [
      { userId: '6500010001', name: '测试成员甲', studentId: 'SE001' },
      { userId: '6500010002', name: '测试成员乙', studentId: 'SE002' },
      { userId: '6500010003', name: '测试成员丙', studentId: 'SE003' }
    ],
    ...overrides
  };
}

async function createTask(value) {
  const { response, data } = await jsonRequest('/api/automation-tasks', 'POST', value);
  assert.equal(response.ok, true, JSON.stringify(data));
  return data.result;
}

async function state() { return (await jsonRequest('/api/state')).data; }

async function directSubmit(task, senderUserId, name = '作业.docx') {
  const result = await jsonRequest(`/api/automation-tasks/${task.automationId}/mock-direct-file`, 'POST', {
    eventId: eventId('direct'), messageId: messageId('direct'), senderUserId, text: '提交作业',
    file: { fileId: `file_${sequence++}`, name, sourceRef: `mock-upload:${senderUserId}/${name}` },
    occurredAt: '2026-08-12T09:00:00+08:00'
  });
  assert.equal(result.response.ok, true, JSON.stringify(result.data));
  return result.data;
}

function zipEntries(bytes) {
  const entries = [];
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    entries.push({ name: bytes.subarray(nameStart, nameStart + nameLength).toString('utf8'), content: bytes.subarray(contentStart, contentStart + size) });
    offset = contentStart + size;
  }
  return entries;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'local-auto-helper-p2s2-'));
  child = await startServer();
});
after(() => stopServer(child));

test('P2-S2班委闭环产生真实消息与执行证据链', async () => {
  classTask = await createTask(input());
  let current = await state();
  const publish = current.flows.find(flow => classTask.flowIds.includes(flow.flowId) && flow.templateId === 'homework_publish_v1');
  const remind = current.flows.find(flow => classTask.flowIds.includes(flow.flowId) && flow.templateId === 'homework_remind_v1');

  let result = await jsonRequest('/api/events/dispatch', 'POST', {
    schemaVersion: '0.2-rc1', eventId: eventId('publish'), type: 'self_message_sent', occurredAt: '2026-08-11T10:00:00+08:00',
    payload: { messageId: messageId('publish'), conversationId: publish.hook.params.conversationId, senderUserId: '9000012345', text: publish.hook.params.keyword }
  });
  assert.equal(result.data.runs[0].status, 'succeeded');

  assert.equal((await directSubmit(classTask, '6500010001')).runs[0].status, 'succeeded');
  assert.equal((await directSubmit(classTask, '6500010002')).runs[0].status, 'succeeded');

  result = await jsonRequest('/api/events/dispatch', 'POST', {
    schemaVersion: '0.2-rc1', eventId: eventId('remind'), type: 'timer_fired', occurredAt: remind.hook.params.runAt,
    payload: { scheduledFor: remind.hook.params.runAt, timezone: remind.hook.params.timezone }
  });
  assert.equal(result.data.runs[0].status, 'succeeded');

  const summary = await jsonRequest(`/api/automation-tasks/${classTask.automationId}/evidence`);
  assert.equal(summary.response.ok, true);
  assert.deepEqual(summary.data.progress, { expected: 3, received: 2, missing: 1 });
  assert.deepEqual(summary.data.missingMembers.map(member => member.name), ['测试成员丙']);
  assert.equal(summary.data.artifacts.length, 2);
  assert.equal(summary.data.deliveries.group.succeeded, 1);
  assert.equal(summary.data.deliveries.receipt.succeeded, 2);
  assert.equal(summary.data.deliveries.reminder.succeeded, 1);
  assert.ok(summary.data.messages.every(item => item.runId && item.actionId && item.deliveryStatus));
  assert.match(summary.data.summaryText, /应交3人，已收2人，未交1人/);
  const conversations = (await jsonRequest('/api/conversations')).data.items;
  assert.equal(conversations[0].displayLabel, '测试成员丙');
  assert.equal(conversations[0].latestMessage, '还没交第3周作业，请尽快提交。');
  assert.ok(conversations.every((item, index) => index === 0 || item.updatedAt <= conversations[index - 1].updatedAt));
});

test('同名文件按任务与成果标识隔离，不跨任务覆盖', async () => {
  const second = await createTask(input({
    capabilities: ['collect'], taskName: '隔离对照任务', groupId: 'group_isolated_p2s2',
    roster: [{ userId: '6500020001', name: '测试成员丁', studentId: 'ISO001' }]
  }));
  await directSubmit(second, '6500020001', '作业.docx');
  const firstEvidence = (await jsonRequest(`/api/automation-tasks/${classTask.automationId}/evidence`)).data;
  const secondEvidence = (await jsonRequest(`/api/automation-tasks/${second.automationId}/evidence`)).data;
  assert.equal(secondEvidence.artifacts.length, 1);
  assert.equal(firstEvidence.artifacts.length, 2);
  assert.notEqual(firstEvidence.artifacts[0].artifactId, secondEvidence.artifacts[0].artifactId);
  assert.equal(JSON.stringify(firstEvidence).includes(second.taskAttachmentId), false);
  assert.equal(JSON.stringify(secondEvidence).includes(classTask.taskAttachmentId), false);
});

test('重复提交和文件类型错误都不覆盖首次成果', async () => {
  const duplicate = await directSubmit(classTask, '6500010001', '重复作业.docx');
  assert.equal(duplicate.runs[0].status, 'succeeded_no_action');
  let evidence = (await jsonRequest(`/api/automation-tasks/${classTask.automationId}/evidence`)).data;
  assert.equal(evidence.artifacts.length, 2);
  assert.equal(evidence.noActionReason, '重复提交，已保留首次文件');

  const wrongType = await jsonRequest(`/api/automation-tasks/${classTask.automationId}/mock-direct-file`, 'POST', {
    eventId: eventId('wrong_type'), messageId: messageId('wrong_type'), senderUserId: '6500010003', text: '提交作业',
    file: { fileId: `file_${sequence++}`, name: '作业.exe', sourceRef: 'mock-upload:6500010003/作业.exe' },
    occurredAt: '2026-08-12T10:00:00+08:00'
  });
  assert.equal(wrongType.response.ok, true);
  assert.equal(wrongType.data.runs.length, 0);
  assert.equal(wrongType.data.noActionReason, '文件类型不符合任务收取规则');
  evidence = (await jsonRequest(`/api/automation-tasks/${classTask.automationId}/evidence`)).data;
  assert.equal(evidence.artifacts.length, 2);
});

test('ZIP下载链接不可猜且只能成功使用一次', async () => {
  const archive = await jsonRequest(`/api/automation-tasks/${classTask.automationId}/archive`, 'POST', {});
  assert.equal(archive.response.status, 201);
  assert.match(archive.data.downloadUrl, /^\/api\/downloads\/[A-Za-z0-9_-]{32,}$/);
  assert.equal(archive.data.downloadUrl.includes(classTask.automationId), false);
  assert.equal(archive.data.downloadUrl.includes(classTask.taskAttachmentId), false);

  const first = await fetch(`${base}${archive.data.downloadUrl}`);
  const bytes = Buffer.from(await first.arrayBuffer());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'application/zip');
  assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
  assert.equal(bytes.includes(Buffer.from('SE001_测试成员甲.docx')), true);
  const entries = zipEntries(bytes);
  assert.equal(entries.every(entry => !entry.name.includes('/')), true);
  assert.equal(entries.every(entry => entry.content.subarray(0, 2).toString() === 'PK'), true);

  const second = await fetch(`${base}${archive.data.downloadUrl}`);
  assert.equal(second.status, 410);
});

test('ZIP根目录直接放作业，同名文件加序号且PDF内容可打开', async () => {
  const task = await createTask(input({
    capabilities: ['collect'], taskName: '扁平PDF任务', groupId: 'group_flat_pdf',
    collectRule: { allowedExtensions: ['.pdf'] }, nameTemplate: '作业{originalExtension}',
    roster: [
      { userId: '6500030001', name: '成员甲', studentId: 'PDF001' },
      { userId: '6500030002', name: '成员乙', studentId: 'PDF002' }
    ]
  }));
  await directSubmit(task, '6500030001', '第一份.pdf');
  await directSubmit(task, '6500030002', '第二份.pdf');
  const archive = await jsonRequest(`/api/automation-tasks/${task.automationId}/archive`, 'POST', {});
  const response = await fetch(`${base}${archive.data.downloadUrl}`);
  const entries = zipEntries(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(entries.map(entry => entry.name), ['作业.pdf', '作业_2.pdf']);
  assert.equal(entries.every(entry => entry.content.subarray(0, 8).toString() === '%PDF-1.4'), true);
  assert.equal(entries.every(entry => entry.content.subarray(-6).toString().includes('%%EOF')), true);
});

test('Mock预设文件类型使用与扩展名匹配的可打开内容', () => {
  assert.equal(mockArtifactContent('作业.pdf').subarray(0, 8).toString(), '%PDF-1.4');
  assert.equal(mockArtifactContent('作业.docx').subarray(0, 2).toString(), 'PK');
  assert.equal(mockArtifactContent('日报.xlsx').subarray(0, 2).toString(), 'PK');
  assert.equal(mockArtifactContent('旧作业.doc').subarray(0, 5).toString(), '{\\rtf');
  assert.equal(mockArtifactContent('截图.png').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(mockArtifactContent('照片.jpg').subarray(0, 2).toString('hex'), 'ffd8');
});

test('旧Mock文本成果在下载时转换为可打开PDF', async () => {
  const store = new MockArtifactStore(await mkdtemp(join(tmpdir(), 'local-auto-helper-legacy-artifact-')), {
    now: () => '2026-08-29T10:00:00.000Z',
    contentForDownload: (name, content) => name.endsWith('.pdf') ? mockArtifactContent(name, name) : content
  });
  store.save({ artifactId: 'legacy_pdf', taskAttachmentId: 'legacy_task', memberUserId: '6500099999', originalName: '旧文件.pdf', storedName: 'PDF999_旧成员.pdf', content: Buffer.from('本地助手Mock文件成果') });
  const download = store.createDownload('legacy_task');
  const entries = zipEntries(store.consumeDownload(download.token).content);
  assert.deepEqual(entries.map(entry => entry.name), ['PDF999_旧成员.pdf']);
  assert.equal(entries[0].content.subarray(0, 8).toString(), '%PDF-1.4');
  store.close();
});

test('重启后文件成果和统一汇报仍可恢复', async () => {
  const beforeResponse = await jsonRequest(`/api/automation-tasks/${classTask.automationId}/evidence`);
  assert.equal(beforeResponse.response.ok, true);
  const before = beforeResponse.data;
  await stopServer(child);
  child = await startServer();
  const afterResponse = await jsonRequest(`/api/automation-tasks/${classTask.automationId}/evidence`);
  assert.equal(afterResponse.response.ok, true);
  const after = afterResponse.data;
  assert.deepEqual(after.progress, before.progress);
  assert.deepEqual(after.artifacts, before.artifacts);
  assert.deepEqual(after.messages, before.messages);
});
