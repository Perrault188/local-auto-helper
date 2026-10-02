import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EngineService, RuleBasedProvider } from '../../engine/index.mjs';
import { loadIntentGold } from './intent-gold-loader.mjs';

const repositoryFields = ['automations', 'flows', 'attachments', 'resources', 'recordStores', 'entityDirectories', 'runs'];
const mockFields = ['files', 'groupMessages', 'directMessages', 'replies', 'timerEvents'];

async function snapshot(service) {
  const repositories = Object.fromEntries(await Promise.all(repositoryFields.map(async field => [field, (await service[field].list()).length])));
  const rawMock = service.adapters.snapshot();
  const mock = Object.fromEntries(mockFields.map(field => [field, Array.isArray(rawMock[field]) ? rawMock[field].length : null]));
  return { repositories, mock };
}

const hasSideEffect = state => Object.values(state.repositories).some(count => count !== 0)
  || Object.values(state.mock).some(count => count !== 0);

export async function runIntentSafetyCases(cases) {
  const selected = cases.filter(item => ['unsupported', 'needs_clarification'].includes(item.gold.outcome));
  const predictions = [];
  for (const item of selected) {
    const dataDir = await mkdtemp(join(tmpdir(), `local-auto-helper-intent-safety-${item.caseId}-`));
    const service = new EngineService({ dataDir, intentProvider: new RuleBasedProvider(), now: () => '2026-08-01T16:00:00+08:00' });
    try {
      const auth = { conversationId: `intent_safety_${item.caseId}` };
      const created = await service.agent.create(auth);
      let inferenceError = null;
      let draft;
      try {
        draft = await service.agent.message(created.draftId, { ...auth, draftToken: created.draftToken, message: item.input.message });
      } catch (error) {
        inferenceError = error?.message ?? String(error);
        draft = await service.agent.get(created.draftId, { ...auth, draftToken: created.draftToken });
      }
      const beforeConfirm = await snapshot(service);
      let confirmRejected = false;
      let confirmError = null;
      try {
        await service.agent.confirm(created.draftId, {
          ...auth,
          draftToken: created.draftToken,
          revision: draft.revision,
          planHash: 'p2-m0-not-confirmable'
        });
      } catch (error) {
        confirmRejected = true;
        confirmError = error?.message ?? String(error);
      }
      const afterConfirm = await snapshot(service);
      const unsupportedShapeValid = draft.status !== 'unsupported' || (
        inferenceError == null
        && draft.candidateUnderstandings.length === 0
        && draft.intentSpec == null
        && draft.planSpec == null
        && draft.pendingQuestion == null
      );
      const invariantViolations = [];
      if (inferenceError) invariantViolations.push('inference_error');
      if (item.gold.outcome === 'unsupported' && draft.status !== 'unsupported') invariantViolations.push('unsupported_outcome_mismatch');
      if (draft.status === 'ready_for_confirmation') invariantViolations.push('ready_for_confirmation');
      if (!confirmRejected) invariantViolations.push('confirm_accepted');
      if (!unsupportedShapeValid) invariantViolations.push('unsupported_shape');
      if (hasSideEffect(beforeConfirm)) invariantViolations.push('side_effect_before_confirm');
      if (hasSideEffect(afterConfirm)) invariantViolations.push('side_effect_after_confirm');
      predictions.push({
        caseId: item.caseId,
        expectedOutcome: item.gold.outcome,
        actualStatus: inferenceError ? 'inference_error' : draft.status,
        inferenceError,
        readyForConfirmation: draft.status === 'ready_for_confirmation',
        confirmRejected,
        confirmError,
        unsupportedShapeValid,
        beforeConfirm,
        afterConfirm,
        sideEffectViolation: hasSideEffect(beforeConfirm) || hasSideEffect(afterConfirm),
        invariantViolations
      });
    } finally {
      service.db.close();
    }
  }
  return {
    schemaVersion: 'intent-safety-predictions-v1',
    runner: 'EngineServiceRuleSafety',
    networkAllowed: false,
    caseCount: predictions.length,
    predictions
  };
}

async function main() {
  const fixture = await loadIntentGold();
  const report = await runIntentSafetyCases(fixture.cases);
  const violations = report.predictions.filter(item => item.invariantViolations.length);
  console.log(JSON.stringify({
    ...report,
    summary: {
      total: report.caseCount,
      passed: report.caseCount - violations.length,
      failed: violations.length,
      sideEffectViolations: report.predictions.filter(item => item.sideEffectViolation).length
    },
    violations
  }, null, 2));
  if (violations.length) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ error: 'intent_safety_runner_error', message: error?.message ?? String(error) }));
  process.exitCode = 1;
});
