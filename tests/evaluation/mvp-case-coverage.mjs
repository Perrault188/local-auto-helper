import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EngineService,
  RuleBasedProvider,
  planHash,
  validateCreateAutomationTaskInput,
  validateEvent
} from '../../engine/index.mjs';

const fixture = JSON.parse(await readFile(new URL('../../fixtures/evaluation/mvp-case-coverage.json', import.meta.url), 'utf8'));
const now = () => '2026-08-01T16:00:00+08:00';
const dataDir = () => mkdtemp(join(tmpdir(), 'local-auto-helper-mvp-case-coverage-'));
const businessCounts = async service => Object.fromEntries(await Promise.all(
  ['automations', 'attachments', 'flows', 'resources', 'recordStores', 'entityDirectories', 'runs']
    .map(async name => [name, (await service[name].list()).length])
));
const zeroBusiness = counts => Object.values(counts).every(value => value === 0);

async function evaluateClassCommittee() {
  const input = fixture.classCommittee;
  const service = new EngineService({ dataDir: await dataDir(), now });
  const created = await service.agent.create({ conversationId: 'evaluation_class_committee' });
  let draft = await service.agent.message(created.draftId, {
    conversationId: 'evaluation_class_committee',
    draftToken: created.draftToken,
    message: input.message
  });
  if (draft.status === 'awaiting_candidate') {
    const candidate = draft.candidateUnderstandings.find(item =>
      JSON.stringify(item.capabilities) === JSON.stringify(input.selectedCapabilities)
    );
    assert.ok(candidate, '班委候选应包含collect+remind');
    draft = await service.agent.chooseCandidate(created.draftId, {
      conversationId: 'evaluation_class_committee',
      draftToken: created.draftToken,
      candidateId: candidate.candidateId
    });
  } else {
    assert.equal(draft.status, 'awaiting_answer');
    assert.deepEqual(draft.planSpec?.capabilities, input.selectedCapabilities);
  }
  draft = await service.agent.message(created.draftId, {
    conversationId: 'evaluation_class_committee',
    draftToken: created.draftToken,
    trustedContext: input.trustedContext
  });
  assert.equal(draft.status, 'ready_for_confirmation');
  const beforeConfirm = await businessCounts(service);
  assert.equal(zeroBusiness(beforeConfirm), true, '班委确认前业务仓库必须零写入');
  const confirmed = await service.agent.confirm(created.draftId, {
    conversationId: 'evaluation_class_committee',
    draftToken: created.draftToken,
    revision: draft.revision,
    planHash: planHash(draft.planSpec)
  });
  const submitRuns = await service.dispatch(input.submitEvent);
  const duplicateRuns = await service.dispatch(input.submitEvent);
  const remindRuns = await service.dispatch(input.remindEvent);
  const state = {
    automation: await service.automations.get(confirmed.automationId),
    flows: await service.flows.list(),
    runs: await service.runs.list(),
    attachments: await service.attachments.list(),
    adapters: service.adapters.snapshot()
  };
  const member = state.attachments[0].members.find(item => item.userId === '8200010001');
  const pending = state.attachments[0].members.find(item => item.userId === '8200010002');
  const portableMemberPath = member?.filePath?.replaceAll('\\', '/') ?? '';
  const passed = state.automation?.domain === 'education'
    && confirmed.draft.status === 'compiled'
    && state.flows.length === 2
    && state.runs.length === 2
    && submitRuns[0]?.status === 'succeeded'
    && duplicateRuns[0]?.runId === submitRuns[0]?.runId
    && remindRuns[0]?.status === 'succeeded'
    && member?.submissionStatus === 'submitted'
    && portableMemberPath.startsWith('/demo/submissions/task_')
    && portableMemberPath.endsWith('/MOCK001_合成成员甲.pdf')
    && pending?.reminderStatus === 'sent'
    && state.adapters.replies.length === 1
    && state.adapters.directMessages.length === 1;
  const result = {
    caseId: input.caseId,
    expected: 'supported',
    actual: passed ? 'supported' : 'failed',
    beforeConfirm,
    compiled: confirmed.draft.status === 'compiled',
    flowCount: state.flows.length,
    runCount: state.runs.length,
    mockReplyCount: state.adapters.replies.length,
    mockDirectMessageCount: state.adapters.directMessages.length,
    duplicateIdempotent: duplicateRuns[0]?.runId === submitRuns[0]?.runId,
    submitRunStatus: submitRuns[0]?.status ?? null,
    remindRunStatus: remindRuns[0]?.status ?? null,
    submittedMemberStatus: member?.submissionStatus ?? null,
    submittedMemberFilePath: member?.filePath ?? null,
    pendingMemberReminderStatus: pending?.reminderStatus ?? null
  };
  service.db.close();
  return result;
}

async function evaluateLotteryMessages() {
  const provider = new RuleBasedProvider();
  const results = [];
  for (const [index, message] of fixture.lotteryBoundary.messages.entries()) {
    const service = new EngineService({ dataDir: await dataDir(), now, intentProvider: provider });
    const created = await service.agent.create({ conversationId: `evaluation_lottery_${index}` });
    const draft = await service.agent.message(created.draftId, {
      conversationId: `evaluation_lottery_${index}`,
      draftToken: created.draftToken,
      message
    });
    const counts = await businessCounts(service);
    const candidates = draft.candidateUnderstandings.map(item => ({
      domain: item.domain,
      capabilities: item.capabilities
    }));
    const incorrectlyMapped = candidates.some(item => ['education', 'finance', 'retail'].includes(item.domain));
    results.push({
      messageIndex: index + 1,
      expected: 'unsupported',
      actual: incorrectlyMapped ? 'incorrect_mapping' : 'unsupported',
      fallbackReason: draft.fallbackReason,
      status: draft.status,
      candidates,
      businessCounts: counts,
      zeroBusinessWrites: zeroBusiness(counts),
      mockActionCount: Object.values(service.adapters.snapshot()).reduce((sum, items) => sum + items.length, 0)
    });
    service.db.close();
  }
  return results;
}

function evaluateProtocolBoundaries() {
  const output = {};
  try {
    validateCreateAutomationTaskInput(fixture.lotteryBoundary.unsupportedCreationInput);
    output.unknownDomain = 'accepted';
  } catch (error) {
    output.unknownDomain = 'rejected';
    output.unknownDomainError = error.message;
  }
  try {
    validateEvent(fixture.lotteryBoundary.unsupportedEvent);
    output.unknownEvent = 'accepted';
  } catch (error) {
    output.unknownEvent = 'rejected';
    output.unknownEventError = error.message;
  }
  return output;
}

const report = {
  schemaVersion: fixture.schemaVersion,
  provider: 'rule-based',
  externalCalls: 0,
  classCommittee: await evaluateClassCommittee(),
  lotteryAgent: await evaluateLotteryMessages(),
  lotteryProtocol: evaluateProtocolBoundaries()
};
const lotterySafelyUnsupported = report.lotteryAgent.every(item =>
  item.actual === 'unsupported' && item.zeroBusinessWrites && item.mockActionCount === 0
);
report.summary = {
  classCommitteePassed: report.classCommittee.actual === 'supported',
  lotterySafelyUnsupported,
  lotteryBoundaryGap: !lotterySafelyUnsupported,
  evaluationPassed: report.classCommittee.actual === 'supported' && lotterySafelyUnsupported
};
console.log(JSON.stringify(report, null, 2));
if (!report.summary.evaluationPassed) process.exitCode = 2;
