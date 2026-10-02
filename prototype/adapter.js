import { store, clearBrowserState } from './store.js';

const VERSION = '0.3-rc1';
let state = { flows: [], summaries: [], runs: [], attachments: [], adapters: { files: [], groupMessages: [], directMessages: [], replies: [], timerEvents: [] }, unseenFailureCount: 0, demo: {} };
const runtime = { conversations: [], messages: new Map(), evidence: new Map() };
const clone = value => structuredClone(value);

async function request(path, options) {
  const method = options?.method || 'GET';
  const headers = { 'content-type': 'application/json', ...(options?.headers || {}) };
  if (method !== 'GET' && state.csrfToken) headers['x-local-helper-csrf'] = state.csrfToken;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '本地服务请求失败');
  state = data.state || data;
  syncRuntimeContext();
  window.dispatchEvent(new CustomEvent('engine-state-changed'));
  return data;
}

class AgentRequestError extends Error {
  constructor(message, status) { super(message); this.name = 'AgentRequestError'; this.status = status; }
}
async function agentRequest(path, { method = 'GET', body, auth } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (method !== 'GET' && state.csrfToken) headers['x-local-helper-csrf'] = state.csrfToken;
  if (auth) {
    headers['x-agent-conversation-id'] = auth.conversationId;
    headers['x-agent-draft-token'] = auth.draftToken;
  }
  let response;
  try { response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new AgentRequestError('本地理解服务暂时不可用，请稍后重试', 0); }
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new AgentRequestError(data.error || '设置请求失败', response.status);
  return data;
}
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
async function browserPlanHash(plan) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable(plan))));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function syncRuntimeContext() {
  const groups = new Map((store.get().groups || []).map(group => [group.groupId, group]));
  if (state.demo?.group?.groupId) groups.set(state.demo.group.groupId, state.demo.group);
  for (const attachment of state.attachments || []) if (attachment.groupId && !groups.has(attachment.groupId)) groups.set(attachment.groupId, { groupId: attachment.groupId, name: attachment.groupName || attachment.groupId });
  store.silent(current => {
    current.groups = [...groups.values()];
    if (!current.draft.groupId) current.draft.groupId = state.attachments?.[0]?.groupId || state.demo?.group?.groupId || current.groups[0]?.groupId || '';
  });
}

// ============================================================================
// P0-C 前端侧：从零创建真实任务
//
// 按引擎createAutomationTask契约构造入参并处理CreationValidationError。
// 默认调用POST /api/automation-tasks真实落库。仅在前端被单独静态预览时，
// 使用本地校验器返回同结构错误，不伪造创建成功。
// ============================================================================

// 与引擎 CreationValidationError 结构一致的前端错误对象（name/code/errors）。
export class CreationValidationError extends Error {
  constructor(errors) {
    super(`创建参数校验失败，共 ${errors.length} 项`);
    this.name = 'CreationValidationError';
    this.code = 'CREATION_INPUT_INVALID';
    this.errors = errors;
  }
}

// —— 本地占位校验器：严格复刻契约（第2/4节）的字段、默认值与校验规则。 ——
// 仅在真实创建端点尚未接通时使用，保证前端错误提示逻辑现在即可开发与验证；
// 真实创建结果仍以引擎返回为准，占位器不伪造成功产物（只做校验前置）。
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const STUDENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const EXTENSION_PATTERN = /^\.[A-Za-z0-9]+$/;
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/;
const ALLOWED_PLACEHOLDERS = /{(?:studentId|name|originalExtension)}/g;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const isRfc3339 = value => typeof value === 'string' && RFC3339.test(value) && !Number.isNaN(Date.parse(value));

function validateCreateInputLocally(input) {
  const errors = [];
  const push = (field, code, message, extra = {}) => errors.push({ field, code, message, ...extra });

  if (!isNonEmptyString(input.taskName)) push('taskName', 'REQUIRED', '任务名不能为空');
  else if (input.taskName.length > 80) push('taskName', 'TOO_LONG', '任务名不能超过 80 字');

  if (!isNonEmptyString(input.groupId)) push('groupId', 'REQUIRED', '目标群不能为空');
  if (!isNonEmptyString(input.publishText)) push('publishText', 'REQUIRED', '发布说明不能为空');
  if (!isNonEmptyString(input.noticeFilePath)) push('noticeFilePath', 'REQUIRED', '通知附件引用不能为空');

  if (!isRfc3339(input.publishAt)) push('publishAt', 'FORMAT', '请选择明确的发布时间');
  if (!isRfc3339(input.deadlineAt)) push('deadlineAt', 'FORMAT', '请选择明确的截止时间');
  if (isRfc3339(input.publishAt) && isRfc3339(input.deadlineAt) && Date.parse(input.deadlineAt) <= Date.parse(input.publishAt)) push('deadlineAt', 'RANGE', '截止时间必须晚于发布时间');

  const rule = input.collectRule ?? {};
  const extensions = rule.allowedExtensions;
  if (!Array.isArray(extensions) || extensions.length === 0) push('collectRule.allowedExtensions', 'REQUIRED', '至少声明一个允许的文件扩展名');
  else {
    if (new Set(extensions.map(e => String(e).toLowerCase())).size !== extensions.length) push('collectRule.allowedExtensions', 'DUPLICATE', '扩展名白名单不能重复');
    extensions.forEach((ext, index) => { if (!EXTENSION_PATTERN.test(String(ext))) push('collectRule.allowedExtensions', 'FORMAT', `扩展名格式非法：${ext}（应形如 .docx）`, { index }); });
  }
  if (rule.keyword !== undefined && rule.keyword !== null && !isNonEmptyString(rule.keyword)) push('collectRule.keyword', 'FORMAT', '收取关键词若填写则不能为空白');

  const nameTemplate = input.nameTemplate ?? '{studentId}_{name}{originalExtension}';
  if (!isNonEmptyString(nameTemplate)) push('nameTemplate', 'REQUIRED', '命名模板不能为空');
  else {
    const stripped = nameTemplate.replaceAll(ALLOWED_PLACEHOLDERS, '');
    if (stripped.includes('{') || stripped.includes('}')) push('nameTemplate', 'PLACEHOLDER', '命名模板含未声明占位符，仅支持 {studentId} {name} {originalExtension}');
    if (ILLEGAL_NAME_CHARS.test(stripped)) push('nameTemplate', 'ILLEGAL_CHAR', '命名模板禁止包含路径分隔符或非法字符 \\ / : * ? " < > |');
  }

  if (!isNonEmptyString(input.remindText)) push('remindText', 'REQUIRED', '催交文案不能为空');
  if (input.remindAt !== undefined && input.remindAt !== null && !isRfc3339(input.remindAt)) push('remindAt', 'FORMAT', '请选择明确的提醒时间');

  const roster = input.roster;
  if (!Array.isArray(roster) || roster.length === 0) push('roster', 'REQUIRED', '名单至少包含一名成员');
  else {
    const seen = new Map();
    roster.forEach((member, index) => {
      const row = index + 1;
      const m = member ?? {};
      if (!isNonEmptyString(m.userId)) push('roster', 'USER_ID_REQUIRED', `第 ${row} 行用户ID不能为空`, { row });
      else if (!USER_ID_PATTERN.test(String(m.userId))) push('roster', 'USER_ID_FORMAT', `第 ${row} 行用户ID格式非法 ${m.userId}`, { row });
      else if (seen.has(m.userId)) push('roster', 'USER_ID_DUPLICATE', `第 ${row} 行用户ID与第 ${seen.get(m.userId)} 行重复 ${m.userId}`, { row });
      else seen.set(m.userId, row);
      if (!isNonEmptyString(m.name)) push('roster', 'NAME_REQUIRED', `第 ${row} 行姓名不能为空`, { row });
      if (!isNonEmptyString(m.studentId)) push('roster', 'STUDENT_ID_REQUIRED', `第 ${row} 行学号不能为空`, { row });
      else if (!STUDENT_ID_PATTERN.test(String(m.studentId))) push('roster', 'STUDENT_ID_FORMAT', `第 ${row} 行学号格式非法：${m.studentId}`, { row });
    });
  }

  if (errors.length > 0) throw new CreationValidationError(errors);
}

// 尝试真实创建端点；返回 { ok, status, data }。区分「端点未接通」与「校验失败」。
async function tryCreateEndpoint(input) {
  let response;
  try {
    response = await fetch('/api/automation-tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-local-helper-csrf': state.csrfToken }, body: JSON.stringify(input) });
  } catch {
    return { wired: false };
  }
  if (response.status === 404) return { wired: false };
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  // 接口不存在的兜底：demo server 对未知 /api/ 返回 404 { error:'接口不存在' }
  if (!response.ok && data && data.error === '接口不存在') return { wired: false };
  return { wired: true, ok: response.ok, status: response.status, data };
}

// 对话式创建时的默认名单（0727 约束：不让用户填一堆字段，名单用演示默认，真实场景由后续导入）。
function demoRoster() {
  return [
    { userId: '2000012345', name: '测试成员甲', studentId: '20240101' },
    { userId: '2000012346', name: '测试成员乙', studentId: '20240102' }
  ];
}

const specs = {
  publish: { flowId: 'flow_publish_demo', templateId: 'homework_publish_v1', name: '发布本周任务通知' },
  collect: { flowId: 'flow_collect_demo', templateId: 'homework_collect_v1', name: '收到作业文件后匹配、改名、登记并回复' },
  remind: { flowId: 'flow_remind_demo', templateId: 'homework_remind_v1', name: '周五18点提醒未交作业的同学' }
};

function makeFlow(kind, status = 'enabled') {
  const draft = store.get().draft;
  const spec = specs[kind];
  const current = state.flows.find(flow => flow.flowId === spec.flowId);
  const timestamp = new Date().toISOString();
  const base = { schemaVersion: VERSION, ...spec, status, taskAttachmentId: 'task_se_week03_demo', createdAt: current?.createdAt || timestamp, updatedAt: timestamp, deletedAt: null };
  if (kind === 'publish') return { ...base, hook: draft.triggerMode === 'scheduled' ? { type: 'scheduled', params: { runAt: draft.publishAt, timezone: 'Asia/Shanghai' } } : { type: 'self_message', params: { conversationId: 'assistant_main', keyword: draft.keyword.trim() } }, actions: [{ actionId: 'action_init_task', type: 'initialize_task_attachment', params: { taskAttachmentId: base.taskAttachmentId } }, { actionId: 'action_send_homework', type: 'send_group_message_and_file', params: { groupId: draft.groupId, text: draft.notice, filePath: draft.filePath } }] };
  if (kind === 'collect') return { ...base, hook: { type: 'group_file_received', params: { groupId: draft.groupId, keyword: draft.fileKeyword.trim(), allowedExtensions: draft.allowedExtensions } }, actions: [{ actionId: 'action_match_person', type: 'match_person', params: { taskAttachmentId: base.taskAttachmentId } }, { actionId: 'action_rename_file', type: 'rename_received_file', params: { nameTemplate: draft.nameTemplate } }, { actionId: 'action_mark_submitted', type: 'mark_submission', params: { taskAttachmentId: base.taskAttachmentId } }, { actionId: 'action_reply_received', type: 'reply_to_sender', params: { text: draft.replyText } }] };
  return { ...base, hook: { type: 'scheduled', params: { runAt: draft.deadlineAt, timezone: 'Asia/Shanghai' } }, actions: [{ actionId: 'action_read_unsubmitted', type: 'read_unsubmitted', params: { taskAttachmentId: base.taskAttachmentId } }, { actionId: 'action_build_recipients', type: 'build_recipient_list', params: {} }, { actionId: 'action_send_reminder', type: 'send_direct_message_batch', params: { text: draft.reminderText } }] };
}

const statusText = { enabled: '已开启', disabled: '已停用', draft: '暂未启用', deleted: '已删除' };
const runText = { succeeded: '运行成功', succeeded_no_action: '成功但无动作', failed: '运行失败', running: '运行中' };
const groupName = id => state.demo.group?.groupId === id ? state.demo.group.name : id;
function describe(flow) {
  if (flow.templateId === 'homework_publish_v1') return flow.hook.type === 'self_message' ? `当我发出「${flow.hook.params.keyword}」时，先建立本次作业记录，再向${groupName(flow.actions[1].params.groupId)}发送通知和文件。` : '到设定时间时，先建立本次作业记录，再发送通知和文件。';
  if (flow.templateId === 'homework_collect_v1') return `${groupName(flow.hook.params.groupId)}收到符合规则的文件后，确认提交人，改名并登记，完成后回复发送人。`;
  return '周五18:00，从本次作业记录中找出未交同学，并向他们发送同一段提醒。';
}
function flowView(flow) {
  const summary = state.summaries.find(item => item.flowId === flow.flowId) || {};
  return { ...flow, ...summary, statusText: statusText[flow.status], lastRunText: summary.lastRunStatus ? runText[summary.lastRunStatus] : '等待第一次运行', summary: describe(flow) };
}

export const adapter = {
  async init() { await request('/api/state'); await this.loadConversations(); },
  async loadConversations() {
    const response = await fetch('/api/conversations');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '会话加载失败');
    runtime.conversations = data.items || [];
    window.dispatchEvent(new CustomEvent('engine-state-changed'));
    return runtime.conversations;
  },
  conversations() { return clone(runtime.conversations); },
  async loadConversationMessages(conversationId) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '消息加载失败');
    runtime.messages.set(conversationId, data.items || []);
    window.dispatchEvent(new CustomEvent('engine-state-changed'));
    return data.items || [];
  },
  conversationMessages(conversationId) { return clone(runtime.messages.get(conversationId) || []); },
  async loadEvidence(automationId) {
    const response = await fetch(`/api/automation-tasks/${encodeURIComponent(automationId)}/evidence`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '任务汇报加载失败');
    runtime.evidence.set(automationId, data);
    window.dispatchEvent(new CustomEvent('engine-state-changed'));
    return data;
  },
  evidence(automationId) { return clone(runtime.evidence.get(automationId) || null); },
  async createArchive(automationId) {
    const response = await fetch(`/api/automation-tasks/${encodeURIComponent(automationId)}/archive`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-local-helper-csrf': state.csrfToken }, body: '{}' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'ZIP生成失败');
    return data;
  },
  async createAgentDraft(conversationId) {
    return (await agentRequest('/api/agent/drafts', { method: 'POST', body: { conversationId } })).draft;
  },
  async messageAgentDraft(draftId, payload, auth) {
    return (await agentRequest(`/api/agent/drafts/${encodeURIComponent(draftId)}/messages`, { method: 'POST', body: payload, auth })).draft;
  },
  async chooseAgentCandidate(draftId, candidateId, auth) {
    return (await agentRequest(`/api/agent/drafts/${encodeURIComponent(draftId)}/choose-candidate`, { method: 'POST', body: { candidateId }, auth })).draft;
  },
  async backAgentDraft(draftId, auth) {
    return (await agentRequest(`/api/agent/drafts/${encodeURIComponent(draftId)}/back`, { method: 'POST', body: {}, auth })).draft;
  },
  async reviseAgentDraft(draftId, field, auth) {
    return (await agentRequest(`/api/agent/drafts/${encodeURIComponent(draftId)}/revise`, { method: 'POST', body: { field }, auth })).draft;
  },
  async agentContextOptions(draftId, auth) {
    return (await agentRequest(`/api/agent/drafts/${encodeURIComponent(draftId)}/context-options`, { auth })).options;
  },
  async agentCustomContext(draftId, field, value, auth) {
    return (await agentRequest(`/api/agent/drafts/${encodeURIComponent(draftId)}/custom-context`, { method: 'POST', body: { field, value }, auth })).draft;
  },
  async getAgentDraft(draftId, auth) {
    return (await agentRequest(`/api/agent/drafts/${encodeURIComponent(draftId)}`, { auth })).draft;
  },
  async confirmAgentDraft(draft, auth) {
    const data = await agentRequest(`/api/agent/drafts/${encodeURIComponent(draft.draftId)}/confirm`, {
      method: 'POST', body: { revision: draft.revision, planHash: await browserPlanHash(draft.planSpec) }, auth
    });
    await request('/api/state');
    return data;
  },
  async cancelAgentDraft(draftId, auth) {
    return (await agentRequest(`/api/agent/drafts/${encodeURIComponent(draftId)}/cancel`, { method: 'POST', body: {}, auth })).draft;
  },
  // 从零创建真实任务。input 严格按创建契约（第2节）构造。
  // 返回：{ result, pendingWiring }。pendingWiring=true 表示真实创建端点尚未接通，
  // 本次仅完成契约校验（未真正落库），待 qa 接通端点后即可真实写入。
  // 校验失败会抛出 CreationValidationError（errors 结构与引擎一致），由前端就地提示。
  async createAutomationTask(input) {
    const attempt = await tryCreateEndpoint(input);
    if (attempt.wired) {
      // 端点已接通：以引擎返回为准。校验失败时端点应返回结构化 errors。
      if (!attempt.ok) {
        const body = attempt.data || {};
        if (Array.isArray(body.errors)) throw new CreationValidationError(body.errors);
        throw new Error(body.error || body.message || '创建失败');
      }
      const result = attempt.data.result || attempt.data;
      if (attempt.data.state) { state = attempt.data.state; window.dispatchEvent(new CustomEvent('engine-state-changed')); }
      else { await request('/api/state'); }
      return { result, pendingWiring: false };
    }
    // 端点未接通：先在前端按契约完成结构化校验（失败即抛，用于就地提示）。
    validateCreateInputLocally(input);
    // 校验通过但无真实写入通道：明确告知待接通，不伪造成功产物。
    return { result: null, pendingWiring: true };
  },
  // A2 彻底档：对话式创建按意图组合，把会话 draft + capabilities 转为契约 input 并真实创建。
  // 只放选中能力所需字段；调用真实 createAutomationTask（唯一 ID 落库，修复覆盖固定 demo 的旧 bug）。
  async createAutomationTaskFromDraft(capabilities, draft) {
    const has = cap => capabilities.includes(cap);
    const input = { capabilities: [...capabilities], taskName: draft.taskName?.trim() || '未命名帮办' };
    if (has('publish') || has('collect')) input.groupId = (draft.groupId || '').trim();
    if (has('publish')) {
      input.publishText = draft.notice;
      input.noticeFilePath = (draft.filePath || '').trim();
      input.publishAt = (draft.publishAt || '').trim();
      // 发布触发方式跟随对话选择：到设定时间=scheduled（落库为定时触发），否则=发出关键词触发。
      if (draft.triggerMode === 'scheduled') input.publishTrigger = 'scheduled';
      else if (draft.keyword?.trim()) input.publishKeyword = draft.keyword.trim();
    }
    if (has('collect')) {
      const extensions = Array.isArray(draft.allowedExtensions) ? draft.allowedExtensions : String(draft.allowedExtensions || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
      input.collectRule = { allowedExtensions: extensions };
      if (draft.fileKeyword?.trim()) input.collectRule.keyword = draft.fileKeyword.trim();
      input.nameTemplate = draft.nameTemplate;
      input.roster = (draft.roster || demoRoster()).map(m => ({ userId: String(m.userId), name: m.name, studentId: String(m.studentId) }));
    }
    if (has('collect') && has('remind')) input.deadlineAt = (draft.deadlineAt || '').trim();
    if (has('remind')) {
      input.remindText = draft.reminderText;
      // 独立提醒时间：优先用 remindAt；催未交闭环缺省可回退 deadline
      input.remindAt = (draft.remindAt || (has('collect') ? draft.deadlineAt : '') || '').trim() || undefined;
    }
    return this.createAutomationTask(input);
  },
  listFlows() { return state.flows.map(flowView).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
  getFlow(id) { const flow = state.flows.find(item => item.flowId === id); return flow ? flowView(flow) : null; },
  // P1-A 任务级：列表/详情/状态变更/编辑（用户按「任务」而非 Flow 管理）。
  listAutomations() { return (state.automations || []).slice(); },
  getAutomation(id) { return (state.automations || []).find(a => a.automationId === id) || null; },
  async setAutomationStatus(automationId, status) {
    const response = await fetch(`/api/automation-tasks/${automationId}/status`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-local-helper-csrf': state.csrfToken }, body: JSON.stringify({ status }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || '状态变更失败');
    if (data.state) { state = data.state; window.dispatchEvent(new CustomEvent('engine-state-changed')); }
    return data.view;
  },
  async editAutomation(automationId, patch) {
    const response = await fetch(`/api/automation-tasks/${automationId}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-local-helper-csrf': state.csrfToken }, body: JSON.stringify(patch) });
    const data = await response.json();
    if (!response.ok) { if (Array.isArray(data.errors)) throw new CreationValidationError(data.errors); throw new Error(data.error || data.message || '编辑失败'); }
    if (data.state) { state = data.state; window.dispatchEvent(new CustomEvent('engine-state-changed')); }
    return data.view;
  },
  async addAutomationCapability(automationId, capability, options = {}) {
    const response = await fetch(`/api/automation-tasks/${automationId}/capabilities`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-local-helper-csrf': state.csrfToken }, body: JSON.stringify({ capability, ...options }) });
    const data = await response.json();
    if (!response.ok) { if (Array.isArray(data.errors)) throw new CreationValidationError(data.errors); throw new Error(data.error || data.message || '追加能力失败'); }
    if (data.state) { state = data.state; window.dispatchEvent(new CustomEvent('engine-state-changed')); }
    return data.view;
  },
  async checkAutomationDeadline(automationId) {
    const data = await request(`/api/automation-tasks/${encodeURIComponent(automationId)}/deadline-check`, { method: 'POST', body: '{}' });
    if (data.state) { state = data.state; window.dispatchEvent(new CustomEvent('engine-state-changed')); }
    return data.check;
  },
  async remindAutomationNow(automationId, options = {}) {
    const data = await request(`/api/automation-tasks/${encodeURIComponent(automationId)}/remind-now`, { method: 'POST', body: JSON.stringify(options) });
    if (data.state) { state = data.state; window.dispatchEvent(new CustomEvent('engine-state-changed')); }
    await this.loadEvidence(automationId);
    await this.loadConversations();
    return data;
  },
  async saveFlow(kind, status) { const flow = makeFlow(kind, status); await request('/api/flows', { method: 'POST', body: JSON.stringify(flow) }); return flow; },
  async setStatus(id, status) { await request(`/api/flows/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); },
  listRuns(id) { return state.runs.filter(run => !id || run.flowId === id); },
  getRun(id) { return state.runs.find(run => run.runId === id) || null; },
  async viewRun(id) { const run = this.getRun(id); if (run?.status === 'failed' && !run.viewedAt) await request(`/api/runs/${id}/viewed`, { method: 'POST' }); },
  unreadFailures() { return state.unseenFailureCount; },
  getAttachment() { return state.attachments[0] || { members: [] }; },
  getAttachmentById(id) { return (state.attachments || []).find(a => a.taskAttachmentId === id) || null; },
  describe,
  async trigger(kind, variant = 'success') {
    const automationId = store.get().ui.selectedAutomationId;
    if (!automationId) throw new Error('请先选择一个自动帮办');
    const data = await request(`/api/automation-tasks/${encodeURIComponent(automationId)}/mock-run`, {
      method: 'POST',
      body: JSON.stringify({ capability: kind, variant })
    });
    await this.loadEvidence(automationId);
    await this.loadConversations();
    return data.run;
  },
  async reset() { const result = await request('/api/reset', { method: 'POST', body: '{}' }); clearBrowserState(); runtime.conversations = []; runtime.messages.clear(); runtime.evidence.clear(); return result; },
  snapshot() { return clone(state); },
  messages() {
    const group = state.adapters.groupMessages.map(message => ({ from: state.demo.account?.name || '演示用户', text: message.text, file: message.filePath.split('/').pop() }));
    const replies = state.adapters.replies.map(message => ({ from: '本地助手', text: message.text }));
    return [...group, ...replies];
  }
};
