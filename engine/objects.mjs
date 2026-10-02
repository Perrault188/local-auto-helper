import { createHash } from 'node:crypto';
import { id, isRfc3339 } from './utils.mjs';

// ============================================================================
// 通用对象初版（P0-B 任务3）
//
// 目标：把产品核心从「班委作业/学生/提交/催交」升级为中性的通用对象，对齐
//       outputs/PC端本地助手自动帮办MVP实现规划.md 第五、六节与 D024。
//
// 本轮范围（打地基）：
//   - 只定义通用对象的初版结构与构造/校验函数，以及领域打包映射。
//   - 通用对象与现有班委执行链路【并列】存在，本轮不改造执行器，
//     现有 Flow/Attachment/Run 链路保持不变，班委测试不受影响。
//   - 幂等范围「任务 + Flow + 事件」在结构上先预留（Run 记录 automationId/flowId/eventId），
//     执行器接入留待 P0-C / P0-D。
//
// 命名去掉「学生交作业」假设：用 entity（实体）、record（记录）、resource（资源）等中性词。
// ============================================================================

// 自动帮办任务状态：草稿 / 启用 / 暂停 / 结束 / 删除（软删除）。
export const AUTOMATION_STATUSES = ['draft', 'enabled', 'paused', 'ended', 'deleted'];

// Resource 的领域种类。班委作业附件是其中一种：EducationAssignmentPack。
// 其余为后续跨领域验证预留，本轮不实现其行为。
export const RESOURCE_KINDS = ['EducationAssignmentPack', 'FinanceReceiptPack', 'RetailDailyReportPack', 'ContactRoster', 'FileFolder', 'Spreadsheet'];

const nowOr = value => value ?? new Date().toISOString();

// ---------------------------------------------------------------------------
// Automation：用户想达成的目标（对应产品语言里的「一个自动帮办」）。
// 一个 Automation 可关联若干 Flow、Resource、RecordStore、EntityDirectory。
// ---------------------------------------------------------------------------
export function createAutomation({ automationId, name, domain, status = 'draft', intent = null, plan = null, createdAt, updatedAt } = {}) {
  const timestamp = nowOr(createdAt);
  return {
    automationId: automationId ?? id('automation'),
    name: name ?? '未命名自动帮办',
    domain: domain ?? 'generic',      // 领域标识，如 education / finance / retail / generic
    status,
    intent,                            // IntentSpec 初版占位：目标/触发/对象/规则/风险，后续填充
    plan,                              // PlanSpec 初版占位：能力链/参数绑定/审批边界，后续填充
    resourceIds: [],
    recordStoreIds: [],
    entityDirectoryIds: [],
    flowIds: [],
    createdAt: timestamp,
    updatedAt: nowOr(updatedAt) ?? timestamp
  };
}

export function validateAutomation(value) {
  if (!value || typeof value !== 'object') throw new Error('Automation 必须是对象');
  if (!/^automation_[A-Za-z0-9_-]+$/.test(value.automationId)) throw new Error('Automation 标识非法');
  if (!value.name || value.name.length > 80) throw new Error('Automation 名称非法');
  if (!AUTOMATION_STATUSES.includes(value.status)) throw new Error('Automation 状态非法');
  if (!isRfc3339(value.createdAt) || !isRfc3339(value.updatedAt)) throw new Error('Automation 时间非法');
  return value;
}

// ---------------------------------------------------------------------------
// Resource：数据资源（名单、表格、文件夹、业务记录、领域附件）。
// payload 存放领域特定内容，引擎核心不解释其内部结构（避免绑死班委）。
// ---------------------------------------------------------------------------
export function createResource({ resourceId, automationId, kind, name, payload = {}, createdAt, updatedAt } = {}) {
  const timestamp = nowOr(createdAt);
  return {
    resourceId: resourceId ?? id('resource'),
    automationId: automationId ?? null,
    kind: kind ?? 'FileFolder',
    name: name ?? '未命名资源',
    payload,
    createdAt: timestamp,
    updatedAt: nowOr(updatedAt) ?? timestamp
  };
}

export function validateResource(value) {
  if (!value || typeof value !== 'object') throw new Error('Resource 必须是对象');
  if (!/^resource_[A-Za-z0-9_-]+$/.test(value.resourceId)) throw new Error('Resource 标识非法');
  if (!RESOURCE_KINDS.includes(value.kind)) throw new Error('Resource 种类未注册');
  if (!isRfc3339(value.createdAt) || !isRfc3339(value.updatedAt)) throw new Error('Resource 时间非法');
  return value;
}

// ---------------------------------------------------------------------------
// RecordStore：记录表容器（提交记录、台账、订单记录、审核记录）。
// records 为该表下的记录数组，字段结构由领域决定；引擎只做通用增删改查载体。
// ---------------------------------------------------------------------------
export function createRecordStore({ recordStoreId, automationId, name, schema = null, records = [], createdAt, updatedAt } = {}) {
  const timestamp = nowOr(createdAt);
  return {
    recordStoreId: recordStoreId ?? id('recordstore'),
    automationId: automationId ?? null,
    name: name ?? '未命名记录表',
    schema,                            // 记录字段说明初版占位
    records,
    createdAt: timestamp,
    updatedAt: nowOr(updatedAt) ?? timestamp
  };
}

// ---------------------------------------------------------------------------
// EntityDirectory：可被匹配的实体目录（联系人、门店、项目、订单）。
// entities 为实体数组，matchKey 指明用哪个字段做匹配（班委场景为 userId）。
// ---------------------------------------------------------------------------
export function createEntityDirectory({ entityDirectoryId, automationId, name, matchKey = 'id', entities = [], createdAt, updatedAt } = {}) {
  const timestamp = nowOr(createdAt);
  return {
    entityDirectoryId: entityDirectoryId ?? id('entitydir'),
    automationId: automationId ?? null,
    name: name ?? '未命名实体目录',
    matchKey,
    entities,
    createdAt: timestamp,
    updatedAt: nowOr(updatedAt) ?? timestamp
  };
}

// ---------------------------------------------------------------------------
// 领域打包映射：把现有班委作业附件（0.2-rc1 attachment）描述为通用对象。
//
// 这是「班委作业附件降为 Resource 的一种领域实现」的落点：
//   - 作业任务本身 → Resource(kind = EducationAssignmentPack)，payload 承载原附件字段。
//   - 花名册 → EntityDirectory（matchKey = userId）。
//   - 提交状态 → RecordStore（每个成员一条提交记录）。
//
// 本函数为只读投影，不改动原 attachment，也不接入执行器；供后续 P0-C 创建真实任务时参考。
// ---------------------------------------------------------------------------
// 从附件成员投影出提交记录数组（B-2 同步复用）。
export function projectSubmissionRecords(members = []) {
  return members.map(member => ({
    userId: member.userId,
    submissionStatus: member.submissionStatus,
    lastSubmittedAt: member.lastSubmittedAt,
    filePath: member.filePath,
    reminderStatus: member.reminderStatus,
    remindedAt: member.remindedAt
  }));
}
export function packEducationAssignment(attachment, { automationId = null } = {}) {
  const resource = createResource({
    automationId,
    kind: 'EducationAssignmentPack',
    name: attachment.taskName,
    payload: {
      taskAttachmentId: attachment.taskAttachmentId,
      taskName: attachment.taskName,
      groupId: attachment.groupId,
      publishAt: attachment.publishAt,
      deadlineAt: attachment.deadlineAt,
      sourceFilePath: attachment.sourceFilePath
    },
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt
  });
  const entityDirectory = createEntityDirectory({
    automationId,
    name: `${attachment.taskName} 花名册`,
    matchKey: 'userId',
    entities: (attachment.members ?? []).map(member => ({ userId: member.userId, name: member.name, studentId: member.studentId })),
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt
  });
  const recordStore = createRecordStore({
    automationId,
    name: `${attachment.taskName} 提交记录`,
    schema: { entityKey: 'userId', fields: ['submissionStatus', 'lastSubmittedAt', 'filePath', 'reminderStatus', 'remindedAt'] },
    records: projectSubmissionRecords(attachment.members ?? []),
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt
  });
  // B-2 路线②：片段回填 sourceAttachmentId，供 executor 从 taskAttachmentId 反查并同步刷新。
  entityDirectory.sourceAttachmentId = attachment.taskAttachmentId;
  recordStore.sourceAttachmentId = attachment.taskAttachmentId;
  return { resource, entityDirectory, recordStore };
}

// ---------------------------------------------------------------------------
// P2-M1 持久消息对象。业务会话与 Agent 草稿会话使用完全独立的命名空间与仓库。
// ---------------------------------------------------------------------------
const stable = value => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value;
export const stableHash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const stableObjectId = (prefix, value) => `${prefix}_${stableHash(value).slice(0, 32)}`;

export function createConversation({ connector = 'mock', kind, externalKey, createdAt, updatedAt } = {}) {
  if (!['group', 'direct', 'assistant'].includes(kind)) throw new Error('Conversation kind非法');
  if (connector !== 'mock' || typeof externalKey !== 'string' || !externalKey) throw new Error('Conversation外部标识非法');
  const timestamp = createdAt ?? new Date().toISOString();
  return {
    conversationSchemaVersion: '1.0',
    conversationId: stableObjectId('conv', { connector, kind, externalKey }),
    kind,
    connector,
    externalKey,
    createdAt: timestamp,
    updatedAt: updatedAt ?? timestamp
  };
}

export function validateConversation(value) {
  if (!value || value.conversationSchemaVersion !== '1.0' || !/^conv_[A-Za-z0-9_-]+$/.test(value.conversationId)) throw new Error('Conversation基础字段非法');
  if (!['group', 'direct', 'assistant'].includes(value.kind) || value.connector !== 'mock' || !value.externalKey) throw new Error('Conversation路由字段非法');
  if (!isRfc3339(value.createdAt) || !isRfc3339(value.updatedAt)) throw new Error('Conversation时间非法');
  return value;
}

export function createInboundMessage({ connector = 'mock', conversation, event, recordedAt } = {}) {
  const payload = event.payload;
  const externalMessageId = payload.messageId;
  const file = payload.file ? { fileId: payload.file.fileId, name: payload.file.name, sourceRef: payload.file.sourceRef } : null;
  const text = payload.text || null;
  const immutableFingerprint = stableHash({ connector, conversationId: conversation.conversationId, externalMessageId, senderRef: payload.senderUserId, text, file });
  return {
    messageSchemaVersion: '1.0',
    messageId: stableObjectId('msg', { connector, conversationId: conversation.conversationId, externalMessageId }),
    externalMessageId,
    connector,
    conversationId: conversation.conversationId,
    direction: 'inbound',
    kind: file ? (text ? 'text_file' : 'file') : 'text',
    effectType: 'inbound',
    senderRef: payload.senderUserId,
    recipientKey: null,
    text,
    file,
    occurredAt: event.occurredAt,
    recordedAt: recordedAt ?? new Date().toISOString(),
    eventId: event.eventId,
    automationId: null,
    flowId: null,
    runId: null,
    actionId: null,
    actionKey: null,
    effectKey: null,
    deliveryStatus: 'received',
    payloadHash: immutableFingerprint,
    immutableFingerprint
  };
}

const MESSAGE_FIELDS = ['messageSchemaVersion','messageId','externalMessageId','connector','conversationId','direction','kind','effectType','senderRef','recipientKey','text','file','occurredAt','recordedAt','eventId','automationId','flowId','runId','actionId','actionKey','effectKey','deliveryStatus','payloadHash','immutableFingerprint'];
const matchesId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value);

export function validateMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== MESSAGE_FIELDS.length || !MESSAGE_FIELDS.every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !MESSAGE_FIELDS.includes(key))) throw new Error('Message字段集合非法');
  if (value.messageSchemaVersion !== '1.0' || !matchesId(value.messageId, 'msg')) throw new Error('Message基础字段非法');
  if (value.connector !== 'mock' || !matchesId(value.conversationId, 'conv') || typeof value.externalMessageId !== 'string' || !value.externalMessageId || !matchesId(value.eventId, 'event')) throw new Error('Message会话字段非法');
  if (!['inbound','outbound'].includes(value.direction) || !['text','file','text_file'].includes(value.kind)) throw new Error('Message方向或类型非法');
  if (!['received','pending','mock_recorded','failed'].includes(value.deliveryStatus)) throw new Error('Message送达状态非法');
  if (typeof value.senderRef !== 'string' || !value.senderRef) throw new Error('Message发送者非法');
  if (value.direction === 'inbound') {
    const runtimeRefs = ['automationId','flowId','runId','actionId','actionKey','effectKey'];
    if (value.effectType !== 'inbound' || value.deliveryStatus !== 'received' || value.recipientKey !== null || runtimeRefs.some(key => value[key] !== null)) throw new Error('入站Message状态非法');
  } else {
    if (!['group_send','reply','direct_send'].includes(value.effectType) || value.senderRef !== 'local-auto-helper' || typeof value.recipientKey !== 'string' || !value.recipientKey) throw new Error('出站Message路由非法');
    if (value.deliveryStatus === 'received' || (value.automationId !== null && !matchesId(value.automationId, 'automation')) || !matchesId(value.flowId, 'flow') || !matchesId(value.runId, 'run') || !matchesId(value.actionId, 'action') || !matchesId(value.actionKey, 'action') || !matchesId(value.effectKey, 'action')) throw new Error('出站Message状态非法');
    if (value.actionKey === value.effectKey) throw new Error('出站Message父子键必须不同');
  }
  if (value.kind === 'text' && (typeof value.text !== 'string' || value.file !== null)) throw new Error('文本Message内容非法');
  if (value.kind === 'file' && (value.text !== null || !value.file)) throw new Error('文件Message内容非法');
  if (value.kind === 'text_file' && (typeof value.text !== 'string' || !value.file)) throw new Error('图文Message内容非法');
  if (value.file) {
    if (typeof value.file !== 'object' || Array.isArray(value.file) || Object.keys(value.file).length !== 3 || !['fileId','name','sourceRef'].every(key => Object.hasOwn(value.file, key)) || Object.keys(value.file).some(key => !['fileId','name','sourceRef'].includes(key))) throw new Error('Message文件字段非法');
    if (typeof value.file.name !== 'string' || !value.file.name || typeof value.file.sourceRef !== 'string' || !value.file.sourceRef || (value.file.fileId !== null && (typeof value.file.fileId !== 'string' || !value.file.fileId)) || (value.deliveryStatus !== 'failed' && value.file.fileId === null)) throw new Error('Message文件引用非法');
  }
  if (!isRfc3339(value.occurredAt) || !isRfc3339(value.recordedAt)) throw new Error('Message时间非法');
  if (!/^[a-f0-9]{64}$/.test(value.payloadHash) || !/^[a-f0-9]{64}$/.test(value.immutableFingerprint)) throw new Error('Message指纹非法');
  const expected = value.direction === 'inbound'
    ? stableHash({ connector: value.connector, conversationId: value.conversationId, externalMessageId: value.externalMessageId, senderRef: value.senderRef, text: value.text, file: value.file })
    : stableHash({ actionKey: value.actionKey, recipientKey: value.recipientKey });
  if (expected !== value.immutableFingerprint) throw new Error('Message不可变指纹不匹配');
  return value;
}

export function createMessageRunLink({ messageId, runId, eventId, createdAt } = {}) {
  return {
    linkId: stableObjectId('msgrun', { messageId, runId }),
    messageId,
    runId,
    eventId,
    createdAt: createdAt ?? new Date().toISOString()
  };
}

export function createConversationBinding({ conversationId, automationId, capability, source, createdAt, active = true } = {}) {
  return {
    bindingId: stableObjectId('binding', { conversationId, capability }),
    conversationId,
    automationId,
    capability,
    source,
    active,
    createdAt: createdAt ?? new Date().toISOString(),
    updatedAt: createdAt ?? new Date().toISOString()
  };
}
