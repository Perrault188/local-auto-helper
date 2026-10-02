import test from 'node:test';
import assert from 'node:assert/strict';
import { QwenDashScopeProvider, AgentOrchestrator } from '../engine/index.mjs';

const secret = 'dashscope-secret-must-not-leak';
const response = value => ({ ok: true, headers: { get() { return null; } }, async text() { return JSON.stringify(value); }, async json() { return value; } });
const validContent = JSON.stringify({ candidates: [{ domain: 'finance', goal: '收取财务单据', capabilities: ['collect'], assumptions: [], confidence: 0.9 }], question: null });

test('Qwen provider使用最小OpenAI兼容请求并解析受控JSON', async () => {
  let captured;
  const provider = new QwenDashScopeProvider({
    apiKey: secret, baseUrl: 'https://dashscope-intl.aliyuncs.com/v1/', model: 'qwen3.7-plus',
    fetchImpl: async (url, options) => { captured = { url, options }; return response({ choices: [{ message: { content: validContent } }] }); }
  });
  const result = await provider.infer({
    message: '帮我收单据', trustedContext: { domain: 'finance', roster: [{ userId: 'should-not-send' }] },
    draftToken: 'never-send', conversationId: 'never-send'
  });
  assert.equal(result.candidates[0].domain, 'finance');
  assert.equal(captured.url, 'https://dashscope-intl.aliyuncs.com/v1/chat/completions');
  const body = JSON.parse(captured.options.body);
  assert.equal(body.temperature, 0.1);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.enable_thinking, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const serialized = captured.options.body;
  assert.doesNotMatch(serialized, /should-not-send|never-send|draftToken|conversationId/);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(captured.options.headers.authorization, `Bearer ${secret}`);
  const prompt = body.messages[0].content;
  assert.match(prompt, /supported/);
  assert.match(prompt, /needs_clarification/);
  assert.match(prompt, /unsupported/);
});

test('非2xx、恶意Schema与网络错误只返回安全结构化错误码', async () => {
  const cases = [
    { fetchImpl: async () => ({ ok: false, status: 401, async text() { throw new Error('body must not be read'); } }), code: 'provider_http_auth_error' },
    { fetchImpl: async () => response({ choices: [{ message: { content: JSON.stringify({ hook: { code: secret }, candidates: [{}, {}] }) } }] }), code: 'provider_schema_invalid' },
    { fetchImpl: async () => { throw new Error(`network ${secret}`); }, code: 'provider_network_error' }
  ];
  for (const item of cases) {
    const provider = new QwenDashScopeProvider({ apiKey: secret, fetchImpl: item.fetchImpl });
    await assert.rejects(provider.infer({ message: '测试' }), error => {
      assert.equal(error.code, item.code);
      assert.doesNotMatch(`${error.message}${error.stack}`, new RegExp(secret));
      return true;
    });
  }
});

test('AbortController真实超时并清理为provider_timeout', async () => {
  let aborted = false;
  const provider = new QwenDashScopeProvider({
    apiKey: secret, timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    })
  });
  await assert.rejects(provider.infer({ message: '测试' }), error => error.code === 'provider_timeout');
  assert.equal(aborted, true);
});

test('Orchestrator对远程失败记录fallbackReason并使用规则provider', async () => {
  const provider = new QwenDashScopeProvider({ apiKey: secret, fetchImpl: async () => ({ ok: false }) });
  const orchestrator = new AgentOrchestrator({ provider });
  const result = await orchestrator.infer({ message: '收财务单据', trustedContext: { domain: 'finance' } });
  assert.equal(result.fallbackReason, 'provider_http_error');
  assert.equal(result.candidates[0].domain, 'finance');
});

test('provider状态不包含密钥，无配置明确为规则模式', () => {
  assert.deepEqual(new QwenDashScopeProvider().status(), { mode: 'rule', configured: false, provider: 'dashscope', model: null });
  assert.deepEqual(new QwenDashScopeProvider({ apiKey: secret }).status(), { mode: 'remote', configured: true, provider: 'dashscope', model: 'qwen3.7-plus-2026-05-26' });
  assert.doesNotMatch(JSON.stringify(new QwenDashScopeProvider({ apiKey: secret }).status()), new RegExp(secret));
});

test('max_tokens安全范围、usage与内存审计均不含敏感数据', async () => {
  const provider = new QwenDashScopeProvider({
    apiKey: secret, baseUrl: 'https://workspace-secret.maas.aliyuncs.com/v1', maxTokens: 99999,
    fetchImpl: async () => response({ choices: [{ message: { content: validContent } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })
  });
  await provider.infer({ message: 'SENSITIVE_USER_MESSAGE', conversationId: 'SENSITIVE_CONVERSATION' });
  const status = provider.status();
  const audit = provider.auditSummary();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].maxTokens, 512);
  assert.deepEqual(audit[0].usage, { promptTokens: 12, completionTokens: 8, totalTokens: 20 });
  const serialized = JSON.stringify({ status, audit });
  assert.doesNotMatch(serialized, /workspace-secret|SENSITIVE_USER_MESSAGE|SENSITIVE_CONVERSATION|dashscope-secret/);
  assert.equal(audit[0].endpointRegion, 'maas-dashscope');
});

test('并发与RPM超限直接provider_budget_exceeded且不发起重试', async () => {
  let release;
  let calls = 0;
  const firstResponse = new Promise(resolve => { release = () => resolve(response({ choices: [{ message: { content: validContent } }] })); });
  const concurrent = new QwenDashScopeProvider({ apiKey: secret, maxConcurrency: 1, fetchImpl: async () => { calls++; return firstResponse; } });
  const first = concurrent.infer({ message: 'first' });
  await assert.rejects(concurrent.infer({ message: 'second' }), error => error.code === 'provider_budget_exceeded');
  assert.equal(calls, 1);
  release(); await first;

  calls = 0;
  const rpm = new QwenDashScopeProvider({ apiKey: secret, requestsPerMinute: 1, clock: () => 1000, fetchImpl: async () => { calls++; return response({ choices: [{ message: { content: validContent } }] }); } });
  await rpm.infer({ message: 'first' });
  await assert.rejects(rpm.infer({ message: 'second' }), error => error.code === 'provider_budget_exceeded');
  assert.equal(calls, 1);
  assert.equal(rpm.auditSummary().at(-1).fallbackCode, 'provider_budget_exceeded');
});

test('内存审计最多保留50条且不会持久化请求内容', async () => {
  let time = 0;
  const provider = new QwenDashScopeProvider({
    apiKey: secret, requestsPerMinute: 60, clock: () => time++,
    fetchImpl: async () => response({ choices: [{ message: { content: validContent } }] })
  });
  for (let index = 0; index < 55; index++) await provider.infer({ message: `private-${index}` });
  assert.equal(provider.auditSummary().length, 50);
  assert.doesNotMatch(JSON.stringify(provider.auditSummary()), /private-/);
});

test('Base URL白名单、HTTP细分和响应体上限在fetch或解析前拦截', async () => {
  for (const baseUrl of ['http://dashscope.aliyuncs.com/v1', 'https://evil.example/v1', 'https://dashscope.aliyuncs.com.evil/v1']) {
    let calls = 0;
    const provider = new QwenDashScopeProvider({ apiKey: secret, baseUrl, fetchImpl: async () => { calls++; return response({}); } });
    await assert.rejects(provider.infer({ message: 'x' }), error => error.code === 'provider_base_url_not_allowed');
    assert.equal(calls, 0);
  }
  for (const [status, code] of [[401, 'provider_http_auth_error'], [429, 'provider_http_rate_limited'], [500, 'provider_http_server_error']]) {
    const provider = new QwenDashScopeProvider({ apiKey: secret, fetchImpl: async () => ({ ok: false, status, async text() { throw new Error('不得读取错误正文'); } }) });
    await assert.rejects(provider.infer({ message: 'x' }), error => error.code === code);
  }
  const oversized = new QwenDashScopeProvider({ apiKey: secret, fetchImpl: async () => ({ ok: true, headers: { get: () => '70000' }, async text() { throw new Error('长度超限时不得读取'); } }) });
  await assert.rejects(oversized.infer({ message: 'x' }), error => error.code === 'provider_response_too_large');
});

test('财务合法Schema也不能把混合付款目标静默收窄', async () => {
  const content = JSON.stringify({ candidates: [{ domain: 'finance', goal: '自动审核并付款入账', capabilities: ['collect'], assumptions: [], confidence: 0.9 }], question: null });
  const provider = new QwenDashScopeProvider({ apiKey: secret, fetchImpl: async () => response({ model: 'qwen3.7-plus', choices: [{ message: { content } }] }) });
  const result = await new AgentOrchestrator({ provider }).infer({ message: '收报销单并自动付款', trustedContext: { domain: 'finance' } });
  assert.equal(result.outcome, 'unsupported');
  assert.equal(result.reasonCode, 'mixed_supported_and_unsupported_operations');
});

test('正常finance收件仍规范化为待审核边界', async () => {
  const content = JSON.stringify({ outcome: 'supported', candidates: [{ domain: 'finance', goal: '收取财务单据', capabilities: ['collect'], assumptions: ['模型原假设'], confidence: 0.9 }], question: null });
  const provider = new QwenDashScopeProvider({ apiKey: secret, fetchImpl: async () => response({ choices: [{ message: { content } }] }) });
  const result = await new AgentOrchestrator({ provider }).infer({ message: '收取财务单据', trustedContext: { domain: 'finance' } });
  assert.equal(result.candidates[0].goal, '收取单据并进入待审核清单');
  assert.ok(result.candidates[0].assumptions.includes('必须人工审核，不自动审核、付款或入账'));
});

test('actualModel仅记录匹配的安全快照，异常model标记model_mismatch', async () => {
  for (const [actualModel, expectedModel, expectedResult, expectedCode] of [
    ['qwen3.7-plus-2026-05-26', 'qwen3.7-plus-2026-05-26', 'success', null],
    ['qwen3.7-plus-2026-05-26-build1', 'qwen3.7-plus-2026-05-26-build1', 'success', null],
    ['workspace/private-model', 'qwen3.7-plus-2026-05-26', 'fallback', 'model_mismatch'],
    ['other-safe-model', 'qwen3.7-plus-2026-05-26', 'fallback', 'model_mismatch']
  ]) {
    const provider = new QwenDashScopeProvider({
      apiKey: secret,
      fetchImpl: async () => response({ model: actualModel, choices: [{ message: { content: validContent } }] })
    });
    await provider.infer({ message: '测试' });
    const entry = provider.auditSummary()[0];
    assert.equal(entry.model, expectedModel);
    assert.equal(entry.result, expectedResult);
    assert.equal(entry.fallbackCode, expectedCode);
    assert.doesNotMatch(JSON.stringify(entry), /workspace\/private-model/);
  }
});

test('“提醒我”远程返回未注册组合时严格拒绝，规则降级仍为单提醒', async () => {
  const invalid = JSON.stringify({ candidates: [{ domain: 'education', goal: '提醒我', capabilities: ['publish', 'remind'], assumptions: [], confidence: 0.9 }], question: null });
  const provider = new QwenDashScopeProvider({ apiKey: secret, fetchImpl: async () => response({ choices: [{ message: { content: invalid } }] }) });
  const result = await new AgentOrchestrator({ provider }).infer({ message: '提醒我', trustedContext: {} });
  assert.equal(result.fallbackReason, 'provider_invalid_or_unavailable');
  assert.equal(result.candidates[0].domain, 'education');
  assert.deepEqual(result.candidates[0].capabilities, ['remind']);
});

test('Qwen system prompt逐字包含所有exact组合并禁止publish+remind', async () => {
  let body;
  const provider = new QwenDashScopeProvider({
    apiKey: secret,
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response({ choices: [{ message: { content: validContent } }] }); }
  });
  await provider.infer({ message: '提醒我' });
  const prompt = body.messages[0].content;
  for (const fragment of [
    'education=["publish"]', '["collect"]', '["remind"]', '["publish","collect"]',
    '["collect","remind"]', '["publish","collect","remind"]',
    'finance=["collect"]', 'retail=["collect"]、["collect","remind"]', '禁止["publish","remind"]'
  ]) assert.match(prompt, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const audit = provider.auditSummary()[0];
  assert.equal(audit.promptVersion, 'qwen-intent-v2');
  assert.equal(audit.responseSchemaVersion, 'intent-result-v2');
});
