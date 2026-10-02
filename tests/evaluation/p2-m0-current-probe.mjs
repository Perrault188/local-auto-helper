import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineService, RuleBasedProvider } from '../../engine/index.mjs';

const root = new URL('../..', import.meta.url);
const loadText = name => readFile(new URL(name, root), 'utf8');
const loadJson = async name => JSON.parse(await loadText(name));
const [app, styles, eventSchema, ui, mock] = await Promise.all([
  loadText('prototype/app.js'),
  loadText('prototype/styles.css'),
  loadText('contracts/mock-event.schema.json'),
  loadJson('fixtures/p2-m0/ui-baseline.json'),
  loadJson('fixtures/p2-m0/class-committee-mock-baseline.json')
]);
const uiSource = `${app}\n${styles}`;
const results = ui.checks.map(check => {
  const missing = check.requiredPatterns.filter(pattern => !uiSource.includes(pattern));
  return { checkId: check.checkId, label: check.label, status: missing.length ? 'fail' : 'pass', missing };
});
const capabilityChecks = [
  ['mock-group-notification', 'Mock群聊通知', mock.currentSupport.groupNotification],
  ['mock-private-file', '私聊交文件', eventSchema.includes('direct_file_received')],
  ['mock-identity-match', '名单匹配', mock.currentSupport.identityMatch],
  ['mock-rename-store', '改名保存', mock.currentSupport.renameAndStore],
  ['mock-registration-receipt', '登记回执', mock.currentSupport.submissionRegistration && mock.currentSupport.receiptVisible],
  ['mock-reminder', '到点催交', mock.currentSupport.reminderTextVisible],
  ['mock-no-action', '空未交名单解释', mock.currentSupport.noActionExplanation],
  ['mock-renamed-inventory', '改名文件清单', mock.currentSupport.renamedFileInventory],
  ['mock-user-report', '给用户汇报', mock.currentSupport.userReport]
].map(([checkId, label, passed]) => ({ checkId, label, status: passed ? 'pass' : 'fail' }));
results.push(...capabilityChecks);

const repositoryNames = ['automations', 'flows', 'attachments', 'resources', 'recordStores', 'entityDirectories', 'runs'];
const snapshot = async service => ({
  repositories: Object.fromEntries(await Promise.all(repositoryNames.map(async name => [name, await service[name].list()]))),
  mock: service.adapters.snapshot()
});
const noSideEffects = state => Object.values(state.repositories).every(items => items.length === 0)
  && Object.values(state.mock).every(items => Array.isArray(items) && items.length === 0);

async function probeSafeDialogue(item) {
  const dataDir = await mkdtemp(join(tmpdir(), `local-auto-helper-p2-m0-${item.caseId}-`));
  const service = new EngineService({ dataDir, intentProvider: new RuleBasedProvider(), now: () => '2026-08-01T16:00:00+08:00' });
  try {
    const auth = { conversationId: `p2_m0_${item.caseId}` };
    const created = await service.agent.create(auth);
    const draft = await service.agent.message(created.draftId, { ...auth, draftToken: created.draftToken, message: item.opening });
    const state = await snapshot(service);
    let confirmationRejected = false;
    try {
      await service.agent.confirm(created.draftId, { ...auth, draftToken: created.draftToken, revision: draft.revision, planHash: 'not-confirmable' });
    } catch {
      confirmationRejected = true;
    }
    const expectedStatuses = item.expectedTerminal === 'needs_clarification' ? ['awaiting_candidate', 'awaiting_answer'] : ['unsupported'];
    const passed = expectedStatuses.includes(draft.status)
      && draft.status !== 'ready_for_confirmation'
      && confirmationRejected
      && noSideEffects(state);
    return {
      checkId: `dialogue-${item.caseId}`,
      label: `${item.expectedTerminal}安全基线`,
      status: passed ? 'pass' : 'fail',
      expectedTerminal: item.expectedTerminal,
      actualStatus: draft.status,
      confirmationRejected,
      noBusinessOrMockSideEffects: noSideEffects(state),
      counts: {
        repositories: Object.fromEntries(Object.entries(state.repositories).map(([name, items]) => [name, items.length])),
        mock: Object.fromEntries(Object.entries(state.mock).map(([name, items]) => [name, items.length]))
      }
    };
  } finally {
    service.db.close();
  }
}

try {
  const dialogue = await loadJson('fixtures/p2-m0/dialogue-baseline.json');
  for (const item of dialogue.cases.filter(item => ['needs_clarification', 'unsupported'].includes(item.expectedTerminal))) {
    results.push(await probeSafeDialogue(item));
  }
  const pass = results.filter(item => item.status === 'pass').length;
  const fail = results.length - pass;
  console.log(JSON.stringify({
    schemaVersion: 'p2-m0-probe-v1',
    policy: 'exit 0 means all current probes pass; exit 2 means known product gaps were captured; exit 1 means probe error',
    summary: { total: results.length, pass, fail },
    results
  }, null, 2));
  if (fail) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ schemaVersion: 'p2-m0-probe-v1', probeError: error.message }, null, 2));
  process.exitCode = 1;
}
