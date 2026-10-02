import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadIntentGold } from './intent-gold-loader.mjs';

const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
const ngrams = (value, size = 6) => {
  const text = normalize(value);
  return new Set(Array.from({ length: Math.max(0, text.length - size + 1) }, (_, index) => text.slice(index, index + size)));
};
const overlap = (left, right) => {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / Math.min(left.size, right.size);
};

export async function inspectIntentDatasetHygiene() {
  const fixture = await loadIntentGold();
  const groups = new Map();
  for (const item of fixture.cases) {
    const key = normalize(item.input.message);
    groups.set(key, [...(groups.get(key) ?? []), { caseId: item.caseId, message: item.input.message }]);
  }
  const normalizedDuplicates = [...groups.entries()].filter(([, items]) => items.length > 1).map(([normalized, items]) => ({ normalized, items }));
  const provider = await readFile(new URL('../../engine/agent/provider.mjs', import.meta.url), 'utf8');
  const promptMatch = provider.match(/const system = '([^']+)'/);
  if (!promptMatch) throw new Error('无法定位固定system prompt');
  const promptGrams = ngrams(promptMatch[1]);
  const promptOverlaps = fixture.cases.map(item => ({ caseId: item.caseId, message: item.input.message, ratio: overlap(ngrams(item.input.message), promptGrams) })).sort((a, b) => b.ratio - a.ratio);
  const excessivePromptOverlap = promptOverlaps.filter(item => item.ratio >= 0.8);
  return {
    schemaVersion: 'intent-dataset-hygiene-v1',
    thresholds: { normalizedDuplicateCount: 0, promptSixGramOverlap: 0.8 },
    summary: {
      caseCount: fixture.cases.length,
      normalizedDuplicateGroups: normalizedDuplicates.length,
      excessivePromptOverlapCount: excessivePromptOverlap.length,
      passed: normalizedDuplicates.length === 0 && excessivePromptOverlap.length === 0
    },
    normalizedDuplicates,
    highestPromptOverlaps: promptOverlaps.slice(0, 10),
    excessivePromptOverlap
  };
}

async function main() {
  const report = await inspectIntentDatasetHygiene();
  console.log(JSON.stringify(report, null, 2));
  if (!report.summary.passed) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ error: 'intent_dataset_hygiene_error', message: error?.message ?? String(error) }));
  process.exitCode = 1;
});
