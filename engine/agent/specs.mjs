import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isRfc3339 } from '../utils.mjs';

export const AGENT_SPEC_VERSION = '1.0';
export const DRAFT_STATUSES = ['collecting', 'awaiting_candidate', 'awaiting_answer', 'ready_for_confirmation', 'unsupported', 'compiling', 'compiled', 'cancelled', 'expired'];
export const UNSUPPORTED_REASON_CODES = ['outside_registered_capabilities', 'mixed_supported_and_unsupported_operations', 'insufficient_supported_evidence'];
const DOMAINS = ['education', 'finance', 'retail'];
const CAPS = ['publish', 'collect', 'remind'];
const SOURCE = ['user', 'context', 'default', 'model'];
const SLOT_STATUS = ['missing', 'inferred', 'confirmed'];
const BINDINGS = {
  education: ['taskName', 'groupId', 'publishText', 'noticeFilePath', 'publishAt', 'deadlineAt', 'remindAt', 'remindText', 'collectRule', 'roster', 'nameTemplate', 'replyText', 'publishTrigger', 'publishKeyword', 'publishConversationId'],
  finance: ['taskName', 'groupId', 'submitters', 'collectRule', 'nameTemplate', 'replyText'],
  retail: ['taskName', 'groupId', 'stores', 'collectRule', 'nameTemplate', 'replyText', 'deadlineAt', 'remindAt', 'remindText']
};
const exact = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  const own = Object.keys(value);
  const extra = own.filter(key => !keys.includes(key));
  const missing = keys.filter(key => !own.includes(key));
  if (extra.length || missing.length) throw new Error(`${label}字段不严格：${[...extra, ...missing].join('、')}`);
};
const text = (value, label, max = 500, allowEmpty = false) => {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new Error(`${label}文本非法`);
};
const stringArray = (value, label, maxItems = 20, maxLength = 200) => {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label}数组非法`);
  value.forEach((item, index) => text(item, `${label}[${index}]`, maxLength));
};
const slot = (value, label) => {
  exact(value, ['value', 'source', 'confidence', 'status'], label);
  if (!SOURCE.includes(value.source) || !SLOT_STATUS.includes(value.status)) throw new Error(`${label}来源或状态非法`);
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) throw new Error(`${label}置信度非法`);
  if (value.status === 'missing' && value.value !== null) throw new Error(`${label}缺失状态必须为空`);
  if (value.value !== null && typeof value.value !== 'string' && !Array.isArray(value.value) && (typeof value.value !== 'object' || Array.isArray(value.value))) throw new Error(`${label}值类型非法`);
  if (typeof value.value === 'string' && value.value.length > 1000) throw new Error(`${label}值过长`);
  if (JSON.stringify(value.value).length > 20000) throw new Error(`${label}值过大`);
};
export const makeSlot = (value = null, source = 'user', status = 'confirmed', confidence = 1) => ({ value, source, confidence, status });

export function validateCandidate(value, index = 0) {
  exact(value, ['candidateId', 'domain', 'goal', 'capabilities', 'assumptions', 'confidence'], `candidate[${index}]`);
  if (!/^[a-f0-9]{24,64}$/.test(value.candidateId)) throw new Error('候选标识非法');
  if (!DOMAINS.includes(value.domain)) throw new Error('候选领域非法');
  text(value.goal, '候选目标', 200);
  if (!Array.isArray(value.capabilities) || !value.capabilities.length || value.capabilities.length > 3 || new Set(value.capabilities).size !== value.capabilities.length || value.capabilities.some(cap => !CAPS.includes(cap))) throw new Error('候选能力非法');
  stringArray(value.assumptions, '候选假设', 10, 200);
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) throw new Error('候选置信度非法');
  return value;
}

export function validateIntentSpec(value) {
  exact(value, ['specVersion', 'domain', 'goal', 'scope', 'trigger', 'target', 'rules', 'expectedOutcome', 'riskLevel', 'assumptions', 'confirmedFacts'], 'IntentSpec');
  if (value.specVersion !== AGENT_SPEC_VERSION || !DOMAINS.includes(value.domain)) throw new Error('IntentSpec版本或领域非法');
  for (const key of ['goal', 'scope', 'trigger', 'target', 'rules', 'expectedOutcome']) slot(value[key], `IntentSpec.${key}`);
  if (!['low', 'medium', 'high'].includes(value.riskLevel)) throw new Error('IntentSpec风险非法');
  stringArray(value.assumptions, 'IntentSpec.assumptions', 20, 200);
  stringArray(value.confirmedFacts, 'IntentSpec.confirmedFacts', 30, 80);
  return value;
}

export function validatePlanSpec(value) {
  exact(value, ['specVersion', 'domain', 'capabilities', 'bindings', 'riskPolicy', 'approvalRequirements', 'humanReadablePlan', 'registryVersion', 'confirmationContext'], 'PlanSpec');
  if (value.specVersion !== AGENT_SPEC_VERSION || !DOMAINS.includes(value.domain)) throw new Error('PlanSpec版本或领域非法');
  if (!Array.isArray(value.capabilities) || !value.capabilities.length || value.capabilities.length > 3 || new Set(value.capabilities).size !== value.capabilities.length || value.capabilities.some(cap => !CAPS.includes(cap))) throw new Error('PlanSpec能力非法');
  if (!value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings) || JSON.stringify(value.bindings).length > 20000) throw new Error('PlanSpec参数绑定非法');
  const unknownBindings = Object.keys(value.bindings).filter(key => !BINDINGS[value.domain].includes(key));
  if (unknownBindings.length) throw new Error(`PlanSpec bindings含未知字段：${unknownBindings.join('、')}`);
  for (const [key, item] of Object.entries(value.bindings)) {
    if (['collectRule'].includes(key)) {
      exact(item, ['allowedExtensions', ...(item.keyword === undefined ? [] : ['keyword'])], `bindings.${key}`);
      if (!Array.isArray(item.allowedExtensions) || !item.allowedExtensions.length || item.allowedExtensions.length > 20) throw new Error('文件类型白名单非法');
      item.allowedExtensions.forEach(ext => text(ext, '扩展名', 20));
      if (item.keyword !== undefined) text(item.keyword, '关键词', 100);
    } else if (['roster', 'submitters', 'stores'].includes(key)) {
      const fields = key === 'roster' ? ['userId', 'name', 'studentId'] : key === 'submitters' ? ['userId', 'name', 'entityId'] : ['ownerUserId', 'storeName', 'storeId'];
      if (!Array.isArray(item) || !item.length || item.length > 500) throw new Error(`${key}非法`);
      item.forEach((row, index) => { exact(row, fields, `${key}[${index}]`); fields.forEach(field => text(row[field], `${key}.${field}`, 120)); });
    } else if (typeof item !== 'string' || !item.trim() || item.length > 1000) throw new Error(`bindings.${key}非法`);
  }
  exact(value.riskPolicy, ['humanApprovalRequired', 'autoReview', 'autoPayment', 'autoBookkeeping'], 'PlanSpec.riskPolicy');
  for (const item of Object.values(value.riskPolicy)) if (typeof item !== 'boolean') throw new Error('PlanSpec风险策略非法');
  stringArray(value.approvalRequirements, 'PlanSpec.approvalRequirements', 10, 200);
  text(value.humanReadablePlan, 'PlanSpec.humanReadablePlan', 1000);
  text(value.registryVersion, 'PlanSpec.registryVersion', 40);
  exact(value.confirmationContext, ['draftId', 'conversationId', 'revision'], 'PlanSpec.confirmationContext');
  text(value.confirmationContext.draftId, '确认草稿', 80); text(value.confirmationContext.conversationId, '确认会话', 120);
  if (!Number.isInteger(value.confirmationContext.revision) || value.confirmationContext.revision < 1) throw new Error('确认版本非法');
  return value;
}

export function validateAgentDraft(value) {
  const fields = ['draftId', 'conversationId', 'draftTokenHash', 'status', 'intentSpec', 'candidateUnderstandings', 'planSpec', 'pendingQuestion', 'summary', 'revisionHistory', 'fallbackReason', 'unsupportedResult', 'revision', 'createdAt', 'updatedAt', 'expiresAt', 'confirmedAt', 'compiledAutomationId', 'confirmedPlanHash', 'idempotencyKey'];
  exact(value, fields, 'AgentDraft');
  if (!/^agentdraft_[A-Za-z0-9-]+$/.test(value.draftId) || !DRAFT_STATUSES.includes(value.status)) throw new Error('AgentDraft标识或状态非法');
  text(value.conversationId, 'AgentDraft.conversationId', 120); text(value.draftTokenHash, 'AgentDraft.draftTokenHash', 64);
  if (value.intentSpec) validateIntentSpec(value.intentSpec);
  if (value.planSpec) validatePlanSpec(value.planSpec);
  const zeroCandidateStatus = ['unsupported', 'cancelled', 'expired'].includes(value.status);
  if (!Array.isArray(value.candidateUnderstandings) || value.candidateUnderstandings.length > 4 || (!zeroCandidateStatus && value.candidateUnderstandings.length < 1)) throw new Error('候选理解数量非法');
  value.candidateUnderstandings.forEach(validateCandidate);
  if (new Set(value.candidateUnderstandings.map(item => `${item.domain}|${item.goal}|${item.capabilities.join(',')}`)).size !== value.candidateUnderstandings.length) throw new Error('候选理解必须可区分');
  if (value.pendingQuestion !== null) { exact(value.pendingQuestion, ['field', 'text'], 'pendingQuestion'); text(value.pendingQuestion.field, '问题字段', 60); text(value.pendingQuestion.text, '问题文本', 300); }
  if (!Array.isArray(value.summary) || value.summary.length > 20) throw new Error('摘要非法');
  value.summary.forEach((item, index) => { exact(item, ['at', 'acceptedFields'], `summary[${index}]`); if (!isRfc3339(item.at)) throw new Error('摘要时间非法'); stringArray(item.acceptedFields, '摘要字段', 30, 80); });
  if (!Array.isArray(value.revisionHistory) || value.revisionHistory.length > 10) throw new Error('修订历史非法');
  value.revisionHistory.forEach((item, index) => {
    exact(item, ['revision', 'status', 'intentSpec', 'candidateUnderstandings', 'planSpec', 'pendingQuestion', 'summary', 'fallbackReason', 'unsupportedResult'], `revisionHistory[${index}]`);
    if (!Number.isInteger(item.revision) || !DRAFT_STATUSES.includes(item.status) || !Array.isArray(item.candidateUnderstandings) || !Array.isArray(item.summary)) throw new Error('修订历史内容非法');
  });
  if (value.fallbackReason !== null) text(value.fallbackReason, '降级原因', 120);
  if (value.unsupportedResult !== null) {
    exact(value.unsupportedResult, ['reasonCode', 'detectedAt'], 'unsupportedResult');
    if (!UNSUPPORTED_REASON_CODES.includes(value.unsupportedResult.reasonCode) || !isRfc3339(value.unsupportedResult.detectedAt)) throw new Error('unsupportedResult非法');
  }
  if (!Number.isInteger(value.revision) || value.revision < 0 || ![value.createdAt, value.updatedAt, value.expiresAt].every(isRfc3339)) throw new Error('AgentDraft版本或时间非法');
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt) || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) throw new Error('AgentDraft时间不变量非法');
  if (value.status === 'compiled' && (!value.compiledAutomationId || !value.confirmedPlanHash)) throw new Error('已编译草稿缺少结果');
  if (value.status === 'ready_for_confirmation' && (value.pendingQuestion !== null || !value.planSpec)) throw new Error('待确认状态非法');
  if (value.status === 'awaiting_candidate' && (value.planSpec !== null || value.candidateUnderstandings.length < 2)) throw new Error('候选选择状态非法');
  if (value.status === 'unsupported' && (value.candidateUnderstandings.length !== 0 || value.intentSpec !== null || value.planSpec !== null || value.pendingQuestion !== null || value.unsupportedResult === null || value.confirmedAt !== null || value.confirmedPlanHash !== null || value.compiledAutomationId !== null)) throw new Error('不支持状态非法');
  if (value.status !== 'unsupported' && value.unsupportedResult !== null) throw new Error('非不支持状态不能携带unsupportedResult');
  return value;
}

// SQLite/JSON后端保存整份文档。旧草稿没有unsupportedResult，读取时惰性补齐，
// 不改revision、planHash或幂等标识。
export function normalizeAgentDraftDocument(value) {
  const draft = structuredClone(value);
  if (!Object.hasOwn(draft, 'unsupportedResult')) draft.unsupportedResult = null;
  if (Array.isArray(draft.revisionHistory)) {
    draft.revisionHistory = draft.revisionHistory.map(item => Object.hasOwn(item, 'unsupportedResult')
      ? item
      : { ...item, unsupportedResult: null });
  }
  return draft;
}

export const newDraftId = () => `agentdraft_${randomUUID()}`;
export const newDraftToken = () => randomBytes(32).toString('base64url');
export const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const canonicalPlanHash = plan => createHash('sha256').update(JSON.stringify(stable(plan))).digest('hex');
