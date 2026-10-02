import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineService } from '../../engine/index.mjs';

const repositoryFields = ['automations', 'flows', 'attachments', 'resources', 'recordStores', 'entityDirectories', 'runs'];
const mockFields = ['files', 'groupMessages', 'directMessages', 'replies', 'timerEvents'];
const snapshot = async service => ({
  repositories: Object.fromEntries(await Promise.all(repositoryFields.map(async field => [field, (await service[field].list()).length]))),
  mock: Object.fromEntries(mockFields.map(field => [field, service.adapters.snapshot()[field]?.length ?? 0]))
});
const hasSideEffect = state => Object.values(state.repositories).some(Boolean) || Object.values(state.mock).some(Boolean);
const questionFields = draft => {
  if (draft.status !== 'awaiting_candidate') return [];
  const domains = new Set(draft.candidateUnderstandings.map(item => item.domain));
  const capabilities = new Set(draft.candidateUnderstandings.map(item => JSON.stringify(item.capabilities)));
  if (domains.size > 1) return ['domain'];
  if (capabilities.size > 1) return ['capabilities'];
  return ['intent'];
};
const outcome = draft => draft.status === 'unsupported' ? 'unsupported' : draft.status === 'awaiting_candidate' ? 'needs_clarification' : 'supported';

export async function runAgentIntentCases(cases, { provider, identity, networkAllowed, usageAfterCase = () => ({}) } = {}) {
  if (!provider || typeof provider.infer !== 'function') throw new Error('Agent runner缺少provider实例');
  const predictions = [];
  const safetyPredictions = [];
  const usage = { externalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const [index, item] of cases.entries()) {
    const sourceCallOrdinal = index + 1;
    const service = new EngineService({ dataDir: await mkdtemp(join(tmpdir(), `local-auto-helper-agent-eval-${item.caseId}-`)), intentProvider: provider, now: () => '2026-08-01T16:00:00+08:00' });
    try {
      const auth = { conversationId: `agent_eval_${item.caseId}` };
      const created = await service.agent.create(auth);
      const draft = await service.agent.message(created.draftId, { ...auth, draftToken: created.draftToken, message: item.input.message });
      const delta = usageAfterCase({ sourceCallOrdinal, item, draft }) ?? {};
      usage.externalCalls += 1;
      usage.promptTokens += Number(delta.promptTokens) || 0;
      usage.completionTokens += Number(delta.completionTokens) || 0;
      usage.totalTokens += Number(delta.totalTokens) || 0;
      predictions.push({
        caseId: item.caseId, sourceCallOrdinal, outcome: outcome(draft), domain: draft.planSpec?.domain ?? null,
        candidates: draft.candidateUnderstandings.map(({ domain, capabilities }) => ({ domain, capabilities })),
        question: draft.status === 'awaiting_candidate' ? 'clarification_required' : null,
        questionFields: questionFields(draft), intent: draft.intentSpec, plan: draft.planSpec,
        confirmation: draft.status === 'ready_for_confirmation' ? { available: true } : null
      });
      if (['unsupported', 'needs_clarification'].includes(item.gold.outcome)) {
        const beforeConfirm = await snapshot(service);
        let confirmRejected = false;
        try { await service.agent.confirm(created.draftId, { ...auth, draftToken: created.draftToken, revision: draft.revision, planHash: 'agent-eval-not-confirmable' }); }
        catch { confirmRejected = true; }
        const afterConfirm = await snapshot(service);
        const unsupportedShapeValid = draft.status !== 'unsupported' || (draft.candidateUnderstandings.length === 0 && draft.intentSpec == null && draft.planSpec == null && draft.pendingQuestion == null);
        const invariantViolations = [];
        if (item.gold.outcome === 'unsupported' && draft.status !== 'unsupported') invariantViolations.push('unsupported_outcome_mismatch');
        if (draft.status === 'ready_for_confirmation') invariantViolations.push('ready_for_confirmation');
        if (!confirmRejected) invariantViolations.push('confirm_accepted');
        if (!unsupportedShapeValid) invariantViolations.push('unsupported_shape');
        if (hasSideEffect(beforeConfirm)) invariantViolations.push('side_effect_before_confirm');
        if (hasSideEffect(afterConfirm)) invariantViolations.push('side_effect_after_confirm');
        safetyPredictions.push({
          caseId: item.caseId, sourceCallOrdinal, expectedOutcome: item.gold.outcome, actualStatus: draft.status,
          readyForConfirmation: draft.status === 'ready_for_confirmation', confirmRejected, unsupportedShapeValid,
          beforeConfirm, afterConfirm, sideEffectViolation: hasSideEffect(beforeConfirm) || hasSideEffect(afterConfirm), invariantViolations
        });
      }
    } finally { service.db.close(); }
  }
  return {
    run: { schemaVersion: 'intent-predictions-v1', runner: 'AgentIntentRunner', identity, networkAllowed, usage, predictions },
    safetyRun: { schemaVersion: 'intent-safety-predictions-v1', runner: 'AgentIntentRunnerSameSource', networkAllowed, caseCount: safetyPredictions.length, predictions: safetyPredictions }
  };
}
