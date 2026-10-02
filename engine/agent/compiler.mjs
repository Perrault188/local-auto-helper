import { assertRegisteredPlan, BINDING_ALLOWLIST, REGISTRY_VERSION, RISK_POLICIES } from './registry.mjs';
import { canonicalPlanHash, validatePlanSpec } from './specs.mjs';
export function normalizePlan(plan) {
  validatePlanSpec(plan);
  if (plan.registryVersion !== REGISTRY_VERSION) throw new Error('能力注册表版本已变化，请重新生成计划');
  const capabilities = assertRegisteredPlan(plan.domain, plan.capabilities);
  if (JSON.stringify(plan.riskPolicy) !== JSON.stringify(RISK_POLICIES[plan.domain])) throw new Error('领域风险策略不匹配');
  return { ...plan, capabilities, bindings: structuredClone(plan.bindings) };
}
export function planHash(plan) { return canonicalPlanHash(normalizePlan(plan)); }
export function compileCreationInput(plan) {
  const normalized = normalizePlan(plan);
  const input = Object.fromEntries(BINDING_ALLOWLIST[normalized.domain].filter(key => normalized.bindings[key] !== undefined).map(key => [key, structuredClone(normalized.bindings[key])]));
  input.domain = normalized.domain; input.capabilities = normalized.capabilities;
  if (normalized.domain === 'finance') input.capabilities = ['collect'];
  return input;
}
