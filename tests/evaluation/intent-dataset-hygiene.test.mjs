import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadIntentGold } from './intent-gold-loader.mjs';

const sensitivePatterns = [
  /(?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*["']?[^\s"',}]+/i,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /https?:\/\/[^\s"']+@/i,
  /(?<!\d)1[3-9]\d{9}(?!\d)/
];

test('JSONL、manifest和generator执行敏感扫描，canary只能显式标记', async () => {
  const fixture = await loadIntentGold();
  const files = await Promise.all([
    readFile(new URL('../../fixtures/evaluation/intent-gold-v1.jsonl', import.meta.url), 'utf8'),
    readFile(new URL('../../fixtures/evaluation/intent-gold-v1.manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('./build-intent-gold.mjs', import.meta.url), 'utf8')
  ]);
  for (const [index, text] of files.entries()) for (const pattern of sensitivePatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const allowed = fixture.cases.some(item => item.tags.includes('sensitive_canary') && JSON.stringify(item).includes(match[0]));
    assert.equal(allowed, true, `文件${index + 1}出现未标记敏感形态 ${match[0]}`);
  }
  for (const item of fixture.cases.filter(item => item.tags.includes('sensitive_canary'))) {
    assert.equal(item.datasetType, undefined);
    assert.ok(item.tags.includes('injection'));
  }
});
