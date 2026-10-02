import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('P2-S2前端提供最近会话、统一汇报、文件清单和一次性ZIP入口', async () => {
  const [app, adapter, index] = await Promise.all([
    source('prototype/app.js'), source('prototype/adapter.js'), source('prototype/index.html')
  ]);
  for (const text of ['最近会话', '本地助手统一汇报', '文件成果', '下载一次性ZIP', 'Run ${esc(message.runId.slice(-8))}', 'Action ${esc(message.actionId)}']) {
    assert.equal(app.includes(text), true, text);
  }
  assert.equal(index.includes('林老师'), false, '最近会话不再使用静态占位人物');
  for (const text of ['item.displayLabel', "item.latestMessage||'暂无消息'", "String(b.updatedAt).localeCompare(String(a.updatedAt))", 'conversationRefreshBusy']) assert.equal(app.includes(text), true, text);
  for (const path of ['/api/conversations', '/messages', '/evidence', '/archive']) assert.equal(adapter.includes(path), true, path);
});

test('P2-S2私聊Mock入口构造canonical file_received且不向事件添加groupId', async () => {
  const server = await source('demo/server.mjs');
  const start = server.indexOf('async function dispatchMockDirectFile');
  const end = server.indexOf('async function runSelectedMockCapability', start);
  const block = server.slice(start, end);
  assert.equal(block.includes("type: 'file_received'"), true);
  assert.equal(block.includes("conversationType: 'direct'"), true);
  assert.equal(block.includes('groupId'), false);
});
