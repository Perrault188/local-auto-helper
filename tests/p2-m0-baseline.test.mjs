import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = async name => JSON.parse(await readFile(new URL(`../fixtures/p2-m0/${name}`, import.meta.url), 'utf8'));

test('P2-M0多轮对话基线包含36条唯一且可判定的设计', async () => {
  const data = await load('dialogue-baseline.json');
  assert.equal(data.schemaVersion, 'p2-m0-v1');
  assert.equal(data.cases.length, 36);
  assert.equal(new Set(data.cases.map(item => item.caseId)).size, 36);
  assert.equal(new Set(data.cases.map(item => item.opening.trim())).size, 36);
  const allowedModes = new Set(['option', 'self_input', 'mixed', 'none']);
  const allowedTerminals = new Set(['ready_for_confirmation', 'needs_clarification', 'cancelled', 'awaiting_answer', 'unsupported', 'succeeded_no_action']);
  for (const item of data.cases) {
    assert.match(item.caseId, /^dlg-\d{3}$/);
    assert.equal(typeof item.opening, 'string');
    assert.ok(item.opening.length > 1);
    assert.ok(Array.isArray(item.expectedCapabilities));
    assert.ok(allowedModes.has(item.answerMode));
    assert.ok(allowedTerminals.has(item.expectedTerminal));
  }
  assert.ok(data.cases.some(item => item.answerMode === 'option'));
  assert.ok(data.cases.some(item => item.answerMode === 'self_input'));
  assert.ok(data.cases.some(item => item.answerMode === 'mixed'));
  assert.ok(data.cases.some(item => item.kind === 'unsupported'));
  assert.ok(data.cases.some(item => item.interaction === 'refresh_at_question'));
  assert.ok(data.cases.some(item => item.interaction === 'all_submitted_before_timer'));
  const counts = Object.fromEntries([...new Set(data.cases.map(item => item.kind))].map(kind => [kind, data.cases.filter(item => item.kind === kind).length]));
  assert.equal(counts.short, 5);
  assert.equal(counts.colloquial, 5);
  assert.equal(counts.combined, 5);
  assert.equal(counts.clarification, 3);
  assert.equal(counts.unsupported, 4);
  assert.ok(data.cases.filter(item => item.expectedTerminal === 'unsupported').length >= 6);
});

test('P2-M0班委Mock目标场景覆盖完整动作链和空名单变体', async () => {
  const data = await load('class-committee-mock-baseline.json');
  assert.equal(data.schemaVersion, 'p2-m0-v1');
  assert.deepEqual(data.task.capabilities, ['publish', 'collect', 'remind']);
  assert.equal(data.roster.length, 5);
  assert.equal(new Set(data.roster.map(item => item.userId)).size, 5);
  assert.equal(new Set(data.events.map(item => item.eventId)).size, data.events.length);
  const actionSet = new Set(data.events.flatMap(item => item.expectedActions));
  for (const action of ['send_group_message_and_file', 'match_person', 'rename_received_file', 'mark_submission', 'reply_to_sender', 'read_unsubmitted', 'build_recipient_list', 'send_direct_message_batch', 'report_to_user']) assert.ok(actionSet.has(action), action);
  assert.equal(data.events.filter(item => item.type === 'direct_file_received').length, 3);
  assert.equal(data.expected.renamedFiles.length, 2);
  assert.equal(data.expected.submittedUserIds.length + data.expected.pendingUserIds.length, data.roster.length);
  assert.equal(data.expected.userReport.submitted, data.expected.submittedUserIds.length);
  assert.equal(data.expected.userReport.pending, data.expected.pendingUserIds.length);
  assert.equal(data.expected.allSubmittedVariant.status, 'succeeded_no_action');
  assert.match(data.expected.allSubmittedVariant.explanation, /全部已交/);
  assert.equal(data.expected.duplicateBusinessEffects, 0);
});

test('P2-M0 UI基线为每个要求提供独立可执行探针定义', async () => {
  const data = await load('ui-baseline.json');
  assert.equal(data.schemaVersion, 'p2-m0-v1');
  assert.equal(data.checks.length, 8);
  assert.equal(new Set(data.checks.map(item => item.checkId)).size, 8);
  for (const item of data.checks) {
    assert.equal(item.probe, 'source');
    assert.ok(item.requiredPatterns.length > 0);
  }
});

test('P2-M0 fixture不含密钥、真实邮箱、URL凭据或非合成手机号', async () => {
  const names = ['dialogue-baseline.json', 'class-committee-mock-baseline.json', 'ui-baseline.json'];
  for (const name of names) {
    const text = await readFile(new URL(`../fixtures/p2-m0/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /(?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*["'][^"']+/i, name);
    assert.doesNotMatch(text, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, name);
    assert.doesNotMatch(text, /https?:\/\/[^\s"']+@/i, name);
    assert.doesNotMatch(text, /(?<!\d)1[3-9]\d{9}(?!\d)/, name);
  }
});
