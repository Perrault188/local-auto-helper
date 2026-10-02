import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { planHash } from '../engine/index.mjs';

const port = 43317;
const base = `http://127.0.0.1:${port}`;
let dataDir;
let child;
const request = async (path, method = 'GET', value, auth) => {
  const headers = { 'content-type': 'application/json' };
  if (auth) { headers['x-agent-conversation-id'] = auth.conversationId; headers['x-agent-draft-token'] = auth.draftToken; }
  const response = await fetch(`${base}${path}`, { method, headers, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, data: await response.json() };
};
async function start() {
  const proc = spawn(process.execPath, ['demo/server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), AUTO_HELPER_DATA_DIR: dataDir, AUTO_HELPER_SCHEDULER_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Agent API服务启动超时')), 5000);
    proc.once('exit', code => reject(new Error(`Agent API服务异常退出 ${code}`)));
    proc.stdout.on('data', chunk => { if (chunk.toString().includes('Demo已启动')) { clearTimeout(timer); resolve(); } });
  });
  return proc;
}
before(async () => { dataDir = await mkdtemp(join(tmpdir(), 'local-auto-helper-agent-api-')); child = await start(); });
after(async () => { if (child) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); });

test('Agent草稿API支持创建、消息、读取、确认与幂等重放', async () => {
  const created = await request('/api/agent/drafts', 'POST', { conversationId: 'api_conversation' });
  assert.equal(created.status, 201);
  const id = created.data.draft.draftId;
  const auth = { conversationId: 'api_conversation', draftToken: created.data.draft.draftToken };
  let messaged = await request(`/api/agent/drafts/${id}/messages`, 'POST', { message: '只收文件登记' }, auth);
  messaged = await request(`/api/agent/drafts/${id}/messages`, 'POST', { userAnswer: '资料收件' }, auth);
  for (const field of ['groupId', 'collectRule', 'nameTemplate', 'roster']) {
    const options = await request(`/api/agent/drafts/${id}/context-options`, 'GET', undefined, auth);
    const option = options.data.options.find(item => item.field === field);
    assert.ok(option, `应提供${field}受控选项`);
    messaged = await request(`/api/agent/drafts/${id}/messages`, 'POST', { contextOptionIds: [option.optionId] }, auth);
  }
  assert.equal(messaged.data.draft.pendingQuestion.field, 'deadlineAt');
  messaged = await request(`/api/agent/drafts/${id}/messages`, 'POST', { userAnswer: '2026-08-20T18:00:00+08:00' }, auth);
  let options = await request(`/api/agent/drafts/${id}/context-options`, 'GET', undefined, auth);
  assert.deepEqual(options.data.options.map(item => item.label), ['回复“收到，已帮你登记”', '回复“收到，文件已按要求保存”']);
  messaged = await request(`/api/agent/drafts/${id}/messages`, 'POST', { contextOptionIds: [options.data.options[0].optionId] }, auth);
  assert.equal(messaged.status, 200);
  assert.equal(messaged.data.draft.status, 'ready_for_confirmation');
  const read = await request(`/api/agent/drafts/${id}`, 'GET', undefined, auth);
  assert.equal(read.data.draft.revision, messaged.data.draft.revision);
  const confirmation = { revision: read.data.draft.revision, planHash: planHash(read.data.draft.planSpec) };
  const confirmed = await request(`/api/agent/drafts/${id}/confirm`, 'POST', confirmation, auth);
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.data.automationId, /^automation_/);
  const replay = await request(`/api/agent/drafts/${id}/confirm`, 'POST', confirmation, auth);
  assert.equal(replay.data.idempotent, true);
});

test('Agent取消API使草稿终止', async () => {
  const created = await request('/api/agent/drafts', 'POST', { conversationId: 'cancel_api' });
  const id = created.data.draft.draftId;
  const auth = { conversationId: 'cancel_api', draftToken: created.data.draft.draftToken };
  const cancelled = await request(`/api/agent/drafts/${id}/cancel`, 'POST', {}, auth);
  assert.equal(cancelled.data.draft.status, 'cancelled');
  const message = await request(`/api/agent/drafts/${id}/messages`, 'POST', { message: '继续' }, auth);
  assert.equal(message.status, 409);
});

test('Agent API拒绝缺header、错token、错会话和旧facts别名', async () => {
  const created = await request('/api/agent/drafts', 'POST', { conversationId: 'secure_api' });
  const id = created.data.draft.draftId;
  const auth = { conversationId: 'secure_api', draftToken: created.data.draft.draftToken };
  assert.equal((await request(`/api/agent/drafts/${id}`)).status, 401);
  assert.equal((await request(`/api/agent/drafts/${id}`, 'GET', undefined, { ...auth, draftToken: 'wrong' })).status, 404);
  assert.equal((await request(`/api/agent/drafts/${id}`, 'GET', undefined, { ...auth, conversationId: 'other' })).status, 404);
  assert.equal((await request(`/api/agent/drafts/${id}/messages`, 'POST', { message: '收文件', facts: {} }, auth)).status, 400);
  assert.equal((await request(`/api/agent/drafts/${id}/messages`, 'POST', {
    message: '收文件',
    trustedContext: { groupId: 'attacker_supplied_group' }
  }, auth)).status, 400);
});

test('自定义群名、文件类型和改名格式经过服务端校验后进入当前草稿', async () => {
  const created = await request('/api/agent/drafts', 'POST', { conversationId: 'custom_context_api' });
  const draft = created.data.draft;
  const auth = { conversationId: 'custom_context_api', draftToken: draft.draftToken };
  let current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { message: '帮我收作业' }, auth)).data.draft;
  current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { userAnswer: '自定义收作业' }, auth)).data.draft;
  assert.equal(current.pendingQuestion.field, 'groupId');
  current = (await request(`/api/agent/drafts/${draft.draftId}/custom-context`, 'POST', { field: 'groupId', value: '产品设计讨论群' }, auth)).data.draft;
  assert.equal(current.planSpec.bindings.groupId, '产品设计讨论群');
  assert.equal(current.pendingQuestion.field, 'collectRule');
  current = (await request(`/api/agent/drafts/${draft.draftId}/custom-context`, 'POST', { field: 'collectRule', value: 'xlsx、zip' }, auth)).data.draft;
  assert.deepEqual(current.planSpec.bindings.collectRule.allowedExtensions, ['.xlsx', '.zip']);
  assert.equal(current.pendingQuestion.field, 'nameTemplate');
  assert.equal((await request(`/api/agent/drafts/${draft.draftId}/custom-context`, 'POST', { field: 'nameTemplate', value: '{unknown}{originalExtension}' }, auth)).status, 400);
  current = (await request(`/api/agent/drafts/${draft.draftId}/custom-context`, 'POST', { field: 'nameTemplate', value: '{name}-{studentId}{originalExtension}' }, auth)).data.draft;
  assert.equal(current.planSpec.bindings.nameTemplate, '{name}-{studentId}{originalExtension}');
  assert.equal((await request(`/api/agent/drafts/${draft.draftId}/custom-context`, 'POST', { field: 'roster', value: '任意名单' }, auth)).status, 400);
  let options = (await request(`/api/agent/drafts/${draft.draftId}/context-options`, 'GET', undefined, auth)).data.options;
  current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { contextOptionIds: [options[0].optionId] }, auth)).data.draft;
  current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { userAnswer: '2026-08-20T18:00:00+08:00' }, auth)).data.draft;
  assert.equal(current.pendingQuestion.field, 'replyText');
  current = (await request(`/api/agent/drafts/${draft.draftId}/custom-context`, 'POST', { field: 'replyText', value: '收到，已保存到本次任务' }, auth)).data.draft;
  assert.equal(current.planSpec.bindings.replyText, '收到，已保存到本次任务');
  assert.equal(current.status, 'ready_for_confirmation');
});

test('发布场景先确认触发方式，并只追问对应的关键词或时间', async () => {
  const created = await request('/api/agent/drafts', 'POST', { conversationId: 'publish_trigger_api' });
  const draft = created.data.draft;
  const auth = { conversationId: 'publish_trigger_api', draftToken: draft.draftToken };
  let current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { message: '只发通知' }, auth)).data.draft;
  current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { userAnswer: '发布测试' }, auth)).data.draft;
  let options = (await request(`/api/agent/drafts/${draft.draftId}/context-options`, 'GET', undefined, auth)).data.options;
  current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { contextOptionIds: [options[0].optionId] }, auth)).data.draft;
  assert.equal(current.pendingQuestion.field, 'publishTrigger');
  options = (await request(`/api/agent/drafts/${draft.draftId}/context-options`, 'GET', undefined, auth)).data.options;
  assert.deepEqual(options.map(item => item.label), ['我发出约定消息时', '到设定时间']);
  current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { contextOptionIds: [options[0].optionId] }, auth)).data.draft;
  assert.notEqual(current.pendingQuestion.field, 'publishAt');
  assert.equal(current.planSpec.bindings.publishTrigger, 'self_message');
});

test('催交场景提供两个文案选项并允许用户自定义', async () => {
  const created = await request('/api/agent/drafts', 'POST', { conversationId: 'remind_text_api' });
  const draft = created.data.draft;
  const auth = { conversationId: 'remind_text_api', draftToken: draft.draftToken };
  let current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { message: '提醒我' }, auth)).data.draft;
  assert.equal(current.pendingQuestion.field, 'taskName');
  current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { userAnswer: '催交测试' }, auth)).data.draft;
  assert.equal(current.pendingQuestion.field, 'remindText');
  const options = (await request(`/api/agent/drafts/${draft.draftId}/context-options`, 'GET', undefined, auth)).data.options;
  assert.deepEqual(options.map(item => item.label), ['发送“作业还没提交，请尽快补交”', '发送“截止时间已到，请尽快提交作业”']);
  current = (await request(`/api/agent/drafts/${draft.draftId}/custom-context`, 'POST', { field: 'remindText', value: '还没交的同学请在今晚八点前补交。' }, auth)).data.draft;
  assert.equal(current.planSpec.bindings.remindText, '还没交的同学请在今晚八点前补交。');
  assert.equal(current.pendingQuestion.field, 'remindAt');
});

test('教学场景提供三个群名、DOC和PDF、两个改名格式及三份成员名单', async () => {
  const created = await request('/api/agent/drafts', 'POST', { conversationId: 'preset_context_api' });
  const draft = created.data.draft;
  const auth = { conversationId: 'preset_context_api', draftToken: draft.draftToken };
  await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { message: '帮我收作业' }, auth);
  await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { userAnswer: '预设选项检查' }, auth);
  let options = (await request(`/api/agent/drafts/${draft.draftId}/context-options`, 'GET', undefined, auth)).data.options;
  assert.equal(options.filter(item => item.field === 'groupId').length, 3);
  let current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { contextOptionIds: [options[0].optionId] }, auth)).data.draft;
  options = (await request(`/api/agent/drafts/${draft.draftId}/context-options`, 'GET', undefined, auth)).data.options;
  assert.deepEqual(options.filter(item => item.field === 'collectRule').map(item => item.label), ['DOC', 'PDF']);
  current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { contextOptionIds: [options[0].optionId] }, auth)).data.draft;
  options = (await request(`/api/agent/drafts/${draft.draftId}/context-options`, 'GET', undefined, auth)).data.options;
  assert.deepEqual(options.filter(item => item.field === 'nameTemplate').map(item => item.label), ['学号_姓名（保留原文件类型）', '姓名_学号（保留原文件类型）']);
  current = (await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', { contextOptionIds: [options[0].optionId] }, auth)).data.draft;
  options = (await request(`/api/agent/drafts/${draft.draftId}/context-options`, 'GET', undefined, auth)).data.options;
  assert.equal(options.filter(item => item.field === 'roster').length, 3);
});

test('一个草稿的token不能读取或修改另一个草稿', async () => {
  const first = await request('/api/agent/drafts', 'POST', { conversationId: 'same_conversation' });
  const second = await request('/api/agent/drafts', 'POST', { conversationId: 'same_conversation' });
  const wrongAuth = { conversationId: 'same_conversation', draftToken: first.data.draft.draftToken };
  assert.equal((await request(`/api/agent/drafts/${second.data.draft.draftId}`, 'GET', undefined, wrongAuth)).status, 404);
  assert.equal((await request(`/api/agent/drafts/${second.data.draft.draftId}/cancel`, 'POST', {}, wrongAuth)).status, 404);
});

test('Agent API不泄露token hash，缺失或错误token不能读取草稿', async () => {
  const created = await request('/api/agent/drafts', 'POST', { conversationId: 'token_api' });
  const draft = created.data.draft;
  assert.equal(typeof draft.draftToken, 'string');
  assert.equal(draft.draftTokenHash, undefined);
  assert.equal(draft.idempotencyKey, undefined);

  const missing = await request(`/api/agent/drafts/${draft.draftId}`);
  assert.equal(missing.status, 401);
  const wrong = await request(`/api/agent/drafts/${draft.draftId}`, 'GET', undefined, {
    conversationId: 'token_api',
    draftToken: 'wrong-token'
  });
  assert.equal(wrong.status, 404);
});

test('candidateId经HTTP真实选择，非法ID和旧candidateIndex均不能绕过', async () => {
  const created = await request('/api/agent/drafts', 'POST', { conversationId: 'candidate_http' });
  const draft = created.data.draft;
  const auth = { conversationId: 'candidate_http', draftToken: draft.draftToken };
  const ambiguous = await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', {
    message: '帮我登记一下'
  }, auth);
  assert.equal(ambiguous.status, 200);
  assert.equal(ambiguous.data.draft.status, 'awaiting_candidate');
  const candidateId = ambiguous.data.draft.candidateUnderstandings[0].candidateId;
  assert.match(candidateId, /^[a-f0-9]{24,64}$/);

  assert.equal((await request(`/api/agent/drafts/${draft.draftId}/choose-candidate`, 'POST', {
    candidateId: 'invalid_candidate'
  }, auth)).status, 409);
  assert.equal((await request(`/api/agent/drafts/${draft.draftId}/choose-candidate`, 'POST', {
    candidateIndex: 0
  }, auth)).status, 409);

  const selected = await request(`/api/agent/drafts/${draft.draftId}/choose-candidate`, 'POST', {
    candidateId
  }, auth);
  assert.equal(selected.status, 200);
  assert.equal(selected.data.draft.status, 'awaiting_answer');
  assert.ok(selected.data.draft.planSpec);
});

test('unsupported经HTTP零候选且不能确认，可用新message重新描述', async () => {
  const before = await request('/api/state');
  const created = await request('/api/agent/drafts', 'POST', { conversationId: 'unsupported_http' });
  const draft = created.data.draft;
  const auth = { conversationId: 'unsupported_http', draftToken: draft.draftToken };
  const unsupported = await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', {
    message: '收到文件后直接打印并通知取件'
  }, auth);
  assert.equal(unsupported.status, 200);
  assert.equal(unsupported.data.draft.status, 'unsupported');
  assert.deepEqual(unsupported.data.draft.candidateUnderstandings, []);
  assert.equal(unsupported.data.draft.planSpec, null);
  const confirm = await request(`/api/agent/drafts/${draft.draftId}/confirm`, 'POST', {
    revision: unsupported.data.draft.revision,
    planHash: 'forged'
  }, auth);
  assert.equal(confirm.status, 409);
  const state = await request('/api/state');
  assert.equal(state.data.automations.length, before.data.automations.length);
  const rephrased = await request(`/api/agent/drafts/${draft.draftId}/messages`, 'POST', {
    message: '帮我收作业'
  }, auth);
  assert.equal(rephrased.status, 200);
  assert.equal(rephrased.data.draft.status, 'awaiting_answer');
  assert.equal(rephrased.data.draft.unsupportedResult, null);
});
