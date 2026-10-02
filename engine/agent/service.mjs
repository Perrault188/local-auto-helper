import { createHash } from 'node:crypto';
import { AgentOrchestrator } from './orchestrator.mjs';
import { compileCreationInput, planHash } from './compiler.mjs';
import { newDraftId, newDraftToken, normalizeAgentDraftDocument, tokenHash, validateAgentDraft } from './specs.mjs';
export class AgentDraftError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export class AgentService {
  constructor({ drafts, createAutomationTask, now, provider, ttlMs = 86_400_000, contextLoader } = {}) {
    this.drafts = drafts; this.createAutomationTask = createAutomationTask; this.now = now; this.ttlMs = ttlMs;
    this.orchestrator = new AgentOrchestrator({ provider }); this.locks = new Map(); this.contextLoader = contextLoader;
    this.provider = provider; this.providerStatus = provider?.status?.() ?? { mode: 'rule', configured: false, provider: 'rule-based', model: null };
  }
  async create({ conversationId }) {
    const at = this.now(); const token = newDraftToken(); const draftId = newDraftId();
    const expiresAt = new Date(Date.parse(at) + this.ttlMs).toISOString();
    const draft = {
      draftId, conversationId: String(conversationId || 'assistant_main'), draftTokenHash: tokenHash(token), status: 'collecting', intentSpec: null,
      candidateUnderstandings: [{ candidateId: createHash('sha256').update(`${draftId}|0|initial-collect`).digest('hex').slice(0, 32), domain: 'education', goal: '等待用户表达', capabilities: ['collect'], assumptions: [], confidence: 0 }, { candidateId: createHash('sha256').update(`${draftId}|0|initial-remind`).digest('hex').slice(0, 32), domain: 'education', goal: '等待用户表达并建立草稿', capabilities: ['remind'], assumptions: [], confidence: 0 }],
      planSpec: null, pendingQuestion: { field: 'goal', text: '想让我帮你做点什么？' }, summary: [], revisionHistory: [], fallbackReason: null, unsupportedResult: null, revision: 0,
      createdAt: at, updatedAt: at, expiresAt, confirmedAt: null, compiledAutomationId: null, confirmedPlanHash: null,
      idempotencyKey: createHash('sha256').update(`${draftId}|${token}`).digest('hex')
    };
    await this.drafts.save(validateAgentDraft(draft));
    return Object.assign(structuredClone(draft), { draftToken: token });
  }
  getProviderStatus() { return this.provider?.status?.() ?? this.providerStatus; }
  async #authorized(id, auth = {}) {
    const stored = await this.drafts.get(id); if (!stored) throw new AgentDraftError('找不到草稿', 404);
    const draft = validateAgentDraft(normalizeAgentDraftDocument(stored));
    if (auth.conversationId !== undefined && auth.conversationId !== draft.conversationId) throw new AgentDraftError('会话不匹配', 404);
    if (auth.draftToken !== undefined && tokenHash(auth.draftToken) !== draft.draftTokenHash) throw new AgentDraftError('找不到草稿', 404);
    if (Date.parse(this.now()) >= Date.parse(draft.expiresAt) && !['compiled', 'cancelled', 'expired'].includes(draft.status)) {
      draft.status = 'expired'; draft.pendingQuestion = null; draft.unsupportedResult = null; draft.revision++; draft.updatedAt = this.now(); draft.confirmedAt = null; draft.confirmedPlanHash = null;
      await this.drafts.save(validateAgentDraft(draft));
    }
    return draft;
  }
  async get(id, auth = {}) { return this.#authorized(id, auth); }
  async message(id, input = {}) {
    const draft = await this.#authorized(id, input);
    if (['cancelled', 'compiled', 'expired', 'compiling'].includes(draft.status)) throw new AgentDraftError('当前草稿不能继续修改', 409);
    const next = await this.orchestrator.applyMessage(draft, input, this.now());
    next.revisionHistory = [...draft.revisionHistory, this.#snapshot(draft)].slice(-10);
    return this.drafts.save(validateAgentDraft(next));
  }
  #snapshot(draft) { return structuredClone({ revision: draft.revision, status: draft.status, intentSpec: draft.intentSpec, candidateUnderstandings: draft.candidateUnderstandings, planSpec: draft.planSpec, pendingQuestion: draft.pendingQuestion, summary: draft.summary, fallbackReason: draft.fallbackReason, unsupportedResult: draft.unsupportedResult }); }
  #candidateId(draftId, revision, candidate, index) { return createHash('sha256').update(`${draftId}|${revision}|${index}|${candidate.domain}|${candidate.goal}|${candidate.capabilities.join(',')}`).digest('hex').slice(0, 32); }
  async chooseCandidate(id, { candidateId, ...input } = {}) {
    const draft = await this.#authorized(id, input);
    if (draft.status !== 'awaiting_candidate' || typeof candidateId !== 'string') throw new AgentDraftError('当前不能选择候选', 409);
    const candidateIndex = draft.candidateUnderstandings.findIndex(item => item.candidateId === candidateId);
    if (candidateIndex < 0) throw new AgentDraftError('候选已失效', 409);
    if (candidateId !== this.#candidateId(draft.draftId, draft.revision, draft.candidateUnderstandings[candidateIndex], candidateIndex)) throw new AgentDraftError('候选已失效', 409);
    const next = await this.orchestrator.applyMessage(draft, { ...input, selectedCandidateIndex: candidateIndex }, this.now());
    next.revisionHistory = [...draft.revisionHistory, this.#snapshot(draft)].slice(-10);
    return this.drafts.save(validateAgentDraft(next));
  }
  async back(id, auth = {}) {
    const draft = await this.#authorized(id, auth);
    if (!['collecting', 'awaiting_candidate', 'awaiting_answer', 'ready_for_confirmation'].includes(draft.status) || !draft.revisionHistory.length) throw new AgentDraftError('没有可返回的安全状态', 409);
    const prior = draft.revisionHistory.at(-1);
    const next = { ...draft, ...structuredClone(prior), revision: draft.revision + 1, revisionHistory: draft.revisionHistory.slice(0, -1), updatedAt: this.now(), confirmedAt: null, confirmedPlanHash: null, compiledAutomationId: null };
    if (next.status === 'awaiting_candidate') next.candidateUnderstandings = next.candidateUnderstandings.map((candidate, index) => ({ ...candidate, candidateId: this.#candidateId(next.draftId, next.revision, candidate, index) }));
    if (next.planSpec) next.planSpec.confirmationContext.revision = next.revision;
    return this.drafts.save(validateAgentDraft(next));
  }
  async revise(id, { field, ...auth } = {}) {
    const draft = await this.#authorized(id, auth);
    if (!['awaiting_answer', 'ready_for_confirmation'].includes(draft.status)) throw new AgentDraftError('当前状态不可修改', 409);
    if (!draft.planSpec || !Object.hasOwn(draft.planSpec.bindings, field) || ['domain', 'capabilities'].includes(field)) throw new AgentDraftError('该字段不可修改', 400);
    const next = structuredClone(draft); delete next.planSpec.bindings[field];
    next.status = 'awaiting_answer'; next.pendingQuestion = { field, text: `请重新确认${field}` }; next.revision++; next.updatedAt = this.now(); next.confirmedAt = null; next.confirmedPlanHash = null; next.compiledAutomationId = null;
    next.planSpec.confirmationContext.revision = next.revision;
    next.revisionHistory = [...draft.revisionHistory, this.#snapshot(draft)].slice(-10);
    return this.drafts.save(validateAgentDraft(next));
  }
  async contextOptions(id, auth = {}, { demoSeed } = {}) {
    const draft = await this.#authorized(id, auth);
    if (!['collecting', 'awaiting_candidate', 'awaiting_answer', 'ready_for_confirmation'].includes(draft.status)) throw new AgentDraftError('当前状态不能读取上下文选项', 409);
    if (!draft.pendingQuestion?.field) return [];
    const raw = await this.contextLoader?.({ draft, demoSeed }) ?? [];
    return raw.filter(item => item.field === draft.pendingQuestion.field && item.value !== undefined && item.value !== null)
      .map(item => ({ ...item, optionId: createHash('sha256').update(`${draft.draftId}|${draft.revision}|${item.field}|${JSON.stringify(item.value)}`).digest('hex').slice(0, 24) }));
  }
  async resolveContextOptions(id, auth, optionIds = [], extras = {}) {
    if (!Array.isArray(optionIds) || optionIds.length !== 1) throw new AgentDraftError('上下文选项非法：每次必须选择且只能选择一个');
    const draft = await this.#authorized(id, auth);
    const options = await this.contextOptions(id, auth, extras);
    const selected = optionIds.map(optionId => options.find(item => item.optionId === optionId));
    if (selected.some(item => !item)) throw new AgentDraftError('上下文选项已失效', 409);
    if (selected[0].field !== draft.pendingQuestion?.field) throw new AgentDraftError('上下文选项与当前问题不匹配', 409);
    return Object.fromEntries(selected.map(item => [item.field, structuredClone(item.value)]));
  }
  async resolveCustomContext(id, auth, { field, value } = {}) {
    const draft = await this.#authorized(id, auth);
    if (field !== draft.pendingQuestion?.field) throw new AgentDraftError('自定义内容与当前问题不匹配', 409);
    if (typeof value !== 'string') throw new AgentDraftError('自定义内容格式非法');
    const text = value.trim();
    const maxLength = field === 'nameTemplate' ? 300 : ['replyText', 'remindText'].includes(field) ? 500 : 80;
    if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) throw new AgentDraftError(`请填写1到${maxLength}个字符`);
    if (field === 'groupId') return { groupId: text };
    if (field === 'collectRule') {
      const parts = text.split(/[\s,，、;；]+/).filter(Boolean);
      if (!parts.length || parts.length > 5) throw new AgentDraftError('请填写1到5种文件类型');
      const allowedExtensions = [...new Set(parts.map(item => `.${item.replace(/^\./, '').toLowerCase()}`))];
      if (allowedExtensions.some(item => !/^\.[a-z0-9]{1,10}$/.test(item))) throw new AgentDraftError('文件类型请填写doc、pdf这类扩展名');
      return { collectRule: { allowedExtensions } };
    }
    if (field === 'nameTemplate') {
      const stripped = text.replaceAll(/{(?:studentId|name|originalExtension)}/g, '');
      if (stripped.includes('{') || stripped.includes('}')) throw new AgentDraftError('改名格式仅支持{studentId}、{name}和{originalExtension}');
      if (/[\\/:*?"<>|]/.test(stripped)) throw new AgentDraftError('改名格式不能包含路径分隔符或非法字符');
      return { nameTemplate: text };
    }
    if (field === 'replyText') return { replyText: text };
    if (field === 'remindText') return { remindText: text };
    throw new AgentDraftError('当前项目不支持自定义输入');
  }
  async cancel(id, auth = {}) {
    const draft = await this.#authorized(id, auth);
    if (draft.status === 'compiled') throw new AgentDraftError('已创建草稿不能取消', 409);
    draft.status = 'cancelled'; draft.pendingQuestion = null; draft.unsupportedResult = null; draft.revision++; draft.updatedAt = this.now(); draft.confirmedAt = null; draft.confirmedPlanHash = null;
    return this.drafts.save(validateAgentDraft(draft));
  }
  async confirm(id, input = {}) {
    await this.#authorized(id, input);
    if (this.locks.has(id)) return this.locks.get(id);
    const operation = this.#confirm(id, input).finally(() => this.locks.delete(id));
    this.locks.set(id, operation); return operation;
  }
  async #confirm(id, { revision, planHash: suppliedHash, ...auth } = {}) {
    let draft = await this.#authorized(id, auth);
    if (draft.status === 'compiled') {
      if (revision === draft.revision && suppliedHash === draft.confirmedPlanHash) return { draft, automationId: draft.compiledAutomationId, idempotent: true };
      throw new AgentDraftError('草稿已按其他版本创建', 409);
    }
    if (!['ready_for_confirmation', 'compiling'].includes(draft.status) || revision !== draft.revision) throw new AgentDraftError('草稿版本已变化，请重新确认', 409);
    const context = draft.planSpec?.confirmationContext;
    if (!context || context.draftId !== draft.draftId || context.conversationId !== draft.conversationId || context.revision !== draft.revision) throw new AgentDraftError('计划确认上下文不匹配，请重新生成计划', 409);
    const hash = planHash(draft.planSpec); if (suppliedHash !== hash) throw new AgentDraftError('计划摘要已变化，请重新确认', 409);
    if (draft.status === 'ready_for_confirmation') {
      draft.status = 'compiling'; draft.confirmedPlanHash = hash; draft.updatedAt = this.now();
      await this.drafts.save(validateAgentDraft(draft));
    }
    const result = await this.createAutomationTask({ ...compileCreationInput(draft.planSpec), idempotencyKey: draft.idempotencyKey });
    draft = await this.drafts.get(id);
    draft.status = 'compiled'; draft.confirmedAt = this.now(); draft.compiledAutomationId = result.automationId; draft.confirmedPlanHash = hash; draft.pendingQuestion = null; draft.updatedAt = this.now();
    await this.drafts.save(validateAgentDraft(draft));
    return { draft, result, automationId: result.automationId, idempotent: false };
  }
}
