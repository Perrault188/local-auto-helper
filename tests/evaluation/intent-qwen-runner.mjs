import { QwenDashScopeProvider } from '../../engine/index.mjs';
import { AGENT_SPEC_VERSION } from '../../engine/agent/specs.mjs';
import { REGISTRY_VERSION } from '../../engine/agent/registry.mjs';
import { validateIntentGoldFixture } from './intent-gold-schema.mjs';
import { loadIntentGold } from './intent-gold-loader.mjs';
import { scoreIntentPredictions } from './intent-scorer.mjs';
import { runAgentIntentCases } from './intent-agent-runner.mjs';

async function main() {
  if (!process.argv.includes('--allow-network')) throw new Error('Qwen runner需要显式--allow-network授权');
  if (!process.env.DASHSCOPE_API_KEY) throw new Error('Qwen runner缺少DASHSCOPE_API_KEY');
  const fixture = await loadIntentGold();
  validateIntentGoldFixture(fixture);
  let virtualClock = Date.now();
  const provider = new QwenDashScopeProvider({
    apiKey: process.env.DASHSCOPE_API_KEY,
    requestsPerMinute: 60,
    maxConcurrency: 1,
    clock: () => { virtualClock += 1100; return virtualClock; }
  });
  const identity = {
    provider: 'dashscope', model: provider.model,
    agentSpecVersion: AGENT_SPEC_VERSION,
    registryVersion: REGISTRY_VERSION,
    promptVersion: 'qwen-intent-v2',
    responseSchemaVersion: 'intent-result-v2'
  };
  const { run, safetyRun } = await runAgentIntentCases(fixture.cases, {
    provider, identity, networkAllowed: true,
    usageAfterCase: () => {
      const latest = provider.auditSummary().at(-1);
      if (!latest) throw new Error('Qwen调用缺少增量审计记录');
      return latest.usage;
    }
  });
  if (run.usage.externalCalls !== fixture.caseCount) throw new Error(`Qwen调用数异常 ${run.usage.externalCalls}/${fixture.caseCount}`);
  const report = scoreIntentPredictions(fixture, run, safetyRun);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 2;
}

main().catch(error => {
  console.error(JSON.stringify({ error: 'qwen_runner_error', message: error?.message ?? String(error) }));
  process.exitCode = 1;
});
