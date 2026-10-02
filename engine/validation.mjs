import { isSupportedVersion, isSupportedEventVersion, isSupportedFlowVersion, assert, isRfc3339 } from './utils.mjs';

const templateRules = {
  homework_publish_v1: { hooks: ['self_message', 'scheduled'], actions: ['initialize_task_attachment', 'send_group_message_and_file'] },
  homework_collect_v1: { hooks: ['group_file_received', 'file_received'], actions: ['match_person', 'rename_received_file', 'mark_submission', 'reply_to_sender'] },
  homework_remind_v1: { hooks: ['scheduled'], actions: ['read_unsubmitted', 'build_recipient_list', 'send_direct_message_batch'] }
};
const statuses = new Set(['draft', 'enabled', 'disabled', 'deleted']);
export const CAPABILITIES = ['publish', 'collect', 'remind'];

// 附件是否需要名单/提交底座（members）：只有涉及「收取登记」或「催未交判定」才需要。
// 纯 publish（只发通知）与纯 remind（只发提醒、不判未交）不需要名单。
function needsRoster(capabilities) {
  return capabilities.includes('collect');
}
// 附件是否需要群（groupId）：publish 发送目标 / collect 收取来源都要；纯 remind 不需要。
function needsGroup(capabilities) {
  return capabilities.includes('publish') || capabilities.includes('collect');
}
// 附件是否需要截止时间（deadlineAt）：仅「催未交闭环」(collect+remind) 需要判定未交。
function needsDeadline(capabilities) {
  return capabilities.includes('collect') && capabilities.includes('remind');
}
const flowKeys = ['schemaVersion','flowId','name','templateId','status','hook','actions','taskAttachmentId','createdAt','updatedAt','deletedAt'];
const actionParams = {
  initialize_task_attachment: ['taskAttachmentId'], send_group_message_and_file: ['groupId','text','filePath'],
  match_person: ['taskAttachmentId'], rename_received_file: ['nameTemplate'], mark_submission: ['taskAttachmentId'],
  reply_to_sender: ['text'], read_unsubmitted: ['taskAttachmentId'], build_recipient_list: [], send_direct_message_batch: ['text']
};

function exactKeys(object, allowed, label) {
  assert(object && typeof object === 'object' && !Array.isArray(object), `${label}必须是对象`);
  assert(Object.keys(object).every(key => allowed.includes(key)), `${label}包含0.2-rc1未声明字段`);
}

export function validateAttachment(value) {
  // 0.3-rc1 彻底档：附件可携带可选 capabilities，按能力条件裁剪必填字段。
  // 缺省 capabilities（不含该字段）→ 视为全能力，与 0.2-rc1 全必填行为完全等价（兼容红线）。
  const hasCapabilities = value && typeof value === 'object' && Array.isArray(value.capabilities);
  exactKeys(value, ['schemaVersion','taskAttachmentId','taskName','groupId','publishAt','deadlineAt','sourceFilePath','members','createdAt','updatedAt', ...(hasCapabilities ? ['capabilities'] : [])], '附件');
  assert(isSupportedVersion(value.schemaVersion), '附件协议版本必须是 0.2-rc1 或 0.3-rc1');
  assert(/^task_[A-Za-z0-9_-]+$/.test(value.taskAttachmentId), '附件标识非法');

  const capabilities = hasCapabilities ? value.capabilities : CAPABILITIES;
  assert(capabilities.length > 0 && capabilities.every(item => CAPABILITIES.includes(item)), '附件 capabilities 非法');

  // taskName 恒必填（任务标题，全局）。
  assert(value.taskName, '附件基础字段非法');
  // groupId：仅 publish/collect 需要；纯 remind 允许为 null（但仍须字段存在，值可为 null）。
  if (needsGroup(capabilities)) assert(value.groupId, '附件缺少目标群');
  else assert(value.groupId === null || value.groupId === undefined || value.groupId, '附件群字段非法');
  // publishAt：publish 或需要判定的场景才必填；否则允许 null。
  assert(value.publishAt === null || isRfc3339(value.publishAt), '附件发布时间非法');
  // deadlineAt：仅催未交闭环（collect+remind）必填；否则允许 null。
  if (needsDeadline(capabilities)) assert(isRfc3339(value.deadlineAt), '附件缺少截止时间');
  else assert(value.deadlineAt === null || isRfc3339(value.deadlineAt), '附件截止时间非法');
  // members（名单/提交底座）：仅 collect（含催未交）必填非空；否则允许空数组。
  if (needsRoster(capabilities)) assert(Array.isArray(value.members) && value.members.length > 0, '附件至少包含一名成员');
  else assert(Array.isArray(value.members), '附件成员字段必须是数组');

  const userIds = new Set();
  for (const member of value.members) {
    exactKeys(member, ['userId','name','studentId','submissionStatus','lastSubmittedAt','filePath','reminderStatus','remindedAt'], '成员');
    assert(/^[A-Za-z0-9_-]{3,64}$/.test(member.userId) && !userIds.has(member.userId), '成员用户ID非法或重复');
    userIds.add(member.userId);
    assert(member.name && member.studentId, '成员姓名和学号不能为空');
    assert(['unsubmitted','submitted'].includes(member.submissionStatus), '提交状态非法');
    assert(['not_needed','pending','sent'].includes(member.reminderStatus), '催交状态非法');
    if (member.submissionStatus === 'submitted') assert(isRfc3339(member.lastSubmittedAt) && member.filePath && member.reminderStatus === 'not_needed' && member.remindedAt === null, '已提交成员状态不一致');
    else assert(member.lastSubmittedAt === null && member.filePath === null && ['pending','sent'].includes(member.reminderStatus), '未提交成员状态不一致');
    if (member.reminderStatus === 'sent') assert(isRfc3339(member.remindedAt), '已提醒成员缺少提醒时间');
    else assert(member.remindedAt === null, '未提醒成员不能有提醒时间');
  }
  assert(isRfc3339(value.createdAt) && isRfc3339(value.updatedAt), '附件时间非法');
  return value;
}

export function validateEvent(event) {
  exactKeys(event, ['schemaVersion','eventId','type','occurredAt','payload'], '事件');
  assert(isSupportedEventVersion(event.schemaVersion) && /^event_[A-Za-z0-9_-]+$/.test(event.eventId) && isRfc3339(event.occurredAt), '事件基础字段非法', 'HOOK_INPUT_INVALID');
  const required = {
    self_message_sent: ['messageId','conversationId','senderUserId','text'],
    timer_fired: ['scheduledFor','timezone'],
    group_file_received: ['messageId','groupId','senderUserId','text','file'],
    file_received: ['messageId','conversationId','conversationType','senderUserId','text','file']
  }[event.type];
  assert(required && required.every(key => Object.hasOwn(event.payload, key)), '事件payload字段不完整', 'HOOK_INPUT_INVALID');
  exactKeys(event.payload, required ?? [], '事件payload');
  if (event.type === 'timer_fired') assert(event.payload.timezone === 'Asia/Shanghai' && isRfc3339(event.payload.scheduledFor), '定时事件非法', 'HOOK_INPUT_INVALID');
  if (event.type !== 'timer_fired') assert(/^[A-Za-z0-9_-]{3,64}$/.test(event.payload.senderUserId), '事件用户ID非法', 'HOOK_INPUT_INVALID');
  if (event.type === 'group_file_received') {
    assert(isSupportedVersion(event.schemaVersion), '旧文件事件版本非法', 'HOOK_INPUT_INVALID');
    exactKeys(event.payload.file, ['fileId','name','path'], '事件文件');
    assert(event.payload.file?.fileId && event.payload.file?.name && event.payload.file?.path, '文件事件非法', 'HOOK_INPUT_INVALID');
  }
  if (event.type === 'file_received') {
    assert(event.schemaVersion === '0.4-rc1' && ['group','direct'].includes(event.payload.conversationType) && /^conv_[A-Za-z0-9_-]+$/.test(event.payload.conversationId), '统一文件事件会话非法', 'HOOK_INPUT_INVALID');
    exactKeys(event.payload.file, ['fileId','name','sourceRef'], '事件文件');
    assert(event.payload.file?.fileId && event.payload.file?.name && event.payload.file?.sourceRef, '统一文件事件非法', 'HOOK_INPUT_INVALID');
  }
  return event;
}

export function validateFlow(flow, attachment) {
  exactKeys(flow, flowKeys, 'Flow');
  assert(isSupportedFlowVersion(flow.schemaVersion) && /^flow_[A-Za-z0-9_-]+$/.test(flow.flowId), 'Flow基础字段非法');
  assert(flow.name && flow.name.length <= 80 && statuses.has(flow.status), 'Flow名称或状态非法');
  assert(isRfc3339(flow.createdAt) && isRfc3339(flow.updatedAt), 'Flow时间非法');
  assert(flow.status === 'deleted' ? isRfc3339(flow.deletedAt) : flow.deletedAt === null, '删除时间与状态不一致');
  const rule = templateRules[flow.templateId];
  assert(rule && flow.hook && !Array.isArray(flow.hook) && rule.hooks.includes(flow.hook.type), '模板不允许该Hook');
  exactKeys(flow.hook, ['type','params'], 'Hook');
  assert(Array.isArray(flow.actions) && flow.actions.map(item => item.type).join() === rule.actions.join(), 'Action数量、类型或顺序不符合模板');
  for (const action of flow.actions) {
    exactKeys(action, ['actionId','type','params'], 'Action');
    assert(/^action_[A-Za-z0-9_-]+$/.test(action.actionId) && actionParams[action.type], 'Action字段非法');
    exactKeys(action.params, actionParams[action.type], `${action.type}参数`);
    assert(actionParams[action.type].every(key => Object.hasOwn(action.params, key)), `${action.type}缺少参数`);
  }
  const references = flow.actions.flatMap(action => Object.hasOwn(action.params, 'taskAttachmentId') ? [action.params.taskAttachmentId] : []);
  assert(references.every(reference => reference === flow.taskAttachmentId), 'taskAttachmentId引用不一致');
  if (flow.hook.type === 'scheduled') { exactKeys(flow.hook.params, ['runAt','timezone'], '定时Hook参数'); assert(flow.hook.params.timezone === 'Asia/Shanghai' && isRfc3339(flow.hook.params.runAt), '定时Hook非法'); }
  if (flow.hook.type === 'self_message') { exactKeys(flow.hook.params, ['conversationId','keyword'], '消息Hook参数'); assert(flow.hook.params.conversationId && flow.hook.params.keyword, '消息Hook参数非法'); }
  if (flow.hook.type === 'group_file_received') {
    assert(isSupportedVersion(flow.schemaVersion), '0.4 Flow禁止legacy group_file_received Hook');
    exactKeys(flow.hook.params, ['groupId','keyword','allowedExtensions'], '文件Hook参数');
    const extensions = flow.hook.params.allowedExtensions;
    assert(flow.hook.params.groupId && Array.isArray(extensions) && extensions.length > 0 && new Set(extensions).size === extensions.length && extensions.every(item => /^\.[A-Za-z0-9]+$/.test(item)), '文件Hook参数非法');
    if (Object.hasOwn(flow.hook.params, 'keyword')) assert(flow.hook.params.keyword.trim(), '文件关键词不能为空');
  }
  if (flow.hook.type === 'file_received') {
    exactKeys(flow.hook.params, ['conversationType','conversationId','groupId','keyword','allowedExtensions'], '统一文件Hook参数');
    const extensions = flow.hook.params.allowedExtensions;
    assert(flow.schemaVersion === '0.4-rc1' && ['group','direct'].includes(flow.hook.params.conversationType) && /^conv_[A-Za-z0-9_-]+$/.test(flow.hook.params.conversationId), '统一文件Hook会话非法');
    assert(Array.isArray(extensions) && extensions.length > 0 && new Set(extensions).size === extensions.length && extensions.every(item => /^\.[A-Za-z0-9]+$/.test(item)), '统一文件Hook扩展名非法');
    if (Object.hasOwn(flow.hook.params, 'keyword')) assert(flow.hook.params.keyword.trim(), '文件关键词不能为空');
  }
  if (['group_file_received','file_received'].includes(flow.hook.type)) {
    const nameTemplate = flow.actions[1].params.nameTemplate;
    assert(nameTemplate && !nameTemplate.replaceAll(/{(?:studentId|name|originalExtension)}/g, '').includes('{'), '文件名模板含未声明占位符');
  }
  if (attachment) {
    validateAttachment(attachment);
    assert(attachment.taskAttachmentId === flow.taskAttachmentId, 'Flow引用附件不一致');
    // 群一致性：仅当附件真的携带 groupId 时才要求一致（纯 remind 附件无群，不校验）。
    if (flow.templateId === 'homework_publish_v1' && attachment.groupId) assert(flow.actions[1].params.groupId === attachment.groupId, '发布群与附件群不一致');
    if (flow.templateId === 'homework_collect_v1' && attachment.groupId && flow.hook.type === 'group_file_received') assert(flow.hook.params.groupId === attachment.groupId, '收取群与附件群不一致');
    // 催交时间：0.3-rc1 解绑 deadline，remind 用独立 remindAt。
    // 仅当附件带 deadlineAt 且为「催未交闭环」(附件 capabilities 同含 collect+remind) 时，才要求 runAt=deadline（旧闭环行为）。
    if (flow.templateId === 'homework_remind_v1') {
      const caps = Array.isArray(attachment.capabilities) ? attachment.capabilities : CAPABILITIES;
      const isUnsubmittedLoop = caps.includes('collect') && caps.includes('remind');
      if (isUnsubmittedLoop && attachment.deadlineAt) assert(flow.hook.params.runAt === attachment.deadlineAt, '催交时间与截止时间不一致');
    }
  }
  return flow;
}
