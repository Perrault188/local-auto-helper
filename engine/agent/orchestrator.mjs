import { AGENT_SPEC_VERSION, makeSlot, validateAgentDraft, validateIntentSpec, validatePlanSpec } from './specs.mjs';
import { assertRegisteredPlan, BINDING_ALLOWLIST, REGISTRY_VERSION, RISK_POLICIES } from './registry.mjs';
import { RuleBasedProvider, parseProviderOutput } from './provider.mjs';
import { compileCreationInput } from './compiler.mjs';
import { validateCreateAutomationTaskInput } from '../creation.mjs';
import { createHash } from 'node:crypto';
import { analyzeRegisteredClarification, analyzeRegisteredRequest } from './coverage.mjs';

const REQUIRED = {
  education: { publish: ['taskName', 'groupId', 'publishTrigger', 'publishText', 'noticeFilePath'], collect: ['taskName', 'groupId', 'collectRule', 'nameTemplate', 'roster', 'deadlineAt', 'replyText'], remind: ['taskName', 'remindText', 'remindAt'] },
  finance: { collect: ['taskName', 'groupId', 'collectRule', 'nameTemplate', 'submitters'] },
  retail: { collect: ['taskName', 'groupId', 'collectRule', 'nameTemplate', 'stores', 'replyText'], remind: ['remindText', 'remindAt', 'deadlineAt'] }
};
const QUESTIONS = { taskName: '这件帮办叫什么？', groupId: '要在哪个群里处理？', publishTrigger: '什么时候开始发送？', publishKeyword: '你发出哪句话时开始发送？', publishText: '要发送什么内容？', noticeFilePath: '要一起发送哪个文件？', publishAt: '什么时候发送？', collectRule: '要收哪些文件，文件名需要包含什么？', nameTemplate: '收到文件后，要按什么格式改名？', roster: '使用哪份成员名单？', replyText: '登记完成后，要回复发送人什么？', remindText: '提醒时要说什么？', remindAt: '什么时候提醒？', deadlineAt: '什么时候算缺失或逾期？', submitters: '要按哪份提交人或项目清单登记？', stores: '要按哪份门店和负责人清单检查？' };
export function coverageGuard(message, result, allowedDomain = null) {
  if (result.outcome === 'unsupported') return result;
  const clarification = analyzeRegisteredClarification(message, allowedDomain);
  if (result.outcome === 'needs_clarification' && clarification) {
    const candidates = result.candidates.filter(candidate => clarification.candidates.some(item =>
      item.domain === candidate.domain && JSON.stringify(item.capabilities) === JSON.stringify(candidate.capabilities)));
    if (candidates.length > 1) return { ...result, candidates };
  }
  const analyses = analyzeRegisteredRequest(message, allowedDomain);
  const candidates = result.candidates.filter(candidate => analyses.some(item =>
    item.domain === candidate.domain
    && JSON.stringify(item.capabilities) === JSON.stringify(candidate.capabilities)));
  if (!candidates.length) return {
    outcome: 'unsupported',
    reasonCode: analyses.length ? 'outside_registered_capabilities' : 'mixed_supported_and_unsupported_operations'
  };
  return {
    ...result,
    outcome: candidates.length > 1 ? 'needs_clarification' : 'supported',
    candidates
  };
}
const exact = (object, keys, label) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label}必须是对象`);
  const unknown = Object.keys(object).filter(key => !keys.includes(key));
  if (unknown.length) throw new Error(`${label}含未知字段：${unknown.join('、')}`);
};
const short = (value, label, max = 500) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}非法`); return value.trim(); };
function sanitizeContext(domain, input = {}) {
  exact(input, [...BINDING_ALLOWLIST[domain], 'domain'], 'trustedContext');
  const out = {};
  for (const key of BINDING_ALLOWLIST[domain]) if (input[key] !== undefined) out[key] = structuredClone(input[key]);
  for (const key of ['taskName', 'groupId', 'publishText', 'noticeFilePath', 'publishAt', 'deadlineAt', 'remindAt', 'remindText', 'nameTemplate', 'replyText', 'publishTrigger', 'publishKeyword', 'publishConversationId']) if (out[key] !== undefined) out[key] = short(out[key], key, key === 'publishText' || key === 'remindText' ? 1000 : 300);
  if (out.collectRule) { exact(out.collectRule, ['allowedExtensions', 'keyword'], 'collectRule'); if (!Array.isArray(out.collectRule.allowedExtensions) || out.collectRule.allowedExtensions.length > 20) throw new Error('文件类型非法'); out.collectRule.allowedExtensions = out.collectRule.allowedExtensions.map(item => short(item, '文件类型', 20)); if (out.collectRule.keyword !== undefined) out.collectRule.keyword = short(out.collectRule.keyword, '关键词', 100); }
  const list = (key, fields) => {
    if (out[key] === undefined) return;
    if (!Array.isArray(out[key]) || !out[key].length || out[key].length > 500) throw new Error(`${key}非法`);
    out[key] = out[key].map((item, index) => { exact(item, fields, `${key}[${index}]`); return Object.fromEntries(fields.map(field => [field, short(String(item[field] ?? ''), `${key}.${field}`, 120)])); });
  };
  list('roster', ['userId', 'name', 'studentId']); list('submitters', ['userId', 'name', 'entityId']); list('stores', ['ownerUserId', 'storeName', 'storeId']);
  if (JSON.stringify(out).length > 30000) throw new Error('trustedContext超过大小限制');
  return out;
}
const parseAnswer = (field, answer) => {
  const value = short(answer, 'userAnswer', 1000);
  if (['groupId', 'noticeFilePath', 'publishTrigger', 'collectRule', 'nameTemplate', 'roster', 'replyText', 'remindText', 'submitters', 'stores'].includes(field)) throw new Error(`${field}必须由受控trustedContext选择器提供`);
  if (['publishAt', 'deadlineAt', 'remindAt'].includes(field) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('时间需要使用带时区的明确时间，请继续说明');
  if (!['taskName', 'publishText', 'remindText', 'replyText', 'publishKeyword', 'publishAt', 'deadlineAt', 'remindAt'].includes(field)) throw new Error(`${field}不接受自由文本确认`);
  return value;
};

export class AgentOrchestrator {
  constructor({ provider = new RuleBasedProvider(), fallback = new RuleBasedProvider() } = {}) { this.provider = provider; this.fallback = fallback; }
  async infer(input) {
    try {
      let output = parseProviderOutput(await this.provider.infer(input));
      if (output.outcome !== 'unsupported') for (const candidate of output.candidates) assertRegisteredPlan(candidate.domain, candidate.capabilities);
      output = coverageGuard(input.message, output, input.trustedContext?.domain ?? null);
      if (output.outcome === 'unsupported') return { ...output, fallbackReason: null };
      output.candidates = output.candidates.map(candidate => candidate.domain === 'finance'
        ? { ...candidate, goal: '收取单据并进入待审核清单', assumptions: [...new Set([...candidate.assumptions, '必须人工审核，不自动审核、付款或入账'])] }
        : candidate);
      for (const candidate of output.candidates) assertRegisteredPlan(candidate.domain, candidate.capabilities);
      return { ...output, fallbackReason: null };
    } catch (error) {
      let output = parseProviderOutput(await this.fallback.infer(input));
      if (output.outcome !== 'unsupported') for (const candidate of output.candidates) assertRegisteredPlan(candidate.domain, candidate.capabilities);
      output = coverageGuard(input.message, output, input.trustedContext?.domain ?? null);
      if (output.outcome === 'unsupported') return { ...output, fallbackReason: typeof error?.code === 'string' ? error.code : 'provider_invalid_or_unavailable' };
      for (const candidate of output.candidates) assertRegisteredPlan(candidate.domain, candidate.capabilities);
      return { ...output, fallbackReason: typeof error?.code === 'string' ? error.code : 'provider_invalid_or_unavailable' };
    }
  }
  async applyMessage(draft, { message = '', userAnswer, trustedContext, facts, selectedCandidateIndex } = {}, now) {
    const initialContext = trustedContext ?? facts ?? {};
    const inferredDomain = initialContext.domain ?? draft.planSpec?.domain;
    if (inferredDomain) sanitizeContext(inferredDomain, initialContext);
    let output;
    if (draft.status === 'unsupported' && userAnswer !== undefined) throw new Error('不支持状态只能使用新message重新描述');
    if (!draft.planSpec && selectedCandidateIndex === undefined) output = await this.infer({ message: short(message, 'message', 1000), trustedContext: { domain: inferredDomain }, draft: null });
    else if (!draft.planSpec) output = { candidates: draft.candidateUnderstandings, fallbackReason: draft.fallbackReason };
    else output = { candidates: draft.candidateUnderstandings, fallbackReason: draft.fallbackReason };
    if (output.outcome === 'unsupported') {
      return validateAgentDraft({
        ...draft,
        status: 'unsupported',
        candidateUnderstandings: [],
        intentSpec: null,
        planSpec: null,
        pendingQuestion: null,
        unsupportedResult: { reasonCode: output.reasonCode, detectedAt: now },
        fallbackReason: output.fallbackReason ?? null,
        revision: draft.revision + 1,
        updatedAt: now,
        confirmedAt: null,
        confirmedPlanHash: null,
        compiledAutomationId: null
      });
    }
    if (!draft.planSpec && selectedCandidateIndex === undefined) output.candidates = output.candidates.map((candidate, index) => ({
      ...candidate,
      candidateId: createHash('sha256').update(`${draft.draftId}|${draft.revision + 1}|${index}|${candidate.domain}|${candidate.goal}|${candidate.capabilities.join(',')}`).digest('hex').slice(0, 32)
    }));
    const candidateDomain = draft.planSpec?.domain ?? output.candidates[selectedCandidateIndex ?? 0]?.domain;
    sanitizeContext(candidateDomain, initialContext);
    if (!draft.planSpec && output.candidates.length > 1 && selectedCandidateIndex === undefined) {
      return validateAgentDraft({ ...draft, status: 'awaiting_candidate', candidateUnderstandings: output.candidates, planSpec: null, intentSpec: null, pendingQuestion: null, unsupportedResult: null, fallbackReason: output.fallbackReason ?? null, revision: draft.revision + 1, updatedAt: now, confirmedAt: null, confirmedPlanHash: null });
    }
    const first = output.candidates[selectedCandidateIndex ?? 0];
    if (!first) throw new Error('候选序号非法');
    const domain = draft.planSpec?.domain ?? first.domain;
    const capabilities = assertRegisteredPlan(domain, draft.planSpec?.capabilities ?? first.capabilities);
    const context = sanitizeContext(domain, initialContext);
    const bindings = { ...(draft.planSpec?.bindings ?? {}), ...context };
    delete bindings.domain;
    if (domain === 'finance' && capabilities.includes('collect') && !bindings.replyText) bindings.replyText = '已登记到待审核清单。本帮办不会自动审核、付款或入账。';
    if (userAnswer !== undefined) {
      if (!draft.pendingQuestion) throw new Error('当前没有待回答的问题');
      bindings[draft.pendingQuestion.field] = parseAnswer(draft.pendingQuestion.field, userAnswer);
    }
    const needed = [...new Set(capabilities.flatMap(cap => REQUIRED[domain][cap] ?? []))];
    if (domain === 'education' && capabilities.includes('publish')) {
      if (bindings.publishTrigger === 'scheduled') needed.push('publishAt');
      if (bindings.publishTrigger === 'self_message') needed.push('publishKeyword');
    }
    let missing = needed.find(key => bindings[key] === undefined || bindings[key] === null || bindings[key] === '');
    const nextRevision = draft.revision + 1;
    const intentSpec = {
      specVersion: AGENT_SPEC_VERSION, domain,
      goal: makeSlot(first.goal, 'model', 'inferred', first.confidence),
      scope: makeSlot(bindings.groupId ?? null, bindings.groupId ? (userAnswer !== undefined && draft.pendingQuestion?.field === 'groupId' ? 'user' : 'context') : 'model', bindings.groupId ? (userAnswer !== undefined && draft.pendingQuestion?.field === 'groupId' ? 'confirmed' : 'inferred') : 'missing', bindings.groupId ? 1 : 0),
      trigger: makeSlot(capabilities, 'model', 'inferred', first.confidence),
      target: makeSlot(bindings.groupId ?? null, bindings.groupId ? 'context' : 'model', bindings.groupId ? 'inferred' : 'missing', bindings.groupId ? 0.9 : 0),
      rules: makeSlot(bindings.collectRule ?? null, bindings.collectRule ? 'context' : 'model', bindings.collectRule ? 'inferred' : 'missing', bindings.collectRule ? 0.9 : 0),
      expectedOutcome: makeSlot(first.goal, 'model', 'inferred', first.confidence),
      riskLevel: domain === 'finance' ? 'high' : 'medium', assumptions: first.assumptions, confirmedFacts: userAnswer !== undefined && draft.pendingQuestion ? [draft.pendingQuestion.field] : []
    };
    const planSpec = {
      specVersion: AGENT_SPEC_VERSION, domain, capabilities, bindings, riskPolicy: structuredClone(RISK_POLICIES[domain]),
      approvalRequirements: ['确认持续执行', '确认监听与发送范围', ...(domain === 'finance' ? ['人工审核后才能继续，禁止自动审核、付款或入账'] : [])],
      humanReadablePlan: `${domain}：${capabilities.join('、')}`, registryVersion: REGISTRY_VERSION,
      confirmationContext: { draftId: draft.draftId, conversationId: draft.conversationId, revision: nextRevision }
    };
    validateIntentSpec(intentSpec); validatePlanSpec(planSpec);
    if (!missing) {
      try { validateCreateAutomationTaskInput(compileCreationInput(planSpec)); }
      catch (error) { missing = error.errors?.[0]?.field?.split('.')[0] ?? 'taskName'; }
    }
    const acceptedFields = [...Object.keys(context), ...(userAnswer !== undefined && draft.pendingQuestion ? [draft.pendingQuestion.field] : [])];
    const next = { ...draft, status: missing ? 'awaiting_answer' : 'ready_for_confirmation', intentSpec, candidateUnderstandings: output.candidates, planSpec, pendingQuestion: missing ? { field: missing, text: QUESTIONS[missing] } : null, summary: [...draft.summary, { at: now, acceptedFields }].slice(-20), unsupportedResult: null, fallbackReason: output.fallbackReason ?? null, revision: nextRevision, updatedAt: now, confirmedAt: null, confirmedPlanHash: null };
    return validateAgentDraft(next);
  }
}
