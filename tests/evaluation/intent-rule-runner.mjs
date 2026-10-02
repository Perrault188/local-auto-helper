import { RuleBasedProvider } from '../../engine/index.mjs';
import { analyzeRegisteredClarification } from '../../engine/agent/coverage.mjs';

export async function runRuleCases(cases) {
  const provider = new RuleBasedProvider();
  const predictions = [];
  for (const item of cases) {
    const actual = await provider.infer({
      message: item.input.message,
      trustedContext: item.input.trustedDomainHint ? { domain: item.input.trustedDomainHint } : {}
    });
    const clarification = analyzeRegisteredClarification(item.input.message, item.input.trustedDomainHint);
    predictions.push({
      caseId: item.caseId,
      outcome: actual.outcome,
      domain: null,
      candidates: (actual.candidates ?? []).map(({ domain, capabilities }) => ({ domain, capabilities })),
      question: actual.question ?? null,
      questionFields: actual.outcome === 'needs_clarification' && clarification ? [clarification.field] : [],
      intent: null,
      plan: null,
      confirmation: null
    });
  }
  return {
    schemaVersion: 'intent-predictions-v1',
    runner: 'RuleBasedProvider',
    identity: { provider: 'rule', version: 'p1b-v2' },
    usage: { externalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    networkAllowed: false,
    predictions
  };
}
