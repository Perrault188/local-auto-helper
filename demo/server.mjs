import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineService, loadDemoSeed } from '../engine/index.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const prototypeDir = join(root, 'prototype');
const fixturesDir = join(root, 'fixtures');
const dataDir = process.env.AUTO_HELPER_DATA_DIR || join(root, 'demo', 'local-data');
const port = Number(process.env.PORT || 4173);
const service = new EngineService({ dataDir });
const seed = await loadDemoSeed(fixturesDir);
const events = JSON.parse(await readFile(join(fixturesDir, 'demo-events.json'), 'utf8'));
let writes = Promise.resolve();

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const securityHeaders = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
};
const json = (res, status, body) => { res.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const body = async req => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('请求体超过1 MiB限制'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
};
const serial = task => { const next = writes.then(task, task); writes = next.catch(() => {}); return next; };
const fileName = value => typeof value === 'string' ? value.replaceAll('\\', '/').split('/').pop() || null : null;
const safeFileLabel = value => `模拟文件${extname(value || '') || ''}`;
const publicFile = file => file ? { name: safeFileLabel(file.name || file.sourceRef) } : null;
const publicMember = member => ({
  userId: member.userId,
  name: member.name,
  studentId: member.studentId,
  submissionStatus: member.submissionStatus,
  lastSubmittedAt: member.lastSubmittedAt,
  filePath: fileName(member.filePath),
  reminderStatus: member.reminderStatus,
  remindedAt: member.remindedAt
});
const publicAttachment = attachment => ({
  taskAttachmentId: attachment.taskAttachmentId,
  taskName: attachment.taskName,
  groupId: attachment.groupId,
  deadlineAt: attachment.deadlineAt,
  members: (attachment.members ?? []).map(publicMember),
  updatedAt: attachment.updatedAt
});
const publicActionParams = action => {
  const params = action.params ?? {};
  if (action.type === 'send_group_message_and_file') return { groupId: params.groupId, text: params.text, filePath: fileName(params.filePath) };
  if (Object.hasOwn(params, 'taskAttachmentId')) return { taskAttachmentId: params.taskAttachmentId };
  if (action.type === 'rename_received_file') return { nameTemplate: params.nameTemplate };
  if (['reply_to_sender','send_direct_message_batch'].includes(action.type)) return { text: params.text };
  return {};
};
const publicFlow = flow => ({
  schemaVersion: flow.schemaVersion,
  flowId: flow.flowId,
  name: flow.name,
  templateId: flow.templateId,
  status: flow.status,
  hook: {
    type: flow.hook.type,
    params: flow.hook.type === 'self_message'
      ? { conversationId: flow.hook.params.conversationId, keyword: flow.hook.params.keyword }
      : flow.hook.type === 'scheduled'
        ? { runAt: flow.hook.params.runAt, timezone: flow.hook.params.timezone }
        : { conversationType: flow.hook.params.conversationType, conversationId: flow.hook.params.conversationId, groupId: flow.hook.params.groupId, keyword: flow.hook.params.keyword, allowedExtensions: flow.hook.params.allowedExtensions }
  },
  actions: (flow.actions ?? []).map(action => ({ actionId: action.actionId, type: action.type, params: publicActionParams(action) })),
  taskAttachmentId: flow.taskAttachmentId,
  createdAt: flow.createdAt,
  updatedAt: flow.updatedAt,
  deletedAt: flow.deletedAt
});
const publicStep = step => ({
  actionId: step.actionId,
  actionType: step.actionType,
  status: step.status,
  startedAt: step.startedAt,
  finishedAt: step.finishedAt
});
const publicRun = run => ({
  schemaVersion: run.schemaVersion,
  runId: run.runId,
  flowId: run.flowId,
  eventId: run.eventId,
  status: run.status,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  viewedAt: run.viewedAt,
  error: run.error ? { code: run.error.code } : null,
  eventSnapshot: run.eventSnapshot ? { type: run.eventSnapshot.type } : null,
  steps: (run.steps ?? []).map(publicStep)
});
const publicConversation = (conversation, { displayLabel, latestMessage, updatedAt } = {}) => ({
  conversationId: conversation.conversationId,
  kind: conversation.kind,
  connector: conversation.connector,
  displayLabel: displayLabel ?? (conversation.kind === 'group' ? '班级群聊' : '成员私聊'),
  latestMessage: latestMessage ?? '暂无消息',
  createdAt: conversation.createdAt,
  updatedAt: updatedAt ?? conversation.updatedAt
});
const publicMessage = message => ({
  messageId: message.messageId,
  conversationId: message.conversationId,
  direction: message.direction,
  kind: message.kind,
  senderLabel: message.direction === 'inbound' ? '模拟成员' : '本地助手',
  recipientLabel: message.effectType === 'group_send' ? '模拟群聊' : '模拟成员',
  text: message.text,
  file: publicFile(message.file),
  occurredAt: message.occurredAt,
  deliveryStatus: message.deliveryStatus
});
const publicAdapterSnapshot = value => ({
  files: (value.files ?? []).map(file => ({ name: safeFileLabel(file.name), path: safeFileLabel(file.path || file.name), sourcePath: file.sourcePath ? safeFileLabel(file.sourcePath) : null })),
  groupMessages: (value.groupMessages ?? []).map(message => ({ messageId: message.messageId, groupId: message.groupId, text: message.text, filePath: safeFileLabel(message.filePath) })),
  directMessages: (value.directMessages ?? []).map(message => ({ messageId: message.messageId, recipientLabel: '模拟成员', text: message.text })),
  replies: (value.replies ?? []).map(message => ({ messageId: message.messageId, recipientLabel: '模拟成员', text: message.text })),
  timerEvents: (value.timerEvents ?? []).map(event => ({ eventId: event.eventId, type: event.type, occurredAt: event.occurredAt }))
});

async function publicConversationList() {
  const conversations = (await service.conversations.list()).filter(item => item.kind !== 'assistant');
  const attachments = await service.attachments.list();
  const memberNames = new Map(attachments.flatMap(attachment => (attachment.members ?? []).map(member => [member.userId, member.name])));
  const items = await Promise.all(conversations.map(async conversation => {
    const messages = await service.messageLogs.listByConversation(conversation.conversationId);
    const latest = messages.at(-1) ?? null;
    const personRef = latest?.direction === 'inbound' ? latest.senderRef : latest?.recipientKey;
    const displayLabel = conversation.kind === 'group' ? '班级群聊' : (memberNames.get(personRef) ?? '成员私聊');
    const latestMessage = latest?.text?.trim() || (latest?.file ? `[文件] ${safeFileLabel(latest.file.name || latest.file.sourceRef)}` : '暂无消息');
    return publicConversation(conversation, { displayLabel, latestMessage, updatedAt: latest?.occurredAt ?? conversation.updatedAt });
  }));
  return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.conversationId.localeCompare(b.conversationId));
}

async function snapshot() {
  const flows = await service.flows.list();
  const runs = (await service.runs.list()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    flows: flows.map(publicFlow),
    summaries: await service.listFlowSummaries(),
    runs: runs.map(publicRun),
    attachments: (await service.attachments.list()).map(publicAttachment),
    // P1-A：任务级聚合视图（前端「我的自动帮办」按任务而非 Flow 渲染）。
    automations: await service.listAutomationViews(),
    adapters: publicAdapterSnapshot(service.adapters.snapshot()),
    unseenFailureCount: await service.unseenFailureCount(),
    demo: { account: { name: seed.account?.name ?? '用户' }, group: { groupId: seed.group?.groupId, name: seed.group?.name }, events: events.map(({ eventId, type, occurredAt }) => ({ eventId, type, occurredAt })) }
  };
}

// Mock文件状态仍不持久化；群消息、私信和回执已由持久MessageLog提供权威投影。
// 用户已确认的发布输入路径属于持久化任务配置，服务重启时从附件恢复其可见性，确保尚未开始的定时发布可继续执行。
async function restoreConfiguredMockInputs() {
  for (const attachment of await service.attachments.list()) {
    const path = attachment.sourceFilePath;
    if (!path) continue;
    service.adapters.receiveFile({
      fileId: `notice_${attachment.taskAttachmentId}`,
      name: path.split('/').pop() || '通知',
      path
    });
  }
}

async function dispatchMockDirectFile(automationId, input) {
  const automation = await service.automations.get(automationId);
  if (!automation || automation.status !== 'enabled') throw Object.assign(new Error('找不到可收取文件的任务'), { status: 404 });
  const conversation = await service.ensureConversation({ kind: 'direct', connector: 'mock', externalKey: `member:${input.senderUserId}` });
  const event = {
    schemaVersion: '0.4-rc1', eventId: input.eventId, type: 'file_received', occurredAt: input.occurredAt,
    payload: {
      messageId: input.messageId,
      conversationId: conversation.conversationId,
      conversationType: 'direct',
      senderUserId: input.senderUserId,
      text: input.text ?? null,
      file: { fileId: input.file?.fileId, name: input.file?.name, sourceRef: input.file?.sourceRef }
    }
  };
  const runs = await service.dispatch(event, { trustedRoute: { automationId, source: 'mock_demo_private_file' } });
  let noActionReason = null;
  if (runs.length === 0) {
    const collectFlow = (await Promise.all((automation.flowIds ?? []).map(flowId => service.flows.get(flowId)))).find(flow => flow?.templateId === 'homework_collect_v1');
    const attachment = collectFlow ? await service.attachments.get(collectFlow.taskAttachmentId) : null;
    const allowed = collectFlow?.hook?.params?.allowedExtensions ?? [];
    if (!attachment?.members?.some(member => member.userId === input.senderUserId)) noActionReason = '人员未匹配当前任务';
    else if (!allowed.some(value => value.toLowerCase() === extname(input.file?.name ?? '').toLowerCase())) noActionReason = '文件类型不符合任务收取规则';
    else noActionReason = '未匹配到可执行的收取条件';
  }
  return { runs, noActionReason };
}

async function runSelectedMockCapability(automationId, capability, variant = 'success') {
  const automation = await service.automations.get(automationId);
  if (!automation) throw Object.assign(new Error('找不到该任务'), { status: 404 });
  if (automation.status !== 'enabled') throw Object.assign(new Error('请先恢复这个自动帮办'), { status: 409 });
  const flows = await Promise.all((automation.flowIds ?? []).map(flowId => service.flows.get(flowId)));
  const templateId = { publish: 'homework_publish_v1', collect: 'homework_collect_v1', remind: 'homework_remind_v1' }[capability];
  const flow = flows.find(item => item?.templateId === templateId && item.status === 'enabled');
  if (!flow) throw Object.assign(new Error('当前任务没有可运行的对应能力'), { status: 404 });
  const eventSuffix = randomUUID();

  if (capability === 'collect') {
    const attachment = await service.attachments.get(flow.taskAttachmentId);
    const submitted = attachment?.members?.filter(member => member.submissionStatus === 'submitted') ?? [];
    const pending = attachment?.members?.filter(member => member.submissionStatus === 'unsubmitted') ?? [];
    const member = variant === 'mapping-fail'
      ? { userId: '6999999999', name: '未匹配成员', studentId: 'UNKNOWN' }
      : variant === 'duplicate'
        ? submitted[0]
        : pending[0];
    if (!member) throw Object.assign(new Error(variant === 'duplicate' ? '还没有可重复提交的成员' : '当前没有待提交成员'), { status: 409 });
    const extension = flow.hook.params.allowedExtensions?.[0] ?? '.docx';
    const direct = await dispatchMockDirectFile(automationId, {
      eventId: `event_mock_collect_${eventSuffix}`,
      messageId: `message_mock_collect_${eventSuffix}`,
      senderUserId: member.userId,
      text: `${attachment.taskName}提交`,
      file: {
        fileId: `file_mock_collect_${eventSuffix}`,
        name: `${member.studentId}_${member.name}${extension}`,
        sourceRef: `mock-demo:${eventSuffix}${extension}`
      },
      occurredAt: new Date().toISOString()
    });
    return { run: direct.runs[0] ?? null, noActionReason: direct.noActionReason };
  }

  if (capability === 'remind' && variant === 'no-action') {
    const collectFlow = flows.find(item => item?.templateId === 'homework_collect_v1' && item.status === 'enabled');
    const attachment = await service.attachments.get(flow.taskAttachmentId);
    if (!collectFlow || !attachment) throw Object.assign(new Error('当前任务没有可补齐提交的收取能力'), { status: 409 });
    const extension = collectFlow.hook.params.allowedExtensions?.[0] ?? '.docx';
    const pending = attachment.members.filter(member => member.submissionStatus === 'unsubmitted');
    for (const member of pending) {
      const submissionSuffix = randomUUID();
      await dispatchMockDirectFile(automationId, {
        eventId: `event_mock_complete_${submissionSuffix}`,
        messageId: `message_mock_complete_${submissionSuffix}`,
        senderUserId: member.userId,
        text: `${attachment.taskName}提交`,
        file: {
          fileId: `file_mock_complete_${submissionSuffix}`,
          name: `${member.studentId}_${member.name}${extension}`,
          sourceRef: `mock-demo:${submissionSuffix}${extension}`
        },
        occurredAt: new Date().toISOString()
      });
    }
  }

  const event = flow.hook.type === 'self_message'
    ? {
        schemaVersion: '0.3-rc1', eventId: `event_mock_publish_${eventSuffix}`, type: 'self_message_sent', occurredAt: new Date().toISOString(),
        payload: { messageId: `message_mock_publish_${eventSuffix}`, conversationId: flow.hook.params.conversationId, senderUserId: '9000012345', text: flow.hook.params.keyword }
      }
    : {
        schemaVersion: '0.3-rc1', eventId: `event_mock_timer_${eventSuffix}`, type: 'timer_fired', occurredAt: flow.hook.params.runAt,
        payload: { scheduledFor: flow.hook.params.runAt, timezone: flow.hook.params.timezone }
      };
  const runs = await service.dispatch(event, { allowedFlowIds: [flow.flowId] });
  return { run: runs[0] ?? null, noActionReason: null };
}

async function api(req, res, url) {
  const publicDraft = draft => {
    const copy = structuredClone(draft);
    delete copy.draftTokenHash; delete copy.idempotencyKey;
    return copy;
  };
  const agentAuth = () => {
    const conversationId = req.headers['x-agent-conversation-id'];
    const draftToken = req.headers['x-agent-draft-token'];
    if (typeof conversationId !== 'string' || typeof draftToken !== 'string') throw Object.assign(new Error('缺少Agent草稿访问凭据'), { status: 401 });
    return { conversationId, draftToken };
  };
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await snapshot());
  const downloadMatch = url.pathname.match(/^\/api\/downloads\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'GET' && downloadMatch) {
    const archive = await serial(() => service.consumeAutomationArchive(downloadMatch[1]));
    res.writeHead(200, {
      ...securityHeaders,
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(archive.fileName)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(archive.content);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/conversations') {
    return json(res, 200, { items: await publicConversationList() });
  }
  const conversationMessagesMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (req.method === 'GET' && conversationMessagesMatch) {
    const conversationId = decodeURIComponent(conversationMessagesMatch[1]);
    if (!conversationId.startsWith('conv_')) throw Object.assign(new Error('找不到业务会话'), { status: 404 });
    const conversation = await service.conversations.get(conversationId);
    if (!conversation || conversation.kind === 'assistant') throw Object.assign(new Error('找不到业务会话'), { status: 404 });
    const items = (await service.messageLogs.listByConversation(conversationId)).map(publicMessage);
    return json(res, 200, { items });
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/provider-status') return json(res, 200, service.agent.getProviderStatus());
  if (req.method === 'POST' && url.pathname === '/api/agent/drafts') return json(res, 201, { draft: publicDraft(await serial(() => body(req).then(input => service.agent.create(input)))) });
  const agentDraftMatch = url.pathname.match(/^\/api\/agent\/drafts\/([^/]+)$/);
  if (req.method === 'GET' && agentDraftMatch) {
    const draft = await service.agent.get(agentDraftMatch[1], agentAuth());
    if (!draft) throw Object.assign(new Error('找不到草稿'), { status: 404 });
    return json(res, 200, { draft: publicDraft(draft) });
  }
  const agentMessageMatch = url.pathname.match(/^\/api\/agent\/drafts\/([^/]+)\/messages$/);
  if (req.method === 'POST' && agentMessageMatch) return json(res, 200, { draft: publicDraft(await serial(async () => {
    const input = await body(req);
    if (Object.hasOwn(input, 'facts')) throw Object.assign(new Error('facts已停用，请使用受控trustedContext'), { status: 400 });
    if (Object.hasOwn(input, 'trustedContext')) throw Object.assign(new Error('HTTP不接受trustedContext，请使用contextOptionIds'), { status: 400 });
    const auth = agentAuth();
    const selectedContext = input.contextOptionIds ? await service.agent.resolveContextOptions(agentMessageMatch[1], auth, input.contextOptionIds, { demoSeed: seed }) : {};
    delete input.contextOptionIds;
    return service.agent.message(agentMessageMatch[1], { ...input, trustedContext: selectedContext, ...auth });
  })) });
  const agentChooseMatch = url.pathname.match(/^\/api\/agent\/drafts\/([^/]+)\/choose-candidate$/);
  if (req.method === 'POST' && agentChooseMatch) return json(res, 200, { draft: publicDraft(await serial(async () => {
    const input = await body(req); const auth = agentAuth();
    const trustedContext = input.contextOptionIds ? await service.agent.resolveContextOptions(agentChooseMatch[1], auth, input.contextOptionIds, { demoSeed: seed }) : {};
    return service.agent.chooseCandidate(agentChooseMatch[1], { candidateId: input.candidateId, trustedContext, ...auth });
  })) });
  const agentBackMatch = url.pathname.match(/^\/api\/agent\/drafts\/([^/]+)\/back$/);
  if (req.method === 'POST' && agentBackMatch) return json(res, 200, { draft: publicDraft(await serial(() => service.agent.back(agentBackMatch[1], agentAuth()))) });
  const agentReviseMatch = url.pathname.match(/^\/api\/agent\/drafts\/([^/]+)\/revise$/);
  if (req.method === 'POST' && agentReviseMatch) return json(res, 200, { draft: publicDraft(await serial(async () => service.agent.revise(agentReviseMatch[1], { ...await body(req), ...agentAuth() }))) });
  const agentOptionsMatch = url.pathname.match(/^\/api\/agent\/drafts\/([^/]+)\/context-options$/);
  if (req.method === 'GET' && agentOptionsMatch) {
    const options = await service.agent.contextOptions(agentOptionsMatch[1], agentAuth(), { demoSeed: seed });
    return json(res, 200, { options: options.map(({ optionId, field, label, source }) => ({ optionId, field, label, source })) });
  }
  const agentCustomContextMatch = url.pathname.match(/^\/api\/agent\/drafts\/([^/]+)\/custom-context$/);
  if (req.method === 'POST' && agentCustomContextMatch) return json(res, 200, { draft: publicDraft(await serial(async () => {
    const input = await body(req);
    if (!input || Object.keys(input).some(key => !['field', 'value'].includes(key))) throw Object.assign(new Error('自定义内容字段非法'), { status: 400 });
    const auth = agentAuth();
    const trustedContext = await service.agent.resolveCustomContext(agentCustomContextMatch[1], auth, input);
    return service.agent.message(agentCustomContextMatch[1], { trustedContext, ...auth });
  })) });
  const agentConfirmMatch = url.pathname.match(/^\/api\/agent\/drafts\/([^/]+)\/confirm$/);
  if (req.method === 'POST' && agentConfirmMatch) return json(res, 200, await serial(async () => {
    const result = await service.agent.confirm(agentConfirmMatch[1], { ...await body(req), ...agentAuth() });
    return { ...result, draft: publicDraft(result.draft) };
  }));
  const agentCancelMatch = url.pathname.match(/^\/api\/agent\/drafts\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && agentCancelMatch) return json(res, 200, { draft: publicDraft(await serial(() => service.agent.cancel(agentCancelMatch[1], agentAuth()))) });
  // 从零创建真实任务：请求体即创建契约 input。成功返回 { result, state }（result 为引擎返回值，state 为最新 snapshot 供前端刷新列表）；
  // 校验失败（CreationValidationError）返回非 2xx，body 为 { errors:[...] }，透传 field/code/message/row/index，与 prototype/adapter.js 期望一致。
  if (req.method === 'POST' && url.pathname === '/api/automation-tasks') return json(res, 200, await serial(async () => {
    const input = await body(req);
    const result = await service.createAutomationTask(input);
    // Demo 环境接线：把该任务的通知附件预置进 Mock 文件系统，使新任务「开箱即可发布」
    //（真实环境该文件本就存在于本地磁盘）。只在校验通过、创建成功后执行，失败不产生任何副作用。
    if (input.noticeFilePath) service.adapters.receiveFile({ fileId: `notice_${result.taskAttachmentId}`, name: extname(input.noticeFilePath) ? input.noticeFilePath.split('/').pop() : '通知', path: input.noticeFilePath });
    return { result, state: await snapshot() };
  }));
  const mockDirectMatch = url.pathname.match(/^\/api\/automation-tasks\/([^/]+)\/mock-direct-file$/);
  if (req.method === 'POST' && mockDirectMatch) return json(res, 200, await serial(async () => {
    const automationId = mockDirectMatch[1];
    const input = await body(req);
    const result = await dispatchMockDirectFile(automationId, input);
    return { runs: result.runs.map(publicRun), noActionReason: result.noActionReason, state: await snapshot() };
  }));
  const mockRunMatch = url.pathname.match(/^\/api\/automation-tasks\/([^/]+)\/mock-run$/);
  if (req.method === 'POST' && mockRunMatch) return json(res, 200, await serial(async () => {
    const input = await body(req);
    const result = await runSelectedMockCapability(mockRunMatch[1], input.capability, input.variant);
    return { run: result.run ? publicRun(result.run) : null, noActionReason: result.noActionReason, state: await snapshot() };
  }));
  const evidenceMatch = url.pathname.match(/^\/api\/automation-tasks\/([^/]+)\/evidence$/);
  if (req.method === 'GET' && evidenceMatch) {
    const evidence = await service.getAutomationEvidence(evidenceMatch[1]);
    if (!evidence) throw Object.assign(new Error('找不到该任务'), { status: 404 });
    return json(res, 200, evidence);
  }
  const archiveMatch = url.pathname.match(/^\/api\/automation-tasks\/([^/]+)\/archive$/);
  if (req.method === 'POST' && archiveMatch) {
    const archive = await serial(() => service.createAutomationArchive(archiveMatch[1]));
    if (!archive) throw Object.assign(new Error('找不到该任务'), { status: 404 });
    return json(res, 201, archive);
  }
  const capabilityMatch = url.pathname.match(/^\/api\/automation-tasks\/([^/]+)\/capabilities$/);
  if (req.method === 'POST' && capabilityMatch) return json(res, 200, await serial(async () => {
    const input = await body(req);
    const view = await service.addAutomationCapability(capabilityMatch[1], input.capability, input);
    return { view, state: await snapshot() };
  }));
  const deadlineCheckMatch = url.pathname.match(/^\/api\/automation-tasks\/([^/]+)\/deadline-check$/);
  if (req.method === 'POST' && deadlineCheckMatch) return json(res, 200, await serial(async () => ({
    check: await service.inspectAutomationDeadline(deadlineCheckMatch[1]),
    state: await snapshot()
  })));
  const remindNowMatch = url.pathname.match(/^\/api\/automation-tasks\/([^/]+)\/remind-now$/);
  if (req.method === 'POST' && remindNowMatch) return json(res, 200, await serial(async () => {
    const result = await service.sendAutomationReminderNow(remindNowMatch[1], await body(req));
    return { ...result, run: result.run ? publicRun(result.run) : null, state: await snapshot() };
  }));
  // P1-A 任务级：详情聚合视图。
  const viewMatch = url.pathname.match(/^\/api\/automation-tasks\/([^/]+)$/);
  if (req.method === 'GET' && viewMatch) return json(res, 200, await serial(async () => { const view = await service.getAutomationView(viewMatch[1]); if (!view) throw Object.assign(new Error('找不到该任务'), { status: 404 }); return { view }; }));
  // P1-A 任务级：状态变更（启用/暂停/恢复/结束/删除，联动名下 Flow）。
  const autoStatusMatch = url.pathname.match(/^\/api\/automation-tasks\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && autoStatusMatch) return json(res, 200, await serial(async () => { const input = await body(req); await service.setAutomationStatus(autoStatusMatch[1], input.status); return { view: await service.getAutomationView(autoStatusMatch[1]), state: await snapshot() }; }));
  // P1-A 任务级：编辑字段（改名/截止/文案/名单/收取规则/通知文件）。校验失败透传结构化 errors。
  if (req.method === 'PATCH' && viewMatch) return json(res, 200, await serial(async () => { const patch = await body(req); const view = await service.editAutomationTask(viewMatch[1], patch); return { view, state: await snapshot() }; }));
  if (req.method === 'POST' && url.pathname === '/api/reset') return json(res, 200, await serial(async () => { await service.resetDemo(seed); return snapshot(); }));
  if (req.method === 'POST' && url.pathname === '/api/flows') return json(res, 200, await serial(async () => { await service.saveFlow(await body(req)); return snapshot(); }));
  const statusMatch = url.pathname.match(/^\/api\/flows\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && statusMatch) return json(res, 200, await serial(async () => { const input = await body(req); const flow = await service.setFlowStatus(statusMatch[1], input.status); if (!flow) throw Object.assign(new Error('找不到自动帮办'), { status: 404 }); return snapshot(); }));
  const eventMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/dispatch$/);
  if (req.method === 'POST' && eventMatch) return json(res, 200, await serial(async () => { const event = events.find(item => item.eventId === eventMatch[1]); if (!event) throw Object.assign(new Error('找不到演示事件'), { status: 404 }); const runs = await service.dispatch(structuredClone(event)); return { runs: runs.map(publicRun), state: await snapshot() }; }));
  if (req.method === 'POST' && url.pathname === '/api/events/dispatch') return json(res, 200, await serial(async () => { const runs = await service.dispatch(await body(req)); return { runs: runs.map(publicRun), state: await snapshot() }; }));
  const viewedMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/viewed$/);
  if (req.method === 'POST' && viewedMatch) return json(res, 200, await serial(async () => { const run = await service.markRunViewed(viewedMatch[1]); if (!run) throw Object.assign(new Error('找不到运行记录'), { status: 404 }); return snapshot(); }));
  return false;
}

async function staticFile(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const target = normalize(join(prototypeDir, relative));
  if (!target.startsWith(`${prototypeDir}/`)) return json(res, 403, { error: '禁止访问' });
  const info = await stat(target);
  if (!info.isFile()) throw Object.assign(new Error('页面不存在'), { status: 404 });
  res.writeHead(200, { ...securityHeaders, 'content-type': types[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(await readFile(target));
}

export async function createDemoServer() {
  // 播种策略 B（启动即空）：启动【不】自动播种 demo 种子，全新库启动即空，
  // 只保留用户通过 POST /api/automation-tasks 创建的真实任务。默认 SQLite 后端持久化，数据重启留存。
  // 班委演示数据改为「按需加载」：想看主演示时显式调 POST /api/reset -> service.resetDemo(seed)
  //（技术视图的「恢复主演示初始状态」按钮即调它）。
  await service.migrateMessageStore();
  await service.recoverPendingWork();
  await restoreConfiguredMockInputs();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) { const handled = await api(req, res, url); if (handled === false) json(res, 404, { error: '接口不存在' }); }
      else await staticFile(res, url.pathname);
    } catch (error) {
      // 创建校验失败：透传结构化 errors（field/code/message/row/index），前端就地高亮。
      if (Array.isArray(error.errors)) return json(res, 422, { errors: error.errors });
      json(res, error.status || 400, { error: error.message });
    }
  });
  // 调度执行与 HTTP 写操作共用同一串行队列，避免状态变更和到点扫描交错。
  // 测试可显式关闭真实时钟，改用 EngineService.tickScheduler 做确定性验证。
  if (process.env.AUTO_HELPER_SCHEDULER_DISABLED !== '1') service.startScheduler({ enqueue: serial });
  server.on('close', () => service.stopScheduler());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createDemoServer();
  server.listen(port, '127.0.0.1', () => console.log(`本地助手自动帮办Demo已启动 http://127.0.0.1:${port}`));
}
