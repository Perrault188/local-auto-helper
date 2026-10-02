import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { labelsFor, capabilityLabel, actionLabel } from '../prototype/domain-labels.js';

test('education、finance、retail使用各自的进度和对象措辞', () => {
  assert.deepEqual(
    ['education', 'finance', 'retail'].map(domain => {
      const labels = labelsFor(domain);
      return [labels.entityId, labels.completed, labels.pending, capabilityLabel('collect', domain)];
    }),
    [
      ['学号', '已交', '未交', '收文件登记'],
      ['关联编号', '待审核', '待提交', '收单据登记'],
      ['门店编号', '已上报', '待上报', '收日报登记']
    ]
  );
});

test('运行步骤按领域转换动作词，未知领域使用通用措辞', () => {
  assert.equal(actionLabel('initialize_task_attachment', 'education'), '建立本次作业记录');
  assert.equal(actionLabel('match_person', 'education'), '确认提交人信息');
  assert.equal(actionLabel('rename_received_file', 'education'), '按学号和姓名改名');
  assert.equal(actionLabel('mark_submission', 'finance'), '登记为待审核');
  assert.equal(actionLabel('match_person', 'retail'), '确认门店负责人信息');
  assert.equal(actionLabel('read_unsubmitted', 'retail'), '找出待上报门店负责人');
  assert.equal(actionLabel('match_person', 'unknown'), '确认成员信息');
  assert.equal(actionLabel('send_group_message_and_file', 'finance'), '发送收件通知和文件');
});

test('前端运行逻辑不再直接引用固定班级群ID', async () => {
  const [app, adapter] = await Promise.all([
    readFile(new URL('../prototype/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../prototype/adapter.js', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(app, /group_se_2024_1|软件工程2024级1班/);
  assert.doesNotMatch(adapter, /group_se_2024_1/);
  assert.match(app, /store\.get\(\)\.groups/);
  assert.match(adapter, /attachment\.groupId/);
});
