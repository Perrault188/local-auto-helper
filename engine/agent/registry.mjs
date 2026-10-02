export const REGISTRY_VERSION = 'p1b-v2';
const REGISTRY = {
  education: [['publish'], ['collect'], ['remind'], ['publish', 'collect'], ['collect', 'remind'], ['publish', 'collect', 'remind']],
  finance: [['collect']],
  retail: [['collect'], ['collect', 'remind']]
};
export const RISK_POLICIES = {
  education: { humanApprovalRequired: false, autoReview: false, autoPayment: false, autoBookkeeping: false },
  finance: { humanApprovalRequired: true, autoReview: false, autoPayment: false, autoBookkeeping: false },
  retail: { humanApprovalRequired: false, autoReview: false, autoPayment: false, autoBookkeeping: false }
};
export const BINDING_ALLOWLIST = {
  education: ['taskName', 'groupId', 'publishText', 'noticeFilePath', 'publishAt', 'deadlineAt', 'remindAt', 'remindText', 'collectRule', 'roster', 'nameTemplate', 'replyText', 'publishTrigger', 'publishKeyword', 'publishConversationId'],
  finance: ['taskName', 'groupId', 'submitters', 'collectRule', 'nameTemplate', 'replyText'],
  retail: ['taskName', 'groupId', 'stores', 'collectRule', 'nameTemplate', 'replyText', 'deadlineAt', 'remindAt', 'remindText']
};
export function assertRegisteredPlan(domain, capabilities) {
  const ordered = ['publish', 'collect', 'remind'].filter(cap => capabilities.includes(cap));
  if (!REGISTRY[domain]?.some(item => JSON.stringify(item) === JSON.stringify(ordered))) throw new Error(`未注册的领域能力组合：${domain}/${ordered.join('+')}`);
  return ordered;
}
export const safeRegistryView = () => structuredClone(REGISTRY);
