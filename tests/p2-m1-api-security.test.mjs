import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EngineService } from '../engine/index.mjs';

const port = 43381;
const base = `http://127.0.0.1:${port}`;
let dataDir;
let child;

async function startServer() {
  const proc = spawn(process.execPath, ['demo/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), AUTO_HELPER_DATA_DIR: dataDir, AUTO_HELPER_SCHEDULER_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('P2-M1安全测试服务启动超时')), 5000);
    proc.once('exit', code => reject(new Error(`服务异常退出 ${code}`)));
    proc.stdout.on('data', chunk => { if (chunk.toString().includes('Demo已启动')) { clearTimeout(timeout); resolve(); } });
  });
  return proc;
}
async function stopServer(proc) { if (!proc) return; await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); }); }
async function req(path, method = 'GET', value, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: value === undefined ? undefined : JSON.stringify(value)
  });
  let data = {};
  try { data = await response.json(); } catch {}
  return { status: response.status, ok: response.ok, data };
}
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const planHash = plan => createHash('sha256').update(JSON.stringify(stable(plan))).digest('hex');
const runtimeRepos = ['conversations','messageLogs','messageRunLinks','eventClaims','runClaims','actionClaims','effects','outbox'];
async function runtimeAudit() {
  const service = new EngineService({ dataDir });
  try {
    const repositories = Object.fromEntries(await Promise.all(runtimeRepos.map(async name => [name, await service[name].list()])));
    return { repositories, projection: await service.messageSnapshot() };
  } finally { service.db.close(); }
}
const expectNoRuntimeFacts = async () => {
  const audit = await runtimeAudit();
  assert.equal(Object.values(audit.repositories).every(items => items.length === 0), true);
  assert.equal(Object.values(audit.projection).every(items => items.length === 0), true);
  return audit;
};

before(async () => { dataDir = await mkdtemp(join(tmpdir(), 'local-auto-helper-p2-m1-api-security-')); child = await startServer(); });
after(() => stopServer(child));

test('P2-M1红灯：Agent草稿不进入业务会话API，公开状态不泄漏凭据与草稿原文', async () => {
  const secret = 'P2M1_HTTP_AGENT_SECRET';
  const created = await req('/api/agent/drafts', 'POST', { conversationId: 'agentconv_http_secret' });
  assert.equal(created.ok, true);
  const draft = created.data.draft;
  const token = draft.draftToken;
  const auth = { 'x-agent-conversation-id': 'agentconv_http_secret', 'x-agent-draft-token': token };
  const messaged = await req(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { message: secret }, auth);
  assert.equal(messaged.ok, true);

  const state = await req('/api/state');
  const conversations = await req('/api/conversations');
  assert.equal(conversations.ok, true);
  assert.deepEqual(conversations.data.items, []);
  const forbiddenAgentRead = await req('/api/conversations/agentconv_http_secret/messages');
  assert.ok([403, 404].includes(forbiddenAgentRead.status));

  const publicText = JSON.stringify({ state: state.data, conversations: conversations.data });
  for (const forbidden of [secret, draft.draftId, token, 'draftTokenHash', 'trustedContext', 'planSpec', 'revisionHistory']) {
    assert.equal(publicText.includes(forbidden), false, `公开响应不得泄漏 ${forbidden}`);
  }
});

test('P2-M1阻塞复核：可支持目标真实确认前后不得写入运行期消息事实或公共面', async () => {
  await req('/api/reset', 'POST');
  const targetSentinel = '只收文件登记';
  const created = await req('/api/agent/drafts', 'POST', { conversationId: 'agentconv_m1_12_supported' });
  assert.equal(created.ok, true);
  let draft = created.data.draft;
  const token = draft.draftToken;
  const auth = { 'x-agent-conversation-id': 'agentconv_m1_12_supported', 'x-agent-draft-token': token };
  draft = (await req(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { message: targetSentinel }, auth)).data.draft;
  if (draft.status === 'awaiting_candidate') {
    const candidate = draft.candidateUnderstandings.find(item => item.capabilities.includes('collect') && item.capabilities.includes('remind')) ?? draft.candidateUnderstandings[0];
    draft = (await req(`/api/agent/drafts/${draft.draftId}/choose-candidate`, 'POST', { candidateId: candidate.candidateId }, auth)).data.draft;
  }
  const answers = {
    taskName: 'M1安全收取帮办', replyText: '已模拟登记', remindText: '请及时提交',
    remindAt: '2026-08-10T18:00:00+08:00', deadlineAt: '2026-08-10T18:00:00+08:00',
    publishText: '请及时提交', publishAt: '2026-08-02T09:00:00+08:00', publishKeyword: '开始'
  };
  for (let step = 0; draft.status !== 'ready_for_confirmation' && step < 12; step += 1) {
    const field = draft.pendingQuestion?.field;
    assert.ok(field, `第${step + 1}步应有待答字段`);
    const options = await req(`/api/agent/drafts/${draft.draftId}/context-options`, 'GET', undefined, auth);
    assert.equal(options.ok, true);
    const option = options.data.options[0];
    const payload = option ? { contextOptionIds: [option.optionId] } : { userAnswer: answers[field] };
    assert.ok(option || answers[field], `${field}缺少安全回答`);
    draft = (await req(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', payload, auth)).data.draft;
  }
  assert.equal(draft.status, 'ready_for_confirmation');
  await expectNoRuntimeFacts();

  const confirmation = await req(`/api/agent/drafts/${draft.draftId}/confirm`, 'POST', { revision: draft.revision, planHash: planHash(draft.planSpec) }, auth);
  assert.equal(confirmation.ok, true);
  assert.equal(confirmation.data.draft.status, 'compiled');
  const audit = await expectNoRuntimeFacts();
  const state = await req('/api/state');
  const conversations = await req('/api/conversations');
  const messageApi = await req('/api/conversations/conv_no_business_messages/messages');
  const publicSurface = JSON.stringify({ audit, state: state.data, conversations: conversations.data, messageApi: messageApi.data });
  for (const forbidden of [targetSentinel, draft.draftId, token, 'draftTokenHash', 'planSpec', 'candidateUnderstandings', 'revisionHistory', 'trustedContext', 'idempotencyKey']) {
    assert.equal(publicSurface.includes(forbidden), false, `确认后消息事实与公共面不得包含 ${forbidden}`);
  }
});

test('P2-M1红灯：独立消息读取和/api/state均不暴露本地绝对路径或内部sourceRef', async () => {
  const task = await req('/api/automation-tasks', 'POST', {
    capabilities: ['collect'], taskName: 'API路径安全', groupId: 'group_api_security',
    collectRule: { allowedExtensions: ['.docx'] }, nameTemplate: '{studentId}_{name}{originalExtension}',
    roster: [{ userId: '6400012345', name: '安全成员', studentId: 'SEC01' }]
  });
  assert.equal(task.ok, true);
  const dispatched = await req('/api/events/dispatch', 'POST', {
    schemaVersion: '0.3-rc1', eventId: 'event_api_private_path', type: 'group_file_received', occurredAt: '2026-08-01T21:00:00+08:00',
    payload: {
      messageId: 'message_api_private_path', groupId: 'group_api_security', senderUserId: '6400012345', text: '提交',
      file: { fileId: 'file_api_private_path', name: '作业.docx', path: '/sensitive-demo/Documents/合成作业.docx' }
    }
  });
  assert.equal(dispatched.ok, true);

  const conversations = await req('/api/conversations');
  assert.equal(conversations.ok, true);
  assert.equal(conversations.data.items.length, 1);
  const conversationId = conversations.data.items[0].conversationId;
  const messages = await req(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
  assert.equal(messages.ok, true);
  const state = await req('/api/state');
  const publicText = JSON.stringify({ state: state.data, conversations: conversations.data, messages: messages.data });
  assert.equal(publicText.includes('/sensitive-demo'), false);
  assert.equal(publicText.includes('mock-path:/Users'), false);
  assert.equal(publicText.includes('sourceRef'), false);

  const publicRun = dispatched.data.runs[0];
  const stateRun = state.data.runs.find(item => item.runId === publicRun.runId);
  assert.deepEqual(publicRun, stateRun, 'dispatch与state必须使用同一个publicRun DTO');
  assert.deepEqual(Object.keys(publicRun).sort(), ['error','eventId','eventSnapshot','finishedAt','flowId','runId','schemaVersion','startedAt','status','steps','viewedAt'].sort());
  assert.deepEqual(Object.keys(publicRun.eventSnapshot), ['type']);
  assert.equal(Object.hasOwn(publicRun, 'flowSnapshot'), false);
  for (const step of publicRun.steps) assert.deepEqual(Object.keys(step).sort(), ['actionId','actionType','finishedAt','startedAt','status'].sort());

  const attachment = state.data.attachments.find(item => item.taskAttachmentId === task.data.result.taskAttachmentId);
  assert.deepEqual(Object.keys(attachment).sort(), ['deadlineAt','groupId','members','taskAttachmentId','taskName','updatedAt'].sort());
  assert.deepEqual(Object.keys(attachment.members[0]).sort(), ['filePath','lastSubmittedAt','name','userId','remindedAt','reminderStatus','studentId','submissionStatus'].sort());
  assert.equal(attachment.members[0].filePath, 'SEC01_安全成员.docx');
  assert.equal(attachment.members[0].filePath.includes('/'), false);

  const publicConversation = conversations.data.items[0];
  assert.deepEqual(Object.keys(publicConversation).sort(), ['connector','conversationId','createdAt','displayLabel','kind','latestMessage','updatedAt'].sort());
  assert.equal(publicConversation.displayLabel, '班级群聊');
  assert.equal(publicConversation.latestMessage, messages.data.items.at(-1).text);
  const publicMessage = messages.data.items[0];
  assert.deepEqual(Object.keys(publicMessage).sort(), ['conversationId','deliveryStatus','direction','file','kind','messageId','occurredAt','recipientLabel','senderLabel','text'].sort());
  assert.equal(JSON.stringify(conversations.data).includes('externalKey'), false);
  const publicMessageText = JSON.stringify(messages.data);
  for (const forbiddenKey of ['externalMessageId','senderRef','recipientKey','actionKey','effectKey','actionId','automationId','flowId','runId','payloadHash','immutableFingerprint']) assert.equal(publicMessageText.includes(`"${forbiddenKey}"`), false, forbiddenKey);


  const withoutAttachments = structuredClone({ state: state.data, conversations: conversations.data, messages: messages.data });
  delete withoutAttachments.state.attachments;
  const nonAttachmentText = JSON.stringify(withoutAttachments);
  assert.equal(nonAttachmentText.includes('6400012345'), false, '用户ID只能出现在state.attachments');
  assert.equal(nonAttachmentText.includes('SEC01'), false, '学号只能出现在state.attachments');

  const internal = new EngineService({ dataDir });
  try {
    const stored = await internal.runs.get(publicRun.runId);
    assert.ok(stored.flowSnapshot);
    assert.ok(stored.eventSnapshot.payload);
    assert.ok(stored.steps.some(step => Object.keys(step.input ?? {}).length > 0));
  } finally { internal.db.close(); }
});
