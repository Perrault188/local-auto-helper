import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { labelsFor, actionLabel } from '../prototype/domain-labels.js';

const runtimeFiles = [
  new URL('../prototype/app.js', import.meta.url),
  new URL('../prototype/adapter.js', import.meta.url),
  new URL('../prototype/store.js', import.meta.url)
];

test('P2-#5：前端运行路径不含固定班级名或群ID', async () => {
  for (const file of runtimeFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /group_se_2024_1|软件工程2024级1班|软件工程班群/,
      `${file.pathname}仍包含班委主演示写死值`
    );
  }
});

test('财务前端只表达收件与待审核，不暗示已经审核', () => {
  const labels = labelsFor('finance');
  assert.equal(labels.completed, '待审核');
  assert.equal(labels.completedCount, '待审核');
  assert.equal(actionLabel('mark_submission', 'finance'), '登记为待审核');
  for (const value of Object.values(labels)) {
    assert.doesNotMatch(value, /已审核|已付款|已入账|自动审核|自动付款|自动入账/);
  }
});
