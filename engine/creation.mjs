import { VERSION, FLOW_VERSION, id, isRfc3339 } from './utils.mjs';
import { instantiateTemplate } from './templates.mjs';
import { CAPABILITIES } from './validation.mjs';
import { createAutomation } from './objects.mjs';
import { getDomainPack, packAutomationDomain, toRuntimeTaskInput } from './domain-packs.mjs';
import { createHash } from 'node:crypto';

// 解析创建输入里的 capabilities（别名 segments）：
//   - 不传 / undefined → 全选 ['publish','collect','remind']（等价旧行为，兼容红线）。
//   - 显式空数组 → 抛 capabilities/EMPTY。
//   - 含非法值 → 抛 capabilities/UNKNOWN。
//   - 去重、按 publish→collect→remind 规范顺序、忽略大小写。
// 返回 { capabilities, error }，error 为 null 或 { field, code, message }。
function resolveCapabilities(raw) {
  const input = raw === undefined ? null : raw;
  if (input === null) return { capabilities: [...CAPABILITIES], error: null };
  if (!Array.isArray(input)) return { capabilities: [], error: { field: 'capabilities', code: 'UNKNOWN', message: 'capabilities 必须是数组' } };
  if (input.length === 0) return { capabilities: [], error: { field: 'capabilities', code: 'EMPTY', message: 'capabilities 不能是空数组；不限定能力请省略该字段' } };
  const normalized = input.map(item => String(item).trim().toLowerCase());
  const unknown = normalized.filter(item => !CAPABILITIES.includes(item));
  if (unknown.length > 0) return { capabilities: [], error: { field: 'capabilities', code: 'UNKNOWN', message: `未知能力：${[...new Set(unknown)].join('、')}（合法值 publish/collect/remind）` } };
  const capabilities = CAPABILITIES.filter(item => normalized.includes(item));
  return { capabilities, error: null };
}

// ============================================================================
// P0-C：从零创建真实任务（引擎侧）
//
// 目标：提供 createAutomationTask(input)，每次生成唯一 automationId 与专属数据，
//       绝不复用固定 flow_*_demo / task_*_demo，落库到默认 SQLite 后端。
//
// 一个班委作业任务在创建时产出：
//   - 专属 Attachment（班委作业附件，0.2-rc1 协议，供现有执行链路使用）
//   - 三条内部 Flow（发布/收取/催交），引用本任务专属 taskAttachmentId
//   - 通用对象：Automation + Resource(EducationAssignmentPack) + EntityDirectory(userId) + RecordStore(提交记录)
//
// 校验失败抛出 CreationValidationError，携带字段级结构化错误，便于前端就地提示。
// ============================================================================

// 结构化创建校验错误：errors 为 [{ field, code, message, row? }]。
export class CreationValidationError extends Error {
  constructor(errors) {
    super(`创建参数校验失败，共 ${errors.length} 项`);
    this.name = 'CreationValidationError';
    this.code = 'CREATION_INPUT_INVALID';
    this.errors = errors;
  }
}

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const STUDENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const EXTENSION_PATTERN = /^\.[A-Za-z0-9]+$/;
// 文件名模板：禁止路径分隔符与常见非法字符，只允许声明占位符与安全字符。
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/;
const ALLOWED_PLACEHOLDERS = /{(?:studentId|name|originalExtension)}/g;
const LOCAL_OWNER = { userId: 'local_owner', name: '当前用户', studentId: 'OWNER' };

const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

// 校验创建输入，返回规范化后的输入；不合法则抛出 CreationValidationError。
// 0.3-rc1 彻底档：按 capabilities 条件校验，字段真正按需。
//   - 不传 capabilities → 全选，校验规则与 0.2-rc1 完全等价（兼容红线）。
//   - 只选 publish：发送目标+正文+通知附件+发布触发+发布时间，不需名单/收取/催交/截止。
//   - 只选 collect：群+文件规则+命名模板+名单，不需截止/催交。
//   - 只选 remind：提醒时间(独立 remindAt)+文案，不强制群/名单/截止。
//   - collect+remind（催未交闭环）：额外需要截止时间（判定未交）。
export function validateCreateAutomationTaskInput(input) {
  const errors = [];
  const push = (field, code, message, extra = {}) => errors.push({ field, code, message, ...extra });

  if (!input || typeof input !== 'object') throw new CreationValidationError([{ field: '', code: 'REQUIRED', message: '创建参数必须是对象' }]);
  try {
    input = toRuntimeTaskInput(input);
  } catch (error) {
    throw new CreationValidationError([{ field: 'domain', code: 'UNKNOWN', message: error.message }]);
  }

  // capabilities 解析（空数组/非法值直接报错）
  const capabilityResult = resolveCapabilities(input.capabilities ?? input.segments);
  if (capabilityResult.error) throw new CreationValidationError([capabilityResult.error]);
  const capabilities = capabilityResult.capabilities;
  const has = cap => capabilities.includes(cap);
  const needGroup = has('publish') || has('collect');
  const needRoster = has('collect');
  const needDeadline = has('collect') && has('remind'); // 催未交闭环才需截止判定
  const publishTrigger = input.publishTrigger === 'scheduled' ? 'scheduled' : 'self_message';

  // 任务名（恒必填）
  if (!isNonEmptyString(input.taskName)) push('taskName', 'REQUIRED', '任务名不能为空');
  else if (input.taskName.length > 80) push('taskName', 'TOO_LONG', '任务名不能超过 80 字');

  // 目标群：仅 publish/collect 需要
  if (needGroup && !isNonEmptyString(input.groupId)) push('groupId', 'REQUIRED', '目标群不能为空');

  // 发布相关：仅 publish 需要
  if (has('publish')) {
    if (!isNonEmptyString(input.publishText)) push('publishText', 'REQUIRED', '发布说明不能为空');
    if (!isNonEmptyString(input.noticeFilePath)) push('noticeFilePath', 'REQUIRED', '通知附件引用不能为空');
    if (publishTrigger === 'scheduled' && !isRfc3339(input.publishAt)) push('publishAt', 'FORMAT', '定时发布必须设置带时区的 RFC3339 时间');
    else if (input.publishAt !== undefined && input.publishAt !== null && !isRfc3339(input.publishAt)) push('publishAt', 'FORMAT', '发布时间必须是带时区的 RFC3339 时间');
  }

  // 截止时间：仅催未交闭环必填；若显式提供须合法
  if (needDeadline) {
    if (!isRfc3339(input.deadlineAt)) push('deadlineAt', 'FORMAT', '催交需设定截止时间（带时区的 RFC3339）');
  } else if (input.deadlineAt !== undefined && input.deadlineAt !== null && !isRfc3339(input.deadlineAt)) {
    push('deadlineAt', 'FORMAT', '截止时间必须是带时区的 RFC3339 时间');
  }
  // 发布/截止先后关系：两者都存在时才校验
  if (isRfc3339(input.publishAt) && isRfc3339(input.deadlineAt) && Date.parse(input.deadlineAt) <= Date.parse(input.publishAt)) push('deadlineAt', 'RANGE', '截止时间必须晚于发布时间');

  // 收取规则：仅 collect 需要
  const rule = input.collectRule ?? {};
  const extensions = rule.allowedExtensions;
  if (has('collect')) {
    if (!Array.isArray(extensions) || extensions.length === 0) push('collectRule.allowedExtensions', 'REQUIRED', '至少声明一个允许的文件扩展名');
    else {
      if (new Set(extensions.map(e => String(e).toLowerCase())).size !== extensions.length) push('collectRule.allowedExtensions', 'DUPLICATE', '扩展名白名单不能重复');
      extensions.forEach((ext, index) => { if (!EXTENSION_PATTERN.test(String(ext))) push('collectRule.allowedExtensions', 'FORMAT', `扩展名格式非法：${ext}（应形如 .docx）`, { index }); });
    }
    if (rule.keyword !== undefined && rule.keyword !== null && !isNonEmptyString(rule.keyword)) push('collectRule.keyword', 'FORMAT', '收取关键词若填写则不能为空白');
  }

  // 命名模板：仅 collect 使用；始终校验其安全性（若填写）
  const nameTemplate = input.nameTemplate ?? '{studentId}_{name}{originalExtension}';
  if (has('collect')) {
    if (!isNonEmptyString(nameTemplate)) push('nameTemplate', 'REQUIRED', '命名模板不能为空');
    else {
      const stripped = nameTemplate.replaceAll(ALLOWED_PLACEHOLDERS, '');
      if (stripped.includes('{') || stripped.includes('}')) push('nameTemplate', 'PLACEHOLDER', '命名模板含未声明占位符，仅支持 {studentId} {name} {originalExtension}');
      if (ILLEGAL_NAME_CHARS.test(stripped)) push('nameTemplate', 'ILLEGAL_CHAR', '命名模板禁止包含路径分隔符或非法字符 \\ / : * ? " < > |');
    }
  }

  // 催交文案与时间：仅 remind 需要
  if (has('remind')) {
    if (!isNonEmptyString(input.remindText)) push('remindText', 'REQUIRED', '提醒文案不能为空');
    // 提醒时间：0.3-rc1 独立 remindAt；催未交闭环缺省可回退 deadline，否则必须显式提供
    const remindAt = input.remindAt ?? (needDeadline ? input.deadlineAt : undefined);
    if (remindAt === undefined || remindAt === null) push('remindAt', 'REQUIRED', '需设定提醒时间');
    else if (!isRfc3339(remindAt)) push('remindAt', 'FORMAT', '提醒时间必须是带时区的 RFC3339 时间');
  }

  // 名单：仅 collect 需要；逐行报告行号
  const roster = input.roster;
  if (needRoster) {
    if (!Array.isArray(roster) || roster.length === 0) push('roster', 'REQUIRED', '名单至少包含一名成员');
    else {
      const seen = new Map();
      roster.forEach((member, index) => {
        const row = index + 1;
        const m = member ?? {};
        if (!isNonEmptyString(m.userId)) push('roster', 'USER_ID_REQUIRED', `第 ${row} 行用户ID不能为空`, { row });
        else if (!USER_ID_PATTERN.test(String(m.userId))) push('roster', 'USER_ID_FORMAT', `第 ${row} 行用户ID格式非法 ${m.userId}`, { row });
        else if (seen.has(m.userId)) push('roster', 'USER_ID_DUPLICATE', `第 ${row} 行用户ID与第 ${seen.get(m.userId)} 行重复 ${m.userId}`, { row });
        else seen.set(m.userId, row);
        if (!isNonEmptyString(m.name)) push('roster', 'NAME_REQUIRED', `第 ${row} 行姓名不能为空`, { row });
        if (!isNonEmptyString(m.studentId)) push('roster', 'STUDENT_ID_REQUIRED', `第 ${row} 行学号不能为空`, { row });
        else if (!STUDENT_ID_PATTERN.test(String(m.studentId))) push('roster', 'STUDENT_ID_FORMAT', `第 ${row} 行学号格式非法：${m.studentId}`, { row });
      });
    }
  }

  if (errors.length > 0) throw new CreationValidationError(errors);

  const validRoster = Array.isArray(roster) ? roster : [];
  // 独立提醒面向创建该任务的本地用户。若保留空名单，执行器会将任务标记为成功却不发送任何提醒。
  const effectiveRoster = !needRoster && has('remind') ? [LOCAL_OWNER] : validRoster;
  const remindAtResolved = has('remind') ? (input.remindAt ?? (needDeadline ? input.deadlineAt : null)) : null;
  return {
    domain: input.domain ?? 'education',
    capabilities,
    taskName: input.taskName.trim(),
    groupId: needGroup ? input.groupId.trim() : null,
    publishText: has('publish') ? input.publishText : null,
    noticeFilePath: has('publish') ? input.noticeFilePath : null,
    publishAt: isRfc3339(input.publishAt) ? input.publishAt : null,
    deadlineAt: isRfc3339(input.deadlineAt) ? input.deadlineAt : null,
    allowedExtensions: has('collect') ? extensions : null,
    keyword: rule.keyword === undefined || rule.keyword === null ? null : rule.keyword.trim(),
    nameTemplate: has('collect') ? nameTemplate : null,
    remindText: has('remind') ? input.remindText : null,
    replyText: has('collect') && isNonEmptyString(input.replyText) ? input.replyText.trim() : '收到，已帮你登记',
    remindAt: remindAtResolved,
    roster: effectiveRoster.map(m => ({ userId: String(m.userId), name: m.name.trim(), studentId: String(m.studentId) })),
    // 发布触发方式：'self_message'(发出关键词触发) | 'scheduled'(到设定时间触发)。默认 self_message。
    // scheduled 复用 publishAt 作为定时触发时间（publish 选中时 publishAt 已必填且校验合法）。
    publishTrigger,
    // 触发关键词：发布 Flow 的 self_message hook 关键词，默认用任务名
    publishKeyword: isNonEmptyString(input.publishKeyword) ? input.publishKeyword.trim() : input.taskName.trim(),
    publishConversationId: isNonEmptyString(input.publishConversationId) ? input.publishConversationId.trim() : 'assistant_main'
  };
}

// 用规范化输入构造本任务专属的作业任务附件（0.3-rc1 协议，按能力裁剪字段）。
// 附件携带 capabilities，validateAttachment 据此条件校验；缺省能力时行为等价 0.2-rc1。
function buildAttachment(normalized, taskAttachmentId, now) {
  const isFullLegacy = normalized.capabilities.length === CAPABILITIES.length;
  return {
    schemaVersion: VERSION,
    taskAttachmentId,
    taskName: normalized.taskName,
    groupId: normalized.groupId ?? null,
    publishAt: normalized.publishAt ?? null,
    deadlineAt: normalized.deadlineAt ?? null,
    sourceFilePath: normalized.noticeFilePath ?? null,
    members: normalized.roster.map(person => ({
      userId: person.userId, name: person.name, studentId: person.studentId,
      submissionStatus: 'unsubmitted', lastSubmittedAt: null, filePath: null, reminderStatus: 'pending', remindedAt: null
    })),
    createdAt: now, updatedAt: now,
    // 全能力（缺省）时不写 capabilities 字段，让附件与旧 0.2-rc1 逐字段等价（兼容红线）。
    ...(isFullLegacy ? {} : { capabilities: normalized.capabilities })
  };
}

// 从零创建一个真实的班委作业任务。返回创建结果（含唯一 id 与专属对象引用）。
// 依赖 service 暴露的仓库与 saveAttachment/saveFlow（走既有 0.2-rc1 校验）。
export async function createAutomationTask(service, input) {
  const idempotencyKey = typeof input?.idempotencyKey === 'string' ? input.idempotencyKey : null;
  const normalized = validateCreateAutomationTaskInput(input);
  const now = service.now();
  const caps = normalized.capabilities;
  const has = cap => caps.includes(cap);
  const stableId = (prefix, part) => `${prefix}_${createHash('sha256').update(`${idempotencyKey}|${part}`).digest('hex').slice(0, 24)}`;

  const automationId = idempotencyKey
    ? stableId('automation', 'automation')
    : id('automation');
  const existing = await service.automations.get(automationId);
  if (existing) {
    const resource = existing.resourceIds[0] ? await service.resources.get(existing.resourceIds[0]) : null;
    const attachment = resource?.payload?.taskAttachmentId ? await service.attachments.get(resource.payload.taskAttachmentId) : null;
    const flows = await Promise.all(existing.flowIds.map(flowId => service.flows.get(flowId)));
    const entity = existing.entityDirectoryIds[0] ? await service.entityDirectories.get(existing.entityDirectoryIds[0]) : true;
    const records = existing.recordStoreIds[0] ? await service.recordStores.get(existing.recordStoreIds[0]) : true;
    if (resource && attachment && flows.every(Boolean) && entity && records) return {
      automationId, taskAttachmentId: attachment.taskAttachmentId, flowIds: [...existing.flowIds],
      resourceId: existing.resourceIds[0] ?? null, entityDirectoryId: existing.entityDirectoryIds[0] ?? null,
      recordStoreId: existing.recordStoreIds[0] ?? null
    };
  }
  const taskAttachmentId = idempotencyKey ? stableId('task', 'attachment') : id('task');

  // 1. 专属附件先落库（按能力裁剪字段；发布初始化动作真实指向本附件）。
  const attachment = buildAttachment(normalized, taskAttachmentId, now);
  await service.saveAttachment(attachment);

  // 2. 按所选能力建 Flow，顺序固定 publish → collect → remind，只建选中的条目。
  const orderedFlowIds = [];
  if (has('publish')) {
    const flowId = idempotencyKey ? stableId('flow', 'publish') : id('flow'); orderedFlowIds.push(flowId);
    // 发布触发方式跟随意图：scheduled=到设定时间触发（runAt=publishAt），否则=发出关键词触发。
    const publishHook = normalized.publishTrigger === 'scheduled'
      ? { type: 'scheduled', params: { runAt: normalized.publishAt, timezone: 'Asia/Shanghai' } }
      : { type: 'self_message', params: { conversationId: normalized.publishConversationId, keyword: normalized.publishKeyword } };
    const publishFlow = instantiateTemplate('homework_publish_v1', {
      flowId, name: `发布：${normalized.taskName}`, status: 'enabled', taskAttachmentId, protocolVersion: FLOW_VERSION,
      hook: publishHook,
      groupId: normalized.groupId, text: normalized.publishText, filePath: normalized.noticeFilePath
    }, attachment, now);
    await service.saveFlow(publishFlow);
  }
  if (has('collect')) {
    const flowId = idempotencyKey ? stableId('flow', 'collect') : id('flow'); orderedFlowIds.push(flowId);
    const collectFlow = instantiateTemplate('homework_collect_v1', {
      flowId, name: `收取：${normalized.taskName}`, status: 'enabled', taskAttachmentId, protocolVersion: FLOW_VERSION, canonicalFileHook: true,
      groupId: normalized.groupId, allowedExtensions: normalized.allowedExtensions,
      ...(normalized.keyword === null ? {} : { keyword: normalized.keyword }),
      nameTemplate: normalized.nameTemplate, replyText: normalized.replyText
    }, attachment, now);
    await service.saveFlow(collectFlow);
  }
  if (has('remind')) {
    const flowId = idempotencyKey ? stableId('flow', 'remind') : id('flow'); orderedFlowIds.push(flowId);
    // 0.3-rc1：提醒时间用独立 remindAt，不再强制 = deadline。
    const remindFlow = instantiateTemplate('homework_remind_v1', {
      flowId, name: `提醒：${normalized.taskName}`, status: 'enabled', taskAttachmentId, protocolVersion: FLOW_VERSION,
      runAt: normalized.remindAt, text: normalized.remindText
    }, attachment, now);
    await service.saveFlow(remindFlow);
  }

  // 3. 通用对象：Automation 恒建；Resource/EntityDirectory/RecordStore 按能力裁剪。
  //    - Resource(EducationAssignmentPack)：描述任务本身，恒建。
  //    - EntityDirectory(名单) + RecordStore(提交记录)：仅 collect（含催未交）才有意义，按能力裁剪。
  const packed = packAutomationDomain(attachment, { automationId, domain: normalized.domain });
  if (idempotencyKey) {
    packed.resource.resourceId = stableId('resource', 'resource');
    if (packed.entityDirectory) packed.entityDirectory.entityDirectoryId = stableId('entitydir', 'entities');
    if (packed.recordStore) packed.recordStore.recordStoreId = stableId('recordstore', 'records');
  }
  const pack = getDomainPack(normalized.domain);
  const automation = createAutomation({
    automationId,
    name: normalized.taskName,
    domain: normalized.domain,
    status: 'enabled',
    plan: {
      packId: pack.packId,
      capabilities: [...normalized.capabilities],
      riskPolicy: normalized.domain === 'finance'
        ? { humanApprovalRequired: true, autoReview: false, autoPayment: false, autoBookkeeping: false }
        : null
    },
    createdAt: now
  });
  automation.flowIds = orderedFlowIds;
  automation.resourceIds = [packed.resource.resourceId];
  await service.resources.save(packed.resource);

  const result = {
    automationId,
    taskAttachmentId,
    flowIds: orderedFlowIds,
    resourceId: packed.resource.resourceId,
    entityDirectoryId: null,
    recordStoreId: null
  };

  if (has('collect')) {
    automation.entityDirectoryIds = [packed.entityDirectory.entityDirectoryId];
    automation.recordStoreIds = [packed.recordStore.recordStoreId];
    await service.entityDirectories.save(packed.entityDirectory);
    await service.recordStores.save(packed.recordStore);
    result.entityDirectoryId = packed.entityDirectory.entityDirectoryId;
    result.recordStoreId = packed.recordStore.recordStoreId;
  }

  await service.automations.save(automation);
  return result;
}
