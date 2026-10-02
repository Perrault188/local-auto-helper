import { readFile } from 'node:fs/promises';

export async function loadIntentGold() {
  const manifest = JSON.parse(await readFile(new URL('../../fixtures/evaluation/intent-gold-v1.manifest.json', import.meta.url), 'utf8'));
  const text = await readFile(new URL('../../fixtures/evaluation/intent-gold-v1.jsonl', import.meta.url), 'utf8');
  const cases = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`JSONL第${index + 1}行非法`); }
  });
  return { ...manifest, cases };
}
