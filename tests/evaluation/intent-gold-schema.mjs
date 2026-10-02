import { safeRegistryView } from '../../engine/agent/registry.mjs';

const CATEGORIES = ['short', 'colloquial', 'ellipsis', 'typo', 'registered_combo', 'ambiguity', 'out_of_scope', 'injection'];
const CLARIFICATION_SUBCATEGORIES = ['domain_ambiguity', 'capability_ambiguity', 'missing_object', 'typo_uncertain'];
const UNSUPPORTED_SUBCATEGORIES = ['out_of_scope', 'injection', 'mixed_operation', 'unsafe_finance'];
const OUTCOMES = ['supported', 'needs_clarification', 'unsupported'];
const DOMAINS = ['education', 'finance', 'retail'];
const CAPABILITIES = ['publish', 'collect', 'remind'];
const SPLITS = ['dev', 'validation', 'holdout'];
const SIDE_EFFECT_POLICIES = ['zero_everything', 'no_confirmation', 'zero_business_writes_before_confirmation'];
const exactKeys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label}含未知字段 ${unknown.join(',')}`);
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const registry = safeRegistryView();
const registered = (domains, capabilitySet) => domains.some(domain => registry[domain]?.some(set => same(set, capabilitySet)));
const countBy = (cases, field, values) => Object.fromEntries(values.map(value => [value, cases.filter(item => item[field] === value).length]));

export function validateIntentGoldFixture(fixture) {
  exactKeys(fixture, ['schemaVersion', 'createdFor', 'datasetType', 'holdoutType', 'caseCount', 'cases'], 'fixture');
  if (fixture.schemaVersion !== 'intent-gold-v2' || fixture.createdFor !== 'P2-M0' || fixture.datasetType !== 'regression' || fixture.holdoutType !== 'regression') throw new Error('fixture版本或回归集标识非法');
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== 240 || fixture.caseCount !== 240) throw new Error('金标必须恰好240条');
  const ids = new Set();
  const queries = new Set();
  const clusterSplits = new Map();
  for (const [index, item] of fixture.cases.entries()) {
    exactKeys(item, ['caseId', 'clusterId', 'split', 'input', 'gold', 'forbiddenCapabilities', 'sideEffectPolicy', 'category', 'subcategory', 'tags', 'rationale'], `cases[${index}]`);
    if (!/^INT-[0-9]{3}$/.test(item.caseId) || ids.has(item.caseId)) throw new Error(`caseId非法或重复 ${item.caseId}`);
    ids.add(item.caseId);
    if (!/^CLU-[0-9]{3}$/.test(item.clusterId)) throw new Error(`${item.caseId} clusterId非法`);
    if (!SPLITS.includes(item.split)) throw new Error(`${item.caseId} split非法`);
    if (clusterSplits.has(item.clusterId) && clusterSplits.get(item.clusterId) !== item.split) throw new Error(`${item.clusterId}跨split污染`);
    clusterSplits.set(item.clusterId, item.split);
    exactKeys(item.input, ['message', 'trustedDomainHint'], `${item.caseId}.input`);
    if (typeof item.input.message !== 'string' || !item.input.message.trim() || item.input.message.length > 300 || queries.has(item.input.message)) throw new Error(`${item.caseId} message非法或重复`);
    queries.add(item.input.message);
    if (item.input.trustedDomainHint !== null && !DOMAINS.includes(item.input.trustedDomainHint)) throw new Error(`${item.caseId} trustedDomainHint非法`);
    if (!CATEGORIES.includes(item.category) || typeof item.subcategory !== 'string' || !item.subcategory) throw new Error(`${item.caseId}语义簇非法`);
    exactKeys(item.gold, ['outcome', 'acceptedDomains', 'acceptedCapabilitySets', 'requiredQuestionFields'], `${item.caseId}.gold`);
    if (!OUTCOMES.includes(item.gold.outcome)) throw new Error(`${item.caseId} outcome非法`);
    if (!Array.isArray(item.gold.acceptedDomains) || item.gold.acceptedDomains.some(domain => !DOMAINS.includes(domain))) throw new Error(`${item.caseId} acceptedDomains非法`);
    if (!Array.isArray(item.gold.acceptedCapabilitySets) || item.gold.acceptedCapabilitySets.some(set => !Array.isArray(set) || !set.length || set.some(cap => !CAPABILITIES.includes(cap)) || !registered(item.gold.acceptedDomains, set))) throw new Error(`${item.caseId}含非法registry组合`);
    if (!Array.isArray(item.gold.requiredQuestionFields) || item.gold.requiredQuestionFields.some(field => typeof field !== 'string' || !field)) throw new Error(`${item.caseId} requiredQuestionFields非法`);
    if (!Array.isArray(item.forbiddenCapabilities) || item.forbiddenCapabilities.some(cap => !CAPABILITIES.includes(cap))) throw new Error(`${item.caseId} forbiddenCapabilities非法`);
    if (!SIDE_EFFECT_POLICIES.includes(item.sideEffectPolicy)) throw new Error(`${item.caseId} sideEffectPolicy非法`);
    if (!Array.isArray(item.tags) || !item.tags.includes(item.category) || !item.tags.includes(item.subcategory) || !item.tags.includes(item.gold.outcome)) throw new Error(`${item.caseId} tags缺语义标签`);
    if (typeof item.rationale !== 'string' || !item.rationale.trim()) throw new Error(`${item.caseId} rationale非法`);
    if (item.gold.outcome === 'supported' && (item.gold.acceptedDomains.length !== 1 || item.gold.acceptedCapabilitySets.length < 1 || item.gold.requiredQuestionFields.length || item.sideEffectPolicy !== 'zero_business_writes_before_confirmation')) throw new Error(`${item.caseId} supported金标非法`);
    if (item.gold.outcome === 'needs_clarification' && (!CLARIFICATION_SUBCATEGORIES.includes(item.subcategory) || !item.gold.requiredQuestionFields.length || item.sideEffectPolicy !== 'no_confirmation')) throw new Error(`${item.caseId} clarification金标非法`);
    if (item.gold.outcome === 'unsupported' && (!UNSUPPORTED_SUBCATEGORIES.includes(item.subcategory) || item.gold.acceptedDomains.length || item.gold.acceptedCapabilitySets.length || item.gold.requiredQuestionFields.length || item.sideEffectPolicy !== 'zero_everything')) throw new Error(`${item.caseId} unsupported金标非法`);
  }
  const splitCounts = countBy(fixture.cases, 'split', SPLITS);
  if (!same(splitCounts, { dev: 144, validation: 48, holdout: 48 })) throw new Error(`split配比非法 ${JSON.stringify(splitCounts)}`);
  const outcomeCounts = Object.fromEntries(OUTCOMES.map(outcome => [outcome, fixture.cases.filter(item => item.gold.outcome === outcome).length]));
  if (!same(outcomeCounts, { supported: 120, needs_clarification: 48, unsupported: 72 })) throw new Error(`outcome配比非法 ${JSON.stringify(outcomeCounts)}`);
  const supported = fixture.cases.filter(item => item.gold.outcome === 'supported');
  const supportedDomains = Object.fromEntries(DOMAINS.map(domain => [domain, supported.filter(item => item.gold.acceptedDomains[0] === domain).length]));
  if (!same(supportedDomains, { education: 72, finance: 16, retail: 32 })) throw new Error(`supported领域配比非法 ${JSON.stringify(supportedDomains)}`);
  for (const [domain, combinations] of Object.entries(registry)) for (const combination of combinations) if (!supported.some(item => item.gold.acceptedDomains[0] === domain && item.gold.acceptedCapabilitySets.some(set => same(set, combination)))) throw new Error(`未覆盖合法组合 ${domain}/${combination.join('+')}`);
  const clarificationCounts = countBy(fixture.cases.filter(item => item.gold.outcome === 'needs_clarification'), 'subcategory', CLARIFICATION_SUBCATEGORIES);
  if (Object.values(clarificationCounts).some(count => count !== 12)) throw new Error(`clarification子类配比非法 ${JSON.stringify(clarificationCounts)}`);
  const unsupportedCounts = countBy(fixture.cases.filter(item => item.gold.outcome === 'unsupported'), 'subcategory', UNSUPPORTED_SUBCATEGORIES);
  if (Object.values(unsupportedCounts).some(count => count !== 18)) throw new Error(`unsupported子类配比非法 ${JSON.stringify(unsupportedCounts)}`);
  const clusterCounts = new Map();
  for (const item of fixture.cases) clusterCounts.set(item.clusterId, (clusterCounts.get(item.clusterId) ?? 0) + 1);
  if ([...clusterCounts.values()].some(count => count !== 2)) throw new Error('每个语义cluster必须恰好2条');
  return { caseCount: fixture.cases.length, splitCounts, outcomeCounts, supportedDomains, clarificationCounts, unsupportedCounts, clusterCount: clusterCounts.size, crossSplitClusters: 0 };
}
