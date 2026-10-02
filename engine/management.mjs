import { validateAutomation, AUTOMATION_STATUSES } from './objects.mjs';
import { domainLabels, packAutomationDomain } from './domain-packs.mjs';
import { instantiateTemplate } from './templates.mjs';
import { id, isRfc3339 } from './utils.mjs';

// ============================================================================
// P1-A：任务级长期管理（编辑与状态变更）
//
// 管理粒度从「单条 Flow」升级为「任务（Automation）」：用户不接触 Flow ID / JSON，
// 对一个完整任务做 启用/暂停/恢复/结束/删除，改动联动其名下多条 Flow。
//
// 状态语义（Automation → 对其名下 Flow 的联动）：
//   enabled  启用/恢复 → Flow enabled（条件满足即触发）
//   paused   暂停       → Flow disabled（只阻止新事件，运行中的继续到终态）
//   ended    结束       → Flow disabled（不再触发；数据与历史保留可查，属可终止的完结态）
//   deleted  删除       → Flow deleted（软删，保留历史与关联数据，默认列表隐藏）
// ============================================================================

// Automation 状态 → Flow 状态 的联动映射。
const AUTOMATION_TO_FLOW_STATUS = {
  enabled: 'enabled',
  paused: 'disabled',
  ended: 'disabled',
  deleted: 'deleted'
};

// 允许的状态转移。ended/deleted 为终态，不允许再回到 enabled/paused。
const ALLOWED_TRANSITIONS = {
  draft: ['enabled', 'paused', 'ended', 'deleted'],
  enabled: ['paused', 'ended', 'deleted'],
  paused: ['enabled', 'ended', 'deleted'],
  ended: ['deleted'],          // 结束后只能删除（保留历史），不可复活
  deleted: []                  // 删除为最终态
};

export class ManagementError extends Error {
  constructor(message, code = 'MANAGEMENT_INVALID', errors = null) {
    super(message);
    this.name = 'ManagementError';
    this.code = code;
    if (errors) this.errors = errors; // 字段级结构化错误（编辑校验失败时），供前端就地提示
  }
}

// 变更一个任务（Automation）的状态，联动其名下所有 Flow。
// service 需暴露 automations 仓库、flows 仓库、setFlowStatus、now。
export async function setAutomationStatus(service, automationId, nextStatus) {
  if (!AUTOMATION_STATUSES.includes(nextStatus)) throw new ManagementError(`未知任务状态：${nextStatus}`, 'STATUS_UNKNOWN');
  const automation = await service.automations.get(automationId);
  if (!automation) throw new ManagementError('找不到该任务', 'AUTOMATION_NOT_FOUND');

  const current = automation.status;
  if (current === nextStatus) return automation; // 幂等：状态未变直接返回
  const allowed = ALLOWED_TRANSITIONS[current] ?? [];
  if (!allowed.includes(nextStatus)) throw new ManagementError(`任务不能从「${current}」变为「${nextStatus}」`, 'STATUS_TRANSITION_INVALID');

  // 联动名下 Flow：按映射改每条 Flow 状态（deleted 的 Flow 不再改动）。
  const flowStatus = AUTOMATION_TO_FLOW_STATUS[nextStatus];
  for (const flowId of automation.flowIds ?? []) {
    const flow = await service.flows.get(flowId);
    if (!flow || flow.status === 'deleted') continue; // 已删的 Flow 不再联动
    if (flow.status !== flowStatus) await service.setFlowStatus(flowId, flowStatus);
  }

  automation.status = nextStatus;
  automation.updatedAt = service.now();
  validateAutomation(automation);
  await service.automations.save(automation);
  return automation;
}

// 模板 → 能力标识。
const TEMPLATE_TO_CAPABILITY = {
  homework_publish_v1: 'publish',
  homework_collect_v1: 'collect',
  homework_remind_v1: 'remind'
};

// 聚合一个任务的全貌：基础信息 + 能力集 + 名下 Flow 摘要 + 附件（名单/进度）。
// 供前端任务级列表/详情，用户无需接触 Flow ID。找不到返回 null。
export async function getAutomationView(service, automationId) {
  const automation = await service.automations.get(automationId);
  if (!automation) return null;
  return buildView(service, automation);
}

// 列出全部任务视图（默认隐藏已删除，与 Flow 列表口径一致）。
export async function listAutomationViews(service, { includeDeleted = false } = {}) {
  const automations = await service.automations.list({ includeDeleted });
  const views = await Promise.all(automations.map(a => buildView(service, a)));
  // 最近更新在前
  return views.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function buildView(service, automation) {
  const flows = [];
  let attachment = null;
  let publishText = null;
  let remindText = null;
  let totalRuns = 0;
  let lastRunAt = null;
  let lastRunStatus = null;
  for (const flowId of automation.flowIds ?? []) {
    const flow = await service.flows.get(flowId);
    if (!flow) continue;
    if (!attachment && flow.taskAttachmentId) attachment = await service.attachments.get(flow.taskAttachmentId);
    const runs = await service.runs.listByFlow(flowId);
    if (flow.templateId === 'homework_publish_v1') publishText = flow.actions?.find(action => action.type === 'send_group_message_and_file')?.params?.text ?? null;
    if (flow.templateId === 'homework_remind_v1') remindText = flow.actions?.find(action => action.type === 'send_direct_message_batch')?.params?.text ?? null;
    totalRuns += runs.length;
    if (runs[0] && (!lastRunAt || String(runs[0].startedAt).localeCompare(lastRunAt) > 0)) { lastRunAt = runs[0].startedAt; lastRunStatus = runs[0].status; }
    flows.push({ flowId, name: flow.name, templateId: flow.templateId, capability: TEMPLATE_TO_CAPABILITY[flow.templateId] ?? null, status: flow.status, lastRunStatus: runs[0]?.status ?? null, lastRunAt: runs[0]?.startedAt ?? null, runCount: runs.length });
  }
  const capabilities = flows.map(f => f.capability).filter(Boolean);
  const members = attachment?.members ?? [];
  const submitted = members.filter(m => m.submissionStatus === 'submitted').length;
  const labels = domainLabels(automation.domain);
  return {
    automationId: automation.automationId,
    name: automation.name,
    status: automation.status,
    domain: automation.domain,
    capabilities,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    taskAttachmentId: attachment?.taskAttachmentId ?? null,
    groupId: attachment?.groupId ?? null,
    publishAt: attachment?.publishAt ?? null,
    deadlineAt: attachment?.deadlineAt ?? null,
    publishText,
    remindText,
    memberCount: members.length,
    submittedCount: submitted,
    entityCount: members.length,
    completedCount: submitted,
    labels,
    flows,
    totalRuns,
    lastRunAt,
    lastRunStatus
  };
}

// ============================================================================
// 编辑任务字段（P1-A）。patch 为可选字段的部分更新：
//   taskName / publishText / noticeFilePath / deadlineAt / remindText / remindAt
//   collectRule({allowedExtensions,keyword}) / nameTemplate / roster
// 一致性规则（规划第 216 行）：
//   - 已执行的 Run 保留旧快照：编辑只改当前 Flow/附件，Run 快照是创建时 clone，天然不受影响。
//   - 后续事件用新配置：dispatch 每次读最新 enabled Flow，重建 Flow 后即生效。
//   - 改名单不静默删已登记：按 userId merge，保留已 submitted 成员状态；删除已提交成员会报错。
//   - 改截止要重算提醒：改 deadlineAt 后，催未交闭环的 remind Flow 的 runAt 同步重算。
// ============================================================================
const RFC = v => isRfc3339(v);
const isNonEmptyString = v => typeof v === 'string' && v.trim().length > 0;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

// 合并名单：以新名单为目标，保留旧名单里同 userId 成员的提交/提醒状态；
// 删除已提交成员则收集为错误（不静默丢失已登记数据）。
function mergeRoster(oldMembers, newRoster) {
  const errors = [];
  const oldByUser = new Map((oldMembers ?? []).map(m => [m.userId, m]));
  const newUserSet = new Set(newRoster.map(m => String(m.userId)));
  // 被移除且已提交的成员 → 报错
  for (const old of oldMembers ?? []) {
    if (!newUserSet.has(old.userId) && old.submissionStatus === 'submitted') {
      errors.push({ field: 'roster', code: 'REMOVE_SUBMITTED', message: `不能移除已提交的成员 ${old.name || old.userId}（会丢失已登记记录）` });
    }
  }
  const merged = newRoster.map(m => {
    const userId = String(m.userId);
    const prior = oldByUser.get(userId);
    if (prior) {
      // 保留已登记状态，仅更新姓名/学号等身份字段
      return { ...prior, name: m.name?.trim() ?? prior.name, studentId: m.studentId != null ? String(m.studentId) : prior.studentId };
    }
    return { userId, name: m.name?.trim() ?? '', studentId: m.studentId != null ? String(m.studentId) : '', submissionStatus: 'unsubmitted', lastSubmittedAt: null, filePath: null, reminderStatus: 'pending', remindedAt: null };
  });
  return { merged, errors };
}

export async function editAutomationTask(service, automationId, patch = {}) {
  const automation = await service.automations.get(automationId);
  if (!automation) throw new ManagementError('找不到该任务', 'AUTOMATION_NOT_FOUND');
  if (automation.status === 'deleted' || automation.status === 'ended') throw new ManagementError(`任务已${automation.status === 'deleted' ? '删除' : '结束'}，不可编辑`, 'NOT_EDITABLE');

  const now = service.now();
  const errors = [];

  // 载入名下 Flow 与共享附件。
  const flowMap = {};
  let attachment = null;
  for (const flowId of automation.flowIds ?? []) {
    const flow = await service.flows.get(flowId);
    if (!flow || flow.status === 'deleted') continue;
    flowMap[flow.templateId] = flow;
    if (!attachment && flow.taskAttachmentId) attachment = await service.attachments.get(flow.taskAttachmentId);
  }
  if (!attachment) throw new ManagementError('任务附件缺失，无法编辑', 'ATTACHMENT_NOT_FOUND');

  const hasPublish = !!flowMap.homework_publish_v1;
  const hasCollect = !!flowMap.homework_collect_v1;
  const hasRemind = !!flowMap.homework_remind_v1;
  const isUnsubmittedLoop = hasCollect && hasRemind;

  // —— 字段级校验（只校验本次传入的字段）——
  if (patch.taskName !== undefined && !isNonEmptyString(patch.taskName)) errors.push({ field: 'taskName', code: 'REQUIRED', message: '任务名不能为空' });
  if (patch.taskName !== undefined && isNonEmptyString(patch.taskName) && patch.taskName.length > 80) errors.push({ field: 'taskName', code: 'TOO_LONG', message: '任务名不能超过 80 字' });
  if (patch.publishText !== undefined && hasPublish && !isNonEmptyString(patch.publishText)) errors.push({ field: 'publishText', code: 'REQUIRED', message: '发布说明不能为空' });
  if (patch.noticeFilePath !== undefined && hasPublish && !isNonEmptyString(patch.noticeFilePath)) errors.push({ field: 'noticeFilePath', code: 'REQUIRED', message: '通知附件不能为空' });
  if (patch.remindText !== undefined && hasRemind && !isNonEmptyString(patch.remindText)) errors.push({ field: 'remindText', code: 'REQUIRED', message: '提醒文案不能为空' });
  if (patch.deadlineAt !== undefined && patch.deadlineAt !== null && !RFC(patch.deadlineAt)) errors.push({ field: 'deadlineAt', code: 'FORMAT', message: '截止时间必须是带时区的 RFC3339 时间' });
  if (patch.remindAt !== undefined && patch.remindAt !== null && !RFC(patch.remindAt)) errors.push({ field: 'remindAt', code: 'FORMAT', message: '提醒时间必须是带时区的 RFC3339 时间' });
  if (patch.nameTemplate !== undefined && hasCollect && !isNonEmptyString(patch.nameTemplate)) errors.push({ field: 'nameTemplate', code: 'REQUIRED', message: '命名模板不能为空' });
  let mergedRoster = null;
  if (patch.roster !== undefined) {
    if (!Array.isArray(patch.roster) || patch.roster.length === 0) errors.push({ field: 'roster', code: 'REQUIRED', message: '名单至少包含一名成员' });
    else {
      patch.roster.forEach((m, i) => { if (!USER_ID_PATTERN.test(String(m?.userId ?? ''))) errors.push({ field: 'roster', code: 'USER_ID_FORMAT', message: `第 ${i + 1} 行用户ID格式非法`, row: i + 1 }); });
      const { merged, errors: rErrors } = mergeRoster(attachment.members, patch.roster);
      errors.push(...rErrors);
      mergedRoster = merged;
    }
  }
  let allowedExtensions;
  if (patch.collectRule?.allowedExtensions !== undefined && hasCollect) {
    const exts = patch.collectRule.allowedExtensions;
    if (!Array.isArray(exts) || exts.length === 0) errors.push({ field: 'collectRule.allowedExtensions', code: 'REQUIRED', message: '至少声明一个文件扩展名' });
    else if (!exts.every(e => /^\.[A-Za-z0-9]+$/.test(String(e)))) errors.push({ field: 'collectRule.allowedExtensions', code: 'FORMAT', message: '扩展名格式非法（应形如 .docx）' });
    else allowedExtensions = exts;
  }

  if (errors.length > 0) throw new ManagementError(`编辑校验失败，共 ${errors.length} 项`, 'EDIT_INPUT_INVALID', errors);

  // —— 应用到附件 ——（先算出新值，最后统一落库）
  if (patch.taskName !== undefined) attachment.taskName = patch.taskName.trim();
  if (patch.noticeFilePath !== undefined && hasPublish) attachment.sourceFilePath = patch.noticeFilePath.trim();
  if (patch.deadlineAt !== undefined) attachment.deadlineAt = patch.deadlineAt;
  if (mergedRoster) attachment.members = mergedRoster;
  attachment.updatedAt = now;
  await service.saveAttachment(attachment);

  // —— 重建受影响 Flow（保持 flowId 与当前 status 不变，走 validateFlow）——
  const newName = attachment.taskName;
  if (hasPublish && (patch.taskName !== undefined || patch.publishText !== undefined || patch.noticeFilePath !== undefined)) {
    const f = flowMap.homework_publish_v1;
    const rebuilt = instantiateTemplate('homework_publish_v1', {
      flowId: f.flowId, name: `发布：${newName}`, status: f.status, taskAttachmentId: attachment.taskAttachmentId, protocolVersion: f.schemaVersion,
      hook: f.hook, groupId: attachment.groupId,
      text: patch.publishText !== undefined ? patch.publishText : f.actions[1].params.text,
      filePath: patch.noticeFilePath !== undefined ? patch.noticeFilePath.trim() : f.actions[1].params.filePath
    }, attachment, now);
    rebuilt.createdAt = f.createdAt; rebuilt.updatedAt = now; rebuilt.deletedAt = f.deletedAt ?? null;
    await service.saveFlow(rebuilt);
  }
  if (hasCollect && (patch.taskName !== undefined || allowedExtensions !== undefined || patch.collectRule?.keyword !== undefined || patch.nameTemplate !== undefined)) {
    const f = flowMap.homework_collect_v1;
    const priorKeyword = f.hook.params.keyword;
    const keyword = patch.collectRule?.keyword !== undefined ? (isNonEmptyString(patch.collectRule.keyword) ? patch.collectRule.keyword.trim() : undefined) : priorKeyword;
    const rebuilt = instantiateTemplate('homework_collect_v1', {
      flowId: f.flowId, name: `收取：${newName}`, status: f.status, taskAttachmentId: attachment.taskAttachmentId,
      protocolVersion: f.schemaVersion, canonicalFileHook: f.hook.type === 'file_received', groupId: attachment.groupId,
      allowedExtensions: allowedExtensions !== undefined ? allowedExtensions : f.hook.params.allowedExtensions,
      ...(keyword === undefined ? {} : { keyword }),
      nameTemplate: patch.nameTemplate !== undefined ? patch.nameTemplate : f.actions[1].params.nameTemplate,
      replyText: f.actions[3].params.text
    }, attachment, now);
    rebuilt.createdAt = f.createdAt; rebuilt.updatedAt = now; rebuilt.deletedAt = f.deletedAt ?? null;
    await service.saveFlow(rebuilt);
  }
  // 触发因素：改名/改提醒文案/改提醒时间总触发；改截止仅在「催未交闭环」下才影响 remind（重算 runAt），
  // 纯 remind（用独立 remindAt）改截止不应触发无意义重建。
  const remindNeedsRebuild = patch.taskName !== undefined || patch.remindText !== undefined || patch.remindAt !== undefined || (isUnsubmittedLoop && patch.deadlineAt !== undefined);
  if (hasRemind && remindNeedsRebuild) {
    const f = flowMap.homework_remind_v1;
    // 改截止重算提醒：催未交闭环下 runAt 跟随新 deadline；否则用显式 remindAt 或保留原值。
    let runAt = f.hook.params.runAt;
    if (patch.remindAt !== undefined && patch.remindAt) runAt = patch.remindAt;
    else if (isUnsubmittedLoop && patch.deadlineAt !== undefined && patch.deadlineAt) runAt = patch.deadlineAt;
    const rebuilt = instantiateTemplate('homework_remind_v1', {
      flowId: f.flowId, name: `提醒：${newName}`, status: f.status, taskAttachmentId: attachment.taskAttachmentId, protocolVersion: f.schemaVersion,
      runAt, text: patch.remindText !== undefined ? patch.remindText : f.actions[2].params.text
    }, attachment, now);
    rebuilt.createdAt = f.createdAt; rebuilt.updatedAt = now; rebuilt.deletedAt = f.deletedAt ?? null;
    await service.saveFlow(rebuilt);
  }

  // —— 同步通用对象片段（名单/资源随附件更新）——
  if (patch.taskName !== undefined) automation.name = newName;
  automation.updatedAt = now;
  await service.automations.save(automation);
  // 刷新 Resource/EntityDirectory/RecordStore 片段以反映最新附件（保留 id，覆盖内容）。
  const repacked = packAutomationDomain(attachment, { automationId, domain: automation.domain });
  for (const [repo, ids, packedObj, key] of [
    [service.resources, automation.resourceIds, repacked.resource, 'resourceId'],
    [service.entityDirectories, automation.entityDirectoryIds, repacked.entityDirectory, 'entityDirectoryId'],
    [service.recordStores, automation.recordStoreIds, repacked.recordStore, 'recordStoreId']
  ]) {
    const existingId = (ids ?? [])[0];
    if (existingId) { packedObj[key] = existingId; await repo.save(packedObj); }
  }

  return getAutomationView(service, automationId);
}

// 给仍在运行的收作业任务补上催交能力。追加能力会复用原附件和名单，
// 因此已有提交状态、运行记录和消息证据都不会被重置。
export async function addAutomationCapability(service, automationId, capability, options = {}) {
  if (capability !== 'remind') throw new ManagementError('当前只支持为已有收作业任务追加催交', 'CAPABILITY_UNSUPPORTED');
  const automation = await service.automations.get(automationId);
  if (!automation) throw new ManagementError('找不到该任务', 'AUTOMATION_NOT_FOUND');
  if (automation.status === 'deleted' || automation.status === 'ended') throw new ManagementError(`任务已${automation.status === 'deleted' ? '删除' : '结束'}，不可追加能力`, 'NOT_EDITABLE');

  const flowMap = {};
  let attachment = null;
  for (const flowId of automation.flowIds ?? []) {
    const flow = await service.flows.get(flowId);
    if (!flow || flow.status === 'deleted') continue;
    flowMap[flow.templateId] = flow;
    if (!attachment && flow.taskAttachmentId) attachment = await service.attachments.get(flow.taskAttachmentId);
  }
  if (!flowMap.homework_collect_v1) throw new ManagementError('只有已有收作业任务才能追加催交', 'CAPABILITY_PREREQUISITE_MISSING');
  if (flowMap.homework_remind_v1) return getAutomationView(service, automationId);
  if (!attachment) throw new ManagementError('任务附件缺失，无法追加催交', 'ATTACHMENT_NOT_FOUND');

  const remindAt = options.remindAt ?? options.deadlineAt ?? attachment.deadlineAt;
  const remindText = options.remindText ?? `请未交作业的同学尽快提交「${attachment.taskName}」。`;
  const errors = [];
  if (!isNonEmptyString(remindText)) errors.push({ field: 'remindText', code: 'REQUIRED', message: '提醒文案不能为空' });
  if (!isRfc3339(remindAt)) errors.push({ field: 'remindAt', code: 'REQUIRED', message: '追加催交需要提醒时间，请提供带时区的 RFC3339 时间' });
  if (options.deadlineAt !== undefined && !isRfc3339(options.deadlineAt)) errors.push({ field: 'deadlineAt', code: 'FORMAT', message: '截止时间必须是带时区的 RFC3339 时间' });
  if (errors.length) throw new ManagementError(`追加催交校验失败，共 ${errors.length} 项`, 'CAPABILITY_INPUT_INVALID', errors);

  const now = service.now();
  if (!attachment.deadlineAt) {
    attachment.deadlineAt = options.deadlineAt ?? remindAt;
    attachment.updatedAt = now;
    await service.saveAttachment(attachment);
  }
  const flowId = id('flow');
  const remindFlow = instantiateTemplate('homework_remind_v1', {
    flowId,
    name: `提醒：${attachment.taskName}`,
    status: automation.status === 'enabled' ? 'enabled' : 'disabled',
    taskAttachmentId: attachment.taskAttachmentId,
    protocolVersion: flowMap.homework_collect_v1.schemaVersion,
    runAt: remindAt,
    text: remindText.trim()
  }, attachment, now);
  await service.saveFlow(remindFlow);
  automation.flowIds = [...(automation.flowIds ?? []), flowId];
  automation.plan = { ...(automation.plan ?? {}), capabilities: [...new Set([...(automation.plan?.capabilities ?? []), 'remind'])] };
  automation.updatedAt = now;
  validateAutomation(automation);
  await service.automations.save(automation);
  const repacked = packAutomationDomain(attachment, { automationId, domain: automation.domain });
  for (const [repo, ids, packedObj, key] of [
    [service.resources, automation.resourceIds, repacked.resource, 'resourceId'],
    [service.entityDirectories, automation.entityDirectoryIds, repacked.entityDirectory, 'entityDirectoryId'],
    [service.recordStores, automation.recordStoreIds, repacked.recordStore, 'recordStoreId']
  ]) {
    const existingId = (ids ?? [])[0];
    if (existingId && packedObj) { packedObj[key] = existingId; await repo.save(packedObj); }
  }
  return getAutomationView(service, automationId);
}

// 截止检查只读取当前收取进度，不创建催交Flow，也不发送任何消息。
// Demo和未来的主动提醒入口都先调用这里，再由用户决定是否真正催交。
export async function inspectAutomationDeadline(service, automationId) {
  const automation = await service.automations.get(automationId);
  if (!automation) throw new ManagementError('找不到该任务', 'AUTOMATION_NOT_FOUND');
  if (automation.status !== 'enabled') throw new ManagementError('请先恢复这个自动帮办', 'NOT_ENABLED');
  let collectFlow = null;
  for (const flowId of automation.flowIds ?? []) {
    const flow = await service.flows.get(flowId);
    if (flow?.templateId === 'homework_collect_v1' && flow.status === 'enabled') { collectFlow = flow; break; }
  }
  if (!collectFlow) throw new ManagementError('当前任务没有可检查的收作业能力', 'CAPABILITY_PREREQUISITE_MISSING');
  const attachment = await service.attachments.get(collectFlow.taskAttachmentId);
  if (!attachment) throw new ManagementError('任务附件缺失，无法检查进度', 'ATTACHMENT_NOT_FOUND');
  const missingMembers = (attachment.members ?? []).filter(member => member.submissionStatus === 'unsubmitted');
  return {
    automationId,
    taskName: attachment.taskName,
    deadlineAt: attachment.deadlineAt,
    expectedCount: attachment.members?.length ?? 0,
    missingCount: missingMembers.length,
    missingMembers: missingMembers.map(({ userId, name, studentId }) => ({ userId, name, studentId }))
  };
}
