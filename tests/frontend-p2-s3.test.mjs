import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('P2-S3任务详情演示调用所选任务专属Mock入口', async () => {
  const adapter = await source('prototype/adapter.js');
  assert.equal(adapter.includes('/mock-run'), true);
  assert.equal(adapter.includes('eventFor(kind, variant)'), false);
});

test('P2-S3修改弹窗回显当前发布说明和提醒文案', async () => {
  const app = await source('prototype/app.js');
  assert.equal(app.includes('${esc(a.publishText||\'\')}'), true);
  assert.equal(app.includes('${esc(a.remindText||\'\')}'), true);
});

test('P2-S3私聊收件运行来源使用canonical事件对应文案', async () => {
  const app = await source('prototype/app.js');
  assert.equal(app.includes("r.eventSnapshot.type==='file_received'?'收到成员私聊文件'"), true);
});

test('P2-S3三能力对话创建使用可确认的时间默认值', async () => {
  const app = await source('prototype/app.js');
  assert.equal(app.includes("if(field==='publishAt')return localDateValue(1,10)"), true);
  assert.equal(app.includes("if(field==='deadlineAt'&&bindings.remindAt)return localValueFromRfc3339(bindings.remindAt)"), true);
  assert.equal(app.includes('agentTimeDefault(q.field,d)'), true);
});

test('收作业截止先检查并询问，确认后或用户主动要求时才催交', async () => {
  const app = await source('prototype/app.js');
  const adapter = await source('prototype/adapter.js');
  assert.equal(app.includes('promptDeadlineCheck'), true);
  assert.equal(app.includes('需要我现在帮你催交吗？'), true);
  assert.equal(app.includes("action:`remind-now:${automationId}`"), true);
  assert.equal(app.includes('await remindNow(candidates[0].automationId)'), true);
  assert.equal(adapter.includes('/deadline-check'), true);
  assert.equal(adapter.includes('/remind-now'), true);
  assert.equal(app.includes('data-add-remind="${a.automationId}"'), false);
});
