import { validateIntentGoldFixture } from './intent-gold-schema.mjs';
import { runRuleCases } from './intent-rule-runner.mjs';
import { scoreIntentPredictions } from './intent-scorer.mjs';
import { loadIntentGold } from './intent-gold-loader.mjs';
import { runIntentSafetyCases } from './intent-safety-runner.mjs';

async function main() {
  const fixture = await loadIntentGold();
  validateIntentGoldFixture(fixture);
  const [run, safetyRun] = await Promise.all([runRuleCases(fixture.cases), runIntentSafetyCases(fixture.cases)]);
  const report = scoreIntentPredictions(fixture, run, safetyRun);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 2;
}

main().catch(error => {
  console.error(JSON.stringify({ error: 'evaluation_script_error', message: error?.message ?? String(error) }));
  process.exitCode = 1;
});
