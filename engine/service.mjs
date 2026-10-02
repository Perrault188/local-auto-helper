import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepositories, openSqliteDatabase } from './repositories.mjs';
import { MockAdapters } from './mock-adapters.mjs';
import { FlowExecutor } from './executor.mjs';
import { clone } from './utils.mjs';
import { createConversation, createConversationBinding, createInboundMessage, createMessageRunLink, stableHash, stableObjectId, validateConversation, validateMessage } from './objects.mjs';
import { validateAttachment, validateEvent, validateFlow } from './validation.mjs';
import { createAutomationTask } from './creation.mjs';
import { setAutomationStatus, getAutomationView, listAutomationViews, editAutomationTask, addAutomationCapability, inspectAutomationDeadline } from './management.mjs';
import { FlowScheduler } from './scheduler.mjs';
import { AgentService } from './agent/service.mjs';
import { QwenDashScopeProvider } from './agent/provider.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeClock(clock = () => new Date().toISOString()) {
  return () => {
    const value = clock();
    if (!Number.isNaN(Date.parse(value))) return value;
    const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:)(\d+)(Z|[+-]\d{2}:\d{2})$/);
    if (!match) return new Date().toISOString();
    return new Date(Date.parse(`${match[1]}00${match[3]}`) + Number(match[2]) * 1000).toISOString();
  };
}

export class EngineService {
  // backend 默认 'sqlite'（持久化，重启不丢数据）；仍可传 'json' 走文件后端用于回归对照。
  // 构造函数完全同步，且【不会自动清库】：数据留存交给持久化后端，重置只能通过显式 resetDemo。
  // node:sqlite 为同步 API，SQLite 后端也可在构造时同步装配，无需 await。
  constructor({ dataDir, adapters, now, beforeAction, backend = 'sqlite', repositories, schedulerClock, schedulerIntervalMs, intentProvider, agentTtlMs, faultInjector } = {}) {
    const repos = repositories ?? createRepositories({ kind: backend, dataDir });
    this.backend = backend;
    this.dataDir = dataDir;
    this.db = repos.db;
    this.flows = repos.flows;
    this.attachments = repos.attachments;
    this.runs = repos.runs;
    // 通用对象仓库（P0-B 任务3 初版）：与班委链路并列，暂不接入执行器。
    this.automations = repos.automations;
    this.resources = repos.resources;
    this.recordStores = repos.recordStores;
    this.entityDirectories = repos.entityDirectories;
    this.agentDrafts = repos.agentDrafts;
    this.conversations = repos.conversations;
    this.conversationBindings = repos.conversationBindings;
    this.messageLogs = repos.messageLogs;
    this.messageRunLinks = repos.messageRunLinks;
    this.eventClaims = repos.eventClaims;
    this.runClaims = repos.runClaims;
    this.actionClaims = repos.actionClaims;
    this.effects = repos.effects;
    this.outbox = repos.outbox;
    this.migrations = repos.migrations;
    this.unitOfWork = repos.unitOfWork;
    this.faultInjector = faultInjector;
    this.dispatchQueue = Promise.resolve();
    this.adapters = adapters ?? new MockAdapters({}, { dataDir });
    this.adapters.setMessageProjection?.(() => this.#messageSnapshotSync());
    this.now = safeClock(now);
    // B-2 路线②：把提交记录/名单目录仓库接入执行器，写回附件后同步刷新片段。
    this.executor = new FlowExecutor({ flows: this.flows, attachments: this.attachments, runs: this.runs, adapters: this.adapters, recordStores: this.recordStores, entityDirectories: this.entityDirectories, runClaims: this.runClaims, actionClaims: this.actionClaims, effects: this.effects, outbox: this.outbox, unitOfWork: this.unitOfWork, now: this.now, beforeAction, runIdFor: (eventId, flowId) => this.runIdFor(eventId, flowId), faultInjector });
    const configuredProvider = intentProvider ?? (process.env.DASHSCOPE_API_KEY ? new QwenDashScopeProvider({
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseUrl: process.env.DASHSCOPE_BASE_URL || undefined,
      model: process.env.DASHSCOPE_MODEL || undefined,
      maxTokens: process.env.DASHSCOPE_MAX_TOKENS || undefined,
      maxConcurrency: process.env.DASHSCOPE_MAX_CONCURRENCY || undefined,
      requestsPerMinute: process.env.DASHSCOPE_REQUESTS_PER_MINUTE || undefined
    }) : undefined);
    this.agent = new AgentService({
      drafts: this.agentDrafts, createAutomationTask: input => this.createAutomationTask(input), now: this.now, provider: configuredProvider, ttlMs: agentTtlMs,
      contextLoader: args => this.agentContextOptions(args)
    });
    this.scheduler = new FlowScheduler({
      flows: this.flows,
      runs: this.runs,
      dispatch: event => this.dispatch(event),
      clock: schedulerClock,
      intervalMs: schedulerIntervalMs
    });
  }

  // 异步工厂：为向后兼容保留；SQLite 已可同步构造，本工厂只是同步构造的薄包装。
  static async create(options = {}) {
    return new EngineService(options);
  }

  // P2-M1：业务会话与消息恢复接口。Agent草稿不经过这些入口。
  async ensureConversation({ kind, connector = 'mock', externalKey }) {
    const expected = createConversation({ kind, connector, externalKey, createdAt: new Date().toISOString() });
    const existing = await this.conversations.findByExternal(connector, kind, externalKey);
    if (existing) return existing;
    validateConversation(expected);
    return (await this.conversations.saveIfAbsent(expected)).value;
  }
  async bindConversation({ conversationId, automationId, capability = 'collect', source = 'mock_task_context' }, { allowMissingAutomation = false } = {}) {
    const conversation = await this.conversations.get(conversationId);
    if (!conversation || conversation.kind !== 'direct') return null;
    const automation = await this.automations.get(automationId);
    if (!allowMissingAutomation && (!automation || automation.status !== 'enabled' || !automation.flowIds?.length)) return null;
    const binding = createConversationBinding({ conversationId, automationId, capability, source, createdAt: new Date().toISOString() });
    return this.unitOfWork.run(async () => {
      const current = await this.conversationBindings.listByConversation(conversationId, { capability, active: true });
      if (current.length) return current.length === 1 && current[0].automationId === automationId ? current[0] : null;
      return (await this.conversationBindings.saveIfAbsent(binding)).value;
    });
  }
  runIdFor(eventId, flowId) { return stableObjectId('run', { eventId, flowId }); }
  async #awaitClaimRuns(claim, fallbackEventId, { timeoutMs = 10000, pollMs = 10 } = {}) {
    const canonicalEventId = claim.canonicalEventId ?? fallbackEventId;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const canonicalClaim = await this.eventClaims.get(canonicalEventId);
      const current = canonicalClaim ?? (claim.eventId === canonicalEventId ? claim : null);
      if (current?.status === 'completed') {
        const expectedRunIds = Array.isArray(current.runIds) ? current.runIds : [];
        if (expectedRunIds.length === 0) return [];
        const runs = await Promise.all(expectedRunIds.map(runId => this.runs.get(runId)));
        if (runs.every(run => run && run.status !== 'running')) return runs;
      }
      if (Date.now() >= deadline) {
        const error = new Error(`等待事件${canonicalEventId}的终态Run超时`);
        error.code = 'RUN_CLAIM_TIMEOUT';
        throw error;
      }
      await wait(pollMs);
    }
  }
  async migrateMessageStore() {
    const migration = { migrationId: 'migration_p2_m1_message_store_v1', checksum: stableHash('p2-m1-message-store-v1'), appliedAt: new Date().toISOString() };
    await this.migrations.saveIfAbsent(migration);
    return migration;
  }
  async recoverPendingWork() {
    const claims = await this.eventClaims.list(item => item.status !== 'completed');
    const recovered = [];
    for (const claim of claims) {
      const event = claim.canonicalEvent;
      if (!event) continue;
      let executorOptions = {};
      if (event.payload?.conversationType === 'direct') {
        const binding = claim.routeBindingId ? await this.conversationBindings.get(claim.routeBindingId) : null;
        const automation = binding ? await this.automations.get(binding.automationId) : null;
        if (!binding || !automation) { await this.eventClaims.save({ ...claim, status: 'completed', updatedAt: event.occurredAt }); continue; }
        executorOptions = { allowedFlowIds: automation.flowIds, directRouted: true };
      }
      const runs = await this.executor.dispatch(event, executorOptions);
      for (const run of runs) await this.messageRunLinks.saveIfAbsent(createMessageRunLink({ messageId: claim.physicalMessageId, runId: run.runId, eventId: event.eventId, createdAt: event.occurredAt }));
      await this.#recordRunMessages(runs);
      await this.eventClaims.save({ ...claim, status: 'completed', runIds: runs.map(item => item.runId), updatedAt: event.occurredAt });
      recovered.push(...runs);
    }
    return recovered;
  }
  #messageSnapshotSync() {
    const messages = this.messageLogs.listSync().filter(item => item.direction === 'outbound' && item.deliveryStatus === 'mock_recorded');
    return {
      groupMessages: messages.filter(item => item.effectType === 'group_send').map(item => ({ messageId: item.externalMessageId, fileId: item.file?.fileId ?? null, groupId: item.recipientKey, text: item.text, filePath: item.file?.sourceRef ?? null })),
      directMessages: messages.filter(item => item.effectType === 'direct_send').map(item => ({ messageId: item.externalMessageId, userId: item.recipientKey, text: item.text })),
      replies: messages.filter(item => item.effectType === 'reply').map(item => ({ messageId: item.externalMessageId, senderUserId: item.recipientKey, text: item.text }))
    };
  }
  async messageSnapshot() { return this.#messageSnapshotSync(); }

  // P0-C：从零创建一个真实任务，生成唯一 id 与专属数据，落库 Attachment/三条Flow/通用对象。
  // 校验失败抛出 CreationValidationError（含字段级 errors），供前端就地提示。
  async createAutomationTask(input) { return createAutomationTask(this, input); }
  // P1-A：任务级状态变更（启用/暂停/恢复/结束/删除），联动名下 Flow。
  async setAutomationStatus(automationId, status) { return setAutomationStatus(this, automationId, status); }
  // P1-A：任务级聚合视图（供前端任务级列表/详情，用户无需接触 Flow ID）。
  async getAutomationView(automationId) { return getAutomationView(this, automationId); }
  async listAutomationViews(options) { return listAutomationViews(this, options); }
  async getAutomationEvidence(automationId) {
    const automation = await this.automations.get(automationId);
    if (!automation) return null;
    const flows = (await Promise.all((automation.flowIds ?? []).map(flowId => this.flows.get(flowId)))).filter(Boolean);
    const attachment = flows[0]?.taskAttachmentId ? await this.attachments.get(flows[0].taskAttachmentId) : null;
    const runs = (await Promise.all(flows.map(flow => this.runs.listByFlow(flow.flowId)))).flat()
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const messages = (await this.messageLogs.list()).filter(message => message.automationId === automationId && message.direction === 'outbound')
      .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
    const members = attachment?.members ?? [];
    const memberByUser = new Map(members.map(member => [member.userId, member]));
    const submitted = members.filter(member => member.submissionStatus === 'submitted');
    const missing = members.filter(member => member.submissionStatus !== 'submitted');
    const deliveryCount = effectType => {
      const selected = messages.filter(message => message.effectType === effectType);
      return {
        attempted: selected.length,
        succeeded: selected.filter(message => message.deliveryStatus === 'mock_recorded').length,
        failed: selected.filter(message => message.deliveryStatus !== 'mock_recorded').length
      };
    };
    const lastNoAction = [...runs].reverse().find(run => run.status === 'succeeded_no_action');
    let noActionReason = null;
    if (lastNoAction?.steps?.some(step => step.actionType === 'match_person' && step.status === 'succeeded')) noActionReason = '重复提交，已保留首次文件';
    else if (lastNoAction?.steps?.some(step => step.actionType === 'build_recipient_list' && step.status === 'succeeded')) noActionReason = '当前没有未交成员';
    const artifacts = this.adapters.listArtifacts?.(attachment?.taskAttachmentId) ?? [];
    return {
      automationId,
      taskName: automation.name,
      progress: { expected: members.length, received: submitted.length, missing: missing.length },
      missingMembers: missing.map(member => ({ userId: member.userId, name: member.name, studentId: member.studentId })),
      deliveries: { group: deliveryCount('group_send'), receipt: deliveryCount('reply'), reminder: deliveryCount('direct_send') },
      artifacts: artifacts.map(artifact => ({ ...artifact, memberName: memberByUser.get(artifact.memberUserId)?.name ?? '未知成员' })),
      messages: messages.map(message => ({
        messageId: message.messageId,
        category: message.effectType,
        text: message.text,
        occurredAt: message.occurredAt,
        recipientLabel: message.effectType === 'group_send' ? '班级群' : (memberByUser.get(message.recipientKey)?.name ?? '成员'),
        runId: message.runId,
        actionId: message.actionId,
        deliveryStatus: message.deliveryStatus
      })),
      runs: runs.map(run => ({ runId: run.runId, flowId: run.flowId, status: run.status, startedAt: run.startedAt, errorCode: run.error?.code ?? null })),
      failures: runs.filter(run => run.status === 'failed').map(run => ({ runId: run.runId, code: run.error?.code ?? 'UNKNOWN' })),
      noActionReason,
      summaryText: `应交${members.length}人，已收${submitted.length}人，未交${missing.length}人。提醒发送${deliveryCount('direct_send').succeeded}人，失败${deliveryCount('direct_send').failed}人。`
    };
  }
  async createAutomationArchive(automationId) {
    const evidence = await this.getAutomationEvidence(automationId);
    if (!evidence) return null;
    const automation = await this.automations.get(automationId);
    const flow = await this.flows.get(automation.flowIds?.[0]);
    const taskAttachmentId = flow?.taskAttachmentId;
    if (!taskAttachmentId) return null;
    const download = this.adapters.createArtifactDownload(taskAttachmentId);
    return { downloadUrl: `/api/downloads/${download.token}`, expiresAt: download.expiresAt, fileName: `${automation.name}文件.zip` };
  }
  async consumeAutomationArchive(token) {
    const result = this.adapters.consumeArtifactDownload(token);
    const attachment = await this.attachments.get(result.taskAttachmentId);
    return { content: result.content, fileName: `${attachment?.taskName ?? '任务'}文件.zip` };
  }
  // P1-A：编辑任务字段（改名/截止/文案/名单/收取规则/通知文件），含修改一致性规则。
  async editAutomationTask(automationId, patch) { return editAutomationTask(this, automationId, patch); }
  async addAutomationCapability(automationId, capability, options) { return addAutomationCapability(this, automationId, capability, options); }
  async inspectAutomationDeadline(automationId) { return inspectAutomationDeadline(this, automationId); }
  async sendAutomationReminderNow(automationId, options = {}) {
    const check = await this.inspectAutomationDeadline(automationId);
    if (check.missingCount === 0) return { check, run: null, view: await this.getAutomationView(automationId), sentCount: 0 };
    const at = this.now();
    const view = await this.addAutomationCapability(automationId, 'remind', { remindAt: at, remindText: options.remindText });
    const remindSummary = view.flows.find(flow => flow.templateId === 'homework_remind_v1' && flow.status === 'enabled');
    const remindFlow = remindSummary ? await this.flows.get(remindSummary.flowId) : null;
    if (!remindFlow) throw new Error('催交能力创建后不可用');
    const eventId = stableObjectId('event', { automationId, action: 'remind_now', at, priorRuns: (await this.runs.listByFlow(remindFlow.flowId)).length });
    const runs = await this.dispatch({
      schemaVersion: '0.3-rc1', eventId, type: 'timer_fired', occurredAt: at,
      payload: { scheduledFor: remindFlow.hook.params.runAt, timezone: remindFlow.hook.params.timezone }
    }, { allowedFlowIds: [remindFlow.flowId] });
    return { check, run: runs[0] ?? null, view: await this.getAutomationView(automationId), sentCount: check.missingCount };
  }
  async saveAttachment(value) { validateAttachment(value); return this.attachments.save(value); }
  async saveFlow(value) { const attachment = await this.attachments.get(value.taskAttachmentId); validateFlow(value, attachment); return this.flows.save(value); }
  async setFlowStatus(flowId, status) {
    const flow = await this.flows.get(flowId); if (!flow) return null;
    flow.status = status; flow.updatedAt = this.now(); flow.deletedAt = status === 'deleted' ? flow.updatedAt : null;
    return this.saveFlow(flow);
  }
  async dispatch(event, options = {}) {
    const task = () => this.#dispatchEvent(event, options);
    const next = this.dispatchQueue.then(task, task);
    this.dispatchQueue = next.catch(() => {});
    return next;
  }
  async #dispatchEvent(rawEvent, { trustedRoute, allowedFlowIds = null } = {}) {
    const rawInput = clone(rawEvent);
    if (typeof rawInput?.occurredAt === 'string' && Number.isNaN(Date.parse(rawInput.occurredAt))) {
      const match = rawInput.occurredAt.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:)(\d+)(Z|[+-]\d{2}:\d{2})$/);
      if (match && Number(match[2]) >= 60) rawInput.occurredAt = new Date(Date.parse(`${match[1]}00${match[3]}`) + Number(match[2]) * 1000).toISOString();
    }
    const raw = validateEvent(rawInput);
    let event = raw;
    let conversation = null;
    if (raw.type === 'group_file_received') {
      conversation = await this.conversations.findByExternal('mock', 'group', raw.payload.groupId)
        ?? createConversation({ kind: 'group', connector: 'mock', externalKey: raw.payload.groupId, createdAt: raw.occurredAt });
      event = validateEvent({
        schemaVersion: '0.4-rc1', eventId: raw.eventId, type: 'file_received', occurredAt: raw.occurredAt,
        payload: {
          messageId: raw.payload.messageId,
          conversationId: conversation.conversationId,
          conversationType: 'group',
          senderUserId: raw.payload.senderUserId,
          text: raw.payload.text,
          file: { fileId: raw.payload.file.fileId, name: raw.payload.file.name, sourceRef: `mock-path:${raw.payload.file.path}` }
        }
      });
    } else if (raw.type === 'file_received') {
      conversation = await this.conversations.get(raw.payload.conversationId);
      const validConversation = conversation && conversation.connector === 'mock' && conversation.kind === raw.payload.conversationType;
      if (!validConversation) {
        const error = new Error('统一文件事件引用未知会话'); error.code = 'HOOK_INPUT_INVALID'; throw error;
      }
    }

    if (event.type !== 'file_received') {
      let inbound = null;
      let claim = null;
      if (event.type === 'self_message_sent') {
        conversation = await this.conversations.findByExternal('mock', 'assistant', event.payload.conversationId)
          ?? createConversation({ kind: 'assistant', connector: 'mock', externalKey: event.payload.conversationId, createdAt: event.occurredAt });
        inbound = createInboundMessage({ connector: 'mock', conversation, event, recordedAt: event.occurredAt });
        const payloadHash = stableHash({ type: event.type, occurredAt: event.occurredAt, payload: event.payload });
        claim = { eventId: event.eventId, payloadHash, canonicalEventId: event.eventId, physicalMessageId: inbound.messageId, canonicalEvent: event, routeBindingId: null, status: 'claimed', runIds: [], createdAt: event.occurredAt, updatedAt: event.occurredAt };
        const outcome = await this.unitOfWork.run(async () => {
          const existing = await this.eventClaims.get(event.eventId);
          if (existing) {
            if (existing.payloadHash !== payloadHash) { const error = new Error('相同eventId的事件内容冲突'); error.code = 'EVENT_ID_CONFLICT'; throw error; }
            return existing;
          }
          await this.conversations.saveIfAbsent(conversation);
          await this.messageLogs.saveIfAbsent(inbound);
          await this.eventClaims.saveIfAbsent(claim);
          return null;
        });
        if (outcome) return this.#awaitClaimRuns(outcome, event.eventId);
      }
      const runs = await this.executor.dispatch(event, { allowedFlowIds });
      if (inbound) await this.unitOfWork.run(async () => { for (const run of runs) await this.messageRunLinks.saveIfAbsent(createMessageRunLink({ messageId: inbound.messageId, runId: run.runId, eventId: event.eventId, createdAt: event.occurredAt })); });
      await this.#recordRunMessages(runs);
      if (claim) await this.unitOfWork.run(() => this.eventClaims.save({ ...claim, status: 'completed', runIds: runs.map(item => item.runId), updatedAt: event.occurredAt }));
      return runs;
    }

    const eventPayloadHash = stableHash({ type: event.type, occurredAt: event.occurredAt, payload: event.payload });
    const inbound = createInboundMessage({ connector: 'mock', conversation, event, recordedAt: event.occurredAt });
    const ingressClaim = {
      eventId: event.eventId, payloadHash: eventPayloadHash, canonicalEventId: event.eventId, physicalMessageId: inbound.messageId,
      canonicalEvent: clone(event), routeBindingId: null, status: 'claimed', runIds: [], createdAt: event.occurredAt, updatedAt: event.occurredAt
    };
    let resolvedRoute = null;
    const ingress = await this.unitOfWork.run(async () => {
      const existingClaim = await this.eventClaims.get(event.eventId);
      if (existingClaim) {
        if (existingClaim.payloadHash !== eventPayloadHash) { const error = new Error('相同eventId的事件内容冲突'); error.code = 'EVENT_ID_CONFLICT'; throw error; }
        return { kind: 'event', claim: existingClaim };
      }
      const physical = await this.messageLogs.findByExternal('mock', conversation.conversationId, inbound.externalMessageId);
      if (physical) {
        if (physical.immutableFingerprint !== inbound.immutableFingerprint) { const error = new Error('相同物理消息标识的内容冲突'); error.code = 'MESSAGE_ID_CONFLICT'; throw error; }
        const aliasClaim = { ...ingressClaim, canonicalEventId: physical.eventId, physicalMessageId: physical.messageId, status: 'completed' };
        await this.eventClaims.saveIfAbsent(aliasClaim);
        return { kind: 'physical', claim: aliasClaim };
      }
      validateConversation(conversation);
      await this.conversations.saveIfAbsent(conversation);
      if (event.payload.conversationType === 'direct') {
        resolvedRoute = await this.#resolveDirectRoute(event, trustedRoute);
        if (resolvedRoute) {
          ingressClaim.routeBindingId = resolvedRoute.binding.bindingId;
          ingressClaim.trustedRoute = { automationId: resolvedRoute.binding.automationId, source: resolvedRoute.binding.source };
        }
      }
      await this.messageLogs.saveIfAbsent(inbound);
      this.faultInjector?.({ point: 'ingress_between_message_and_claim', eventId: event.eventId });
      await this.eventClaims.saveIfAbsent(ingressClaim);
      return { kind: 'new', claim: ingressClaim };
    });
    if (ingress.kind !== 'new') return this.#awaitClaimRuns(ingress.claim, event.eventId);
    this.faultInjector?.({ point: 'ingress_after_commit', eventId: event.eventId });

    let executorOptions = {};
    if (event.payload.conversationType === 'direct') {
      if (!resolvedRoute) {
        await this.unitOfWork.run(() => this.eventClaims.save({ ...ingressClaim, status: 'completed', updatedAt: event.occurredAt }));
        return [];
      }
      executorOptions = { allowedFlowIds: resolvedRoute.flowIds, directRouted: true };
    }

    const runs = await this.executor.dispatch(event, executorOptions);
    this.faultInjector?.({ point: 'run_terminal_before_outbound_message', eventId: event.eventId, runIds: runs.map(item => item.runId) });
    await this.unitOfWork.run(async () => { for (const run of runs) await this.messageRunLinks.saveIfAbsent(createMessageRunLink({ messageId: inbound.messageId, runId: run.runId, eventId: event.eventId, createdAt: event.occurredAt })); });
    await this.#recordRunMessages(runs);
    this.faultInjector?.({ point: 'action_after_message', eventId: event.eventId });
    await this.unitOfWork.run(() => this.eventClaims.save({ ...ingressClaim, status: 'completed', runIds: runs.map(item => item.runId), updatedAt: event.occurredAt }));
    return runs;
  }
  async #resolveDirectRoute(event, trustedRoute) {
    let binding = null;
    let automationId = trustedRoute?.automationId ?? null;
    if (!automationId) {
      const existing = await this.conversationBindings.listByConversation(event.payload.conversationId, { capability: 'collect', active: true });
      if (existing.length !== 1) return null;
      [binding] = existing;
      automationId = binding.automationId;
    }
    const automation = await this.automations.get(automationId);
    if (!automation || automation.status !== 'enabled') return null;
    const flows = (await Promise.all((automation.flowIds ?? []).map(flowId => this.flows.get(flowId))))
      .filter(flow => flow && flow.status === 'enabled' && flow.templateId === 'homework_collect_v1');
    if (flows.length !== 1) return null;
    const attachment = await this.attachments.get(flows[0].taskAttachmentId);
    if (!attachment?.members?.some(member => member.userId === event.payload.senderUserId)) return null;
    if (!binding) {
      binding = await this.bindConversation({ conversationId: event.payload.conversationId, automationId, capability: 'collect', source: trustedRoute.source ?? 'mock_task_context' });
      if (!binding) return null;
    }
    return { binding, flowIds: [flows[0].flowId] };
  }
  async #recordRunMessages(runs) {
    for (const run of runs) {
      const automation = (await this.automations.list({ includeDeleted: true })).find(item => item.flowIds?.includes(run.flowId)) ?? null;
      for (const step of run.steps) {
        if (!['send_group_message_and_file','reply_to_sender','send_direct_message_batch'].includes(step.actionType) || !['succeeded','failed'].includes(step.status)) continue;
        const recipients = step.actionType === 'send_direct_message_batch' ? (step.input.userIds ?? []) : [step.actionType === 'send_group_message_and_file' ? step.input.groupId : step.input.senderUserId];
        const effectKey = stableObjectId('action', { runId: run.runId, actionId: step.actionId, recipientKey: '*' });
        for (const [index, recipientKey] of recipients.entries()) {
          const actionKey = stableObjectId('action', { runId: run.runId, actionId: step.actionId, recipientKey });
          const existing = await this.messageLogs.get(stableObjectId('msg', { actionKey }));
          if (existing) {
            const pending = await this.outbox.get(actionKey);
            if (pending?.journalStatus !== 'committed') await this.outbox.save({ ...pending, actionKey, effectKey, messageId: existing.messageId, status: existing.deliveryStatus, journalStatus: 'committed', updatedAt: this.now() });
            continue;
          }
          const delivery = step.actionType === 'send_direct_message_batch' ? step.output?.deliveries?.[index] : null;
          const outputId = step.actionType === 'send_direct_message_batch' ? (delivery?.messageId ?? step.output?.messageIds?.[index]) : step.output?.messageId;
          const conversation = step.actionType === 'send_group_message_and_file'
            ? await this.ensureConversation({ kind: 'group', connector: 'mock', externalKey: recipientKey })
            : step.actionType === 'reply_to_sender' && step.input.conversationId
              ? await this.conversations.get(step.input.conversationId)
              : await this.ensureConversation({ kind: 'direct', connector: 'mock', externalKey: `owner:${recipientKey}` });
          const status = delivery ? delivery.status : step.status === 'succeeded' && outputId ? 'mock_recorded' : 'failed';
          const file = step.actionType === 'send_group_message_and_file' ? { fileId: step.output?.fileId ?? null, name: step.input.filePath?.split('/').pop() ?? 'file', sourceRef: step.input.filePath } : null;
          const message = {
            messageSchemaVersion: '1.0', messageId: stableObjectId('msg', { actionKey }), externalMessageId: outputId ?? stableObjectId('mock_failed', { actionKey }), connector: 'mock',
            conversationId: conversation?.conversationId ?? null, direction: 'outbound', kind: file ? 'text_file' : 'text',
            effectType: step.actionType === 'send_group_message_and_file' ? 'group_send' : step.actionType === 'reply_to_sender' ? 'reply' : 'direct_send',
            senderRef: 'local-auto-helper', recipientKey, text: step.input.text ?? null, file, occurredAt: step.finishedAt ?? run.finishedAt ?? this.now(), recordedAt: this.now(), eventId: run.eventId,
            automationId: automation?.automationId ?? null, flowId: run.flowId, runId: run.runId, actionId: step.actionId, actionKey, effectKey, deliveryStatus: status,
            payloadHash: stableHash({ actionKey, recipientKey, text: step.input.text ?? null, file }), immutableFingerprint: stableHash({ actionKey, recipientKey })
          };
          validateMessage(message);
          await this.unitOfWork.run(async () => {
            await this.messageLogs.saveIfAbsent(message);
            const pending = await this.outbox.get(actionKey);
            await this.outbox.save({ ...(pending ?? {}), actionKey, effectKey, runId: run.runId, actionId: step.actionId, recipientKey, messageId: message.messageId, status, journalStatus: 'committed', createdAt: pending?.createdAt ?? message.recordedAt, updatedAt: message.recordedAt });
          });
        }
      }
    }
  }
  async tickScheduler(at) { return this.scheduler.tick(at); }
  startScheduler(options) { this.scheduler.start(options); }
  stopScheduler() { this.scheduler.stop(); }
  async markRunViewed(runId) { const run = await this.runs.get(runId); if (!run) return null; run.viewedAt = this.now(); return this.runs.save(run); }
  async listFlowSummaries() {
    const flows = await this.flows.list();
    return Promise.all(flows.map(async flow => { const runs = await this.runs.listByFlow(flow.flowId); return { flowId: flow.flowId, name: flow.name, status: flow.status, templateId: flow.templateId, updatedAt: flow.updatedAt, lastRunAt: runs[0]?.startedAt ?? null, lastRunStatus: runs[0]?.status ?? null, runCount: runs.length }; }));
  }
  async unseenFailureCount() { return this.runs.unseenFailureCount(); }
  async agentContextOptions({ draft, demoSeed } = {}) {
    const options = [];
    const push = (field, value, label, source = 'authorized') => { if (value !== undefined && value !== null && !options.some(item => item.field === field && JSON.stringify(item.value) === JSON.stringify(value))) options.push({ field, value, label, source }); };
    const bindings = draft?.planSpec?.bindings ?? {};
    for (const field of ['groupId', 'noticeFilePath', 'nameTemplate', 'roster', 'submitters', 'stores']) if (bindings[field] !== undefined) push(field, structuredClone(bindings[field]), `当前草稿${field}`);
    const seedAttachments = demoSeed?.attachments ?? [];
    const domain = draft?.planSpec?.domain ?? draft?.candidateUnderstandings?.[0]?.domain;
    if (domain === 'education') {
      push('publishTrigger', 'self_message', '我发出约定消息时', 'demo');
      push('publishTrigger', 'scheduled', '到设定时间', 'demo');
      push('nameTemplate', '{studentId}_{name}{originalExtension}', '学号_姓名（保留原文件类型）', 'demo');
      push('nameTemplate', '{name}_{studentId}{originalExtension}', '姓名_学号（保留原文件类型）', 'demo');
      push('replyText', '收到，已帮你登记', '回复“收到，已帮你登记”', 'demo');
      push('replyText', '收到，文件已按要求保存', '回复“收到，文件已按要求保存”', 'demo');
      push('remindText', '作业还没提交，请尽快补交。', '发送“作业还没提交，请尽快补交”', 'demo');
      push('remindText', '截止时间已到，请尽快提交作业。', '发送“截止时间已到，请尽快提交作业”', 'demo');
      for (const attachment of seedAttachments) {
        if (attachment.groupId) push('groupId', attachment.groupId, demoSeed?.group?.name ?? attachment.groupId, 'demo');
        if (attachment.sourceFilePath) push('noticeFilePath', attachment.sourceFilePath, attachment.sourceFilePath.split('/').pop(), 'demo');
        if (attachment.members?.length) push('roster', attachment.members.map(({ userId, name, studentId }) => ({ userId, name, studentId })), `${attachment.taskName}演示名单`, 'demo');
      }
      push('groupId', '软件工程2024级2班', '软件工程2024级2班', 'demo');
      push('groupId', '计算机科学2024级1班', '计算机科学2024级1班', 'demo');
      push('collectRule', { allowedExtensions: ['.doc'] }, 'DOC', 'demo');
      push('collectRule', { allowedExtensions: ['.pdf'] }, 'PDF', 'demo');
      push('roster', [
        { userId: '1100012345', name: '演示成员甲', studentId: '20241001' },
        { userId: '1100012346', name: '演示成员乙', studentId: '20241002' },
        { userId: '1100012347', name: '演示成员丙', studentId: '20241003' }
      ], '软件工程2024级2班名单', 'demo');
      push('roster', [
        { userId: '1200012345', name: '演示成员丁', studentId: '20242001' },
        { userId: '1200012346', name: '演示成员戊', studentId: '20242002' },
        { userId: '1200012347', name: '演示成员己', studentId: '20242003' }
      ], '计算机科学2024级1班名单', 'demo');
    }
    if (domain === 'finance') {
      push('nameTemplate', '{studentId}_{name}{originalExtension}', '项目编号_提交人（保留原文件类型）', 'demo');
      push('nameTemplate', '{name}_{studentId}{originalExtension}', '提交人_项目编号（保留原文件类型）', 'demo');
      push('groupId', 'group_finance_demo', '财务单据演示群', 'demo');
      push('collectRule', { allowedExtensions: ['.pdf', '.jpg', '.png'], keyword: '单据' }, 'PDF/JPG/PNG，文件名包含“单据”', 'demo');
      push('collectRule', { allowedExtensions: ['.pdf'] }, '仅PDF，不限文件名', 'demo');
      push('submitters', [{ userId: '7000012345', name: '演示提交人', entityId: 'PROJECT_DEMO' }], '演示提交人与项目清单', 'demo');
    }
    if (domain === 'retail') {
      push('nameTemplate', '{studentId}_{name}{originalExtension}', '门店编号_门店名（保留原文件类型）', 'demo');
      push('nameTemplate', '{name}_{studentId}{originalExtension}', '门店名_门店编号（保留原文件类型）', 'demo');
      push('groupId', 'group_retail_demo', '门店日报演示群', 'demo');
      push('collectRule', { allowedExtensions: ['.docx', '.xlsx', '.pdf'], keyword: '日报' }, 'DOCX/XLSX/PDF，文件名包含“日报”', 'demo');
      push('collectRule', { allowedExtensions: ['.xlsx'] }, '仅XLSX，不限文件名', 'demo');
      push('replyText', '日报已登记。', '回复“日报已登记”', 'demo');
      push('replyText', '收到，今日日报已登记。', '回复“收到，今日日报已登记”', 'demo');
      push('remindText', '今日日报尚未登记，请尽快提交。', '发送“今日日报尚未登记，请尽快提交”', 'demo');
      push('remindText', '请尽快补交今日日报。', '发送“请尽快补交今日日报”', 'demo');
      push('stores', [{ ownerUserId: '7100012345', storeName: '演示一店', storeId: 'STORE_DEMO' }], '演示门店与负责人清单', 'demo');
    }
    return options;
  }

  // 显式开发/演示重置：清空核心数据并按种子重建。仅供开发或演示命令调用，
  // 不在服务启动时自动执行（去掉「启动即 reset」）。也清空通用对象表，保证演示可重复。
  async resetDemo(seed) {
    await this.flows.replaceAll(seed.flows.map(clone));
    await this.attachments.replaceAll(seed.attachments.map(clone));
    await this.runs.replaceAll([]);
    await this.automations.replaceAll([]);
    await this.resources.replaceAll([]);
    await this.recordStores.replaceAll([]);
    await this.entityDirectories.replaceAll([]);
    await this.agentDrafts.replaceAll([]);
    await this.conversations.replaceAll([]);
    await this.conversationBindings.replaceAll([]);
    await this.messageLogs.replaceAll([]);
    await this.messageRunLinks.replaceAll([]);
    await this.eventClaims.replaceAll([]);
    await this.runClaims.replaceAll([]);
    await this.actionClaims.replaceAll([]);
    await this.effects.replaceAll([]);
    await this.outbox.replaceAll([]);
    this.adapters.clearArtifacts?.();
    this.adapters.closeConnectorJournal?.();
    this.adapters = new MockAdapters(seed.adapterState, { dataDir: this.dataDir, resetConnectorJournal: true });
    this.adapters.setMessageProjection?.(() => this.#messageSnapshotSync());
    this.executor.adapters = this.adapters;
  }
  // 向后兼容别名：现有测试与过渡期调用点仍可用 reset；语义等同显式 resetDemo。
  async reset(seed) { return this.resetDemo(seed); }
}

export async function loadDemoSeed(fixturesDir) {
  return JSON.parse(await readFile(join(fixturesDir, 'demo-seed.json'), 'utf8'));
}
