import { VERSION } from './utils.mjs';
import { stableObjectId } from './objects.mjs';
import { validateFlow } from './validation.mjs';

const actions = {
  homework_publish_v1: slots => [
    { actionId: 'action_init_task', type: 'initialize_task_attachment', params: { taskAttachmentId: slots.taskAttachmentId } },
    { actionId: 'action_send_homework', type: 'send_group_message_and_file', params: { groupId: slots.groupId, text: slots.text, filePath: slots.filePath } }
  ],
  homework_collect_v1: slots => [
    { actionId: 'action_match_person', type: 'match_person', params: { taskAttachmentId: slots.taskAttachmentId } },
    { actionId: 'action_rename_file', type: 'rename_received_file', params: { nameTemplate: slots.nameTemplate ?? '{studentId}_{name}{originalExtension}' } },
    { actionId: 'action_mark_submitted', type: 'mark_submission', params: { taskAttachmentId: slots.taskAttachmentId } },
    { actionId: 'action_reply_received', type: 'reply_to_sender', params: { text: slots.replyText ?? '收到，已帮你登记' } }
  ],
  homework_remind_v1: slots => [
    { actionId: 'action_read_unsubmitted', type: 'read_unsubmitted', params: { taskAttachmentId: slots.taskAttachmentId } },
    { actionId: 'action_build_recipients', type: 'build_recipient_list', params: {} },
    { actionId: 'action_send_reminder', type: 'send_direct_message_batch', params: { text: slots.text } }
  ]
};

export function instantiateTemplate(templateId, slots, attachment, now = new Date().toISOString()) {
  const hook = templateId === 'homework_collect_v1'
    ? slots.canonicalFileHook
      ? { type: 'file_received', params: { conversationType: 'group', conversationId: stableObjectId('conv', { connector: 'mock', kind: 'group', externalKey: slots.groupId }), groupId: slots.groupId, ...(slots.keyword === undefined ? {} : { keyword: slots.keyword.trim() }), allowedExtensions: slots.allowedExtensions } }
      : { type: 'group_file_received', params: { groupId: slots.groupId, ...(slots.keyword === undefined ? {} : { keyword: slots.keyword.trim() }), allowedExtensions: slots.allowedExtensions } }
    : templateId === 'homework_remind_v1'
      ? { type: 'scheduled', params: { runAt: slots.runAt, timezone: 'Asia/Shanghai' } }
      : slots.hook;
  const flow = { schemaVersion: slots.protocolVersion ?? VERSION, flowId: slots.flowId, name: slots.name, templateId, status: slots.status ?? 'draft', hook, actions: actions[templateId]?.(slots), taskAttachmentId: slots.taskAttachmentId, createdAt: now, updatedAt: now, deletedAt: null };
  return validateFlow(flow, attachment);
}
