import { extname } from 'node:path';
import { clone, errorRecord, assert, RUN_VERSION } from './utils.mjs';
import { validateEvent } from './validation.mjs';
import { projectRecordStoreRecords } from './domain-packs.mjs';
import { stableObjectId } from './objects.mjs';
import { renamedFileName } from './mock-adapters.mjs';

export function hookMatches(flow, event, { directRouted = false } = {}) {
  const { hook } = flow;
  if (hook.type === 'self_message') return event.type === 'self_message_sent' && event.payload.conversationId === hook.params.conversationId && event.payload.text.includes(hook.params.keyword);
  if (hook.type === 'scheduled') return event.type === 'timer_fired' && event.payload.scheduledFor === hook.params.runAt && event.payload.timezone === hook.params.timezone;
  if (hook.type === 'file_received') {
    if (event.type !== 'file_received') return false;
    const sameConversation = event.payload.conversationType === hook.params.conversationType && event.payload.conversationId === hook.params.conversationId;
    if (!sameConversation && !(directRouted && event.payload.conversationType === 'direct')) return false;
    const extensionMatches = hook.params.allowedExtensions.some(item => item.toLowerCase() === extname(event.payload.file.name).toLowerCase());
    const keyword = hook.params.keyword?.trim();
    return extensionMatches && (!keyword || event.payload.file.name.includes(keyword));
  }
  return false;
}

function flowForExecution(flow) {
  if (flow.hook?.type !== 'group_file_received') return clone(flow);
  return {
    ...clone(flow),
    schemaVersion: '0.4-rc1',
    hook: {
      type: 'file_received',
      params: {
        conversationType: 'group',
        conversationId: stableObjectId('conv', { connector: 'mock', kind: 'group', externalKey: flow.hook.params.groupId }),
        groupId: flow.hook.params.groupId,
        ...(flow.hook.params.keyword === undefined ? {} : { keyword: flow.hook.params.keyword }),
        allowedExtensions: clone(flow.hook.params.allowedExtensions)
      }
    }
  };
}

export class FlowExecutor {
  // B-2 路线②：接通 recordStores/entityDirectories 仓库（可选），写回附件后同步刷新提交记录片段，
  // 让通用对象片段与附件一致（消除「创建期只读死快照」）。附件仍是提交/催交状态权威源（D021 不变）。
  constructor({ flows, attachments, runs, adapters, recordStores = null, entityDirectories = null, runClaims = null, actionClaims = null, effects = null, outbox = null, unitOfWork = null, now = () => new Date().toISOString(), beforeAction, runIdFor, faultInjector }) {
    Object.assign(this, { flows, attachments, runs, adapters, recordStores, entityDirectories, runClaims, actionClaims, effects, outbox, unitOfWork, now, beforeAction, faultInjector });
    this.runIdFor = runIdFor ?? ((eventId, flowId) => stableObjectId('run', { eventId, flowId }));
  }
  // 把附件当前 members 同步刷新到对应 RecordStore 片段（尽力而为：无仓库/无片段则跳过，不影响主链路）。
  async #syncRecordStore(attachment) {
    if (!this.recordStores || !attachment) return;
    try {
      const store = await this.recordStores.findByAttachment(attachment.taskAttachmentId);
      if (!store) return;
      store.records = projectRecordStoreRecords(store, attachment.members ?? []);
      store.updatedAt = this.now();
      await this.recordStores.save(store);
    } catch (error) { /* 同步失败不阻断执行主链路（附件仍为权威源），但留一条可观测日志便于排障 */ console.warn(`[executor] RecordStore 片段同步失败 attachment=${attachment.taskAttachmentId}: ${error?.message ?? error}`); }
  }
  async dispatch(rawEvent, { allowedFlowIds = null, directRouted = false } = {}) {
    const event = validateEvent(clone(rawEvent));
    if (event.type === 'file_received') this.adapters.receiveFile({ ...event.payload.file, path: event.payload.file.sourceRef });
    if (event.type === 'timer_fired') this.adapters.fireTimer(event);
    const enabled = (await this.flows.list({ status: 'enabled' })).map(flowForExecution);
    const allowed = allowedFlowIds ? new Set(allowedFlowIds) : null;
    const matched = enabled.filter(flow => (!allowed || allowed.has(flow.flowId)) && hookMatches(flow, event, { directRouted }));
    const results = [];
    for (const flow of matched) {
      const existing = await this.runs.findByEventFlow(event.eventId, flow.flowId);
      if (existing && existing.status !== 'running') { results.push(existing); continue; }
      results.push(await this.execute(flow, event, existing));
    }
    return results;
  }
  async execute(flow, event, existingRun = null) {
    const startedAt = this.now();
    const run = existingRun ?? { schemaVersion: RUN_VERSION, runId: this.runIdFor(event.eventId, flow.flowId), flowId: flow.flowId, eventId: event.eventId, status: 'running', startedAt, finishedAt: null, viewedAt: null, error: null, flowSnapshot: clone(flow), eventSnapshot: clone(event), steps: flow.actions.map(action => ({ actionId: action.actionId, actionType: action.type, status: 'skipped', startedAt: null, finishedAt: null, input: {}, output: null, error: null })) };
    if (!existingRun) {
      await (this.unitOfWork?.run ?? (work => work())).call(this.unitOfWork, async () => {
        await this.runs.saveIfAbsent(run);
        await this.runClaims?.saveIfAbsent({ claimId: stableObjectId('runclaim', { eventId: event.eventId, flowId: flow.flowId }), runId: run.runId, eventId: event.eventId, flowId: flow.flowId, status: 'running', createdAt: startedAt, updatedAt: startedAt });
        this.faultInjector?.({ point: 'run_after_reserve', runId: run.runId });
      });
    }
    const context = {};
    let terminalNoAction = false;
    for (let index = 0; index < flow.actions.length; index += 1) {
      const action = flow.actions[index];
      const previous = run.steps[index];
      if (previous.status === 'succeeded') {
        Object.assign(context, clone(previous.output ?? {}));
        terminalNoAction = (action.type === 'match_person' && previous.output?.isDuplicate) || (action.type === 'build_recipient_list' && previous.output?.userIds?.length === 0);
        continue;
      }
      if (terminalNoAction) break;
      const actionKey = stableObjectId('action', { runId: run.runId, actionId: action.actionId, recipientKey: '*' });
      try {
        await this.beforeAction?.({ action, index, flow: clone(flow), event: clone(event) });
        const input = previous.status === 'running' && previous.input ? clone(previous.input) : this.#input(action, event, context, flow);
        const stepStarted = previous.startedAt ?? this.now();
        run.steps[index] = { ...previous, status: 'running', startedAt: stepStarted, input: clone(input), error: null };
        await (this.unitOfWork?.run ?? (work => work())).call(this.unitOfWork, async () => {
          await this.runs.save(run);
          await this.actionClaims?.saveIfAbsent({ actionKey, runId: run.runId, actionId: action.actionId, actionIndex: index, status: 'running', createdAt: stepStarted, updatedAt: stepStarted });
        });
        let output;
        let partialFailure = false;
        const connectorAction = ['send_group_message_and_file','reply_to_sender','send_direct_message_batch'].includes(action.type);
        let existingEffect = await this.effects?.get(actionKey);
        const deliveryMode = existingEffect?.deliveryMode ?? (this.adapters.supportsIdempotency?.(action.type) === false ? 'non_idempotent' : 'idempotent');
        const commitOutcome = async () => {
          partialFailure = Boolean(output?.partialFailure);
          const partialError = partialFailure ? { code: 'ADAPTER_ERROR', message: '部分Mock私信写入失败', recoverable: true } : null;
          await (this.unitOfWork?.run ?? (work => work())).call(this.unitOfWork, async () => {
            await this.effects?.save({
              ...(existingEffect ?? {}), effectKey: actionKey, actionKey, runId: run.runId, actionId: action.actionId, actionIndex: index,
              status: partialFailure ? 'failed' : 'applied', deliveryMode, input: clone(input), output: clone(output), error: partialError,
              createdAt: existingEffect?.createdAt ?? this.now(), updatedAt: this.now()
            });
            this.faultInjector?.({ point: 'action_after_business_state', runId: run.runId, actionId: action.actionId });
            run.steps[index] = { ...run.steps[index], status: partialFailure ? 'failed' : 'succeeded', finishedAt: this.now(), output: clone(output), error: partialError };
            if (partialFailure) { run.status = 'failed'; run.error = partialError; run.finishedAt = this.now(); }
            for (const record of this.#pendingOutbox(action, run, input, output, 'pending')) await this.outbox?.saveIfAbsent(record);
            await this.runs.save(run);
            await this.actionClaims?.save({ actionKey, runId: run.runId, actionId: action.actionId, actionIndex: index, status: 'committed', error: partialError, createdAt: stepStarted, updatedAt: this.now() });
            if (partialFailure) await this.runClaims?.save({ claimId: stableObjectId('runclaim', { eventId: event.eventId, flowId: flow.flowId }), runId: run.runId, eventId: event.eventId, flowId: flow.flowId, status: 'failed', updatedAt: this.now() });
          });
        };
        if (connectorAction) {
          if (existingEffect?.status === 'performing' && deliveryMode === 'non_idempotent') {
            const error = new Error('Connector执行结果未知，禁止自动重试');
            error.code = 'DELIVERY_OUTCOME_UNKNOWN';
            error.recoverable = false;
            throw error;
          }
          if (!existingEffect) {
            existingEffect = {
              effectKey: actionKey, actionKey, runId: run.runId, actionId: action.actionId, actionIndex: index,
              status: 'performing', deliveryMode, input: clone(input), output: null, error: null, createdAt: this.now(), updatedAt: this.now()
            };
            await (this.unitOfWork?.run ?? (work => work())).call(this.unitOfWork, () => this.effects?.save(existingEffect));
          }
          output = existingEffect.status === 'applied' ? clone(existingEffect.output) : await this.#action(action, event, context, input, { effectKey: actionKey });
          this.faultInjector?.({ point: 'connector_after_perform', runId: run.runId, actionId: action.actionId, effectKey: actionKey, deliveryMode });
          await commitOutcome();
        } else {
          await (this.unitOfWork?.run ?? (work => work())).call(this.unitOfWork, async () => {
            output = existingEffect?.output ?? await this.#action(action, event, context, input);
            await commitOutcome();
          });
        }
        Object.assign(context, output);
        if (partialFailure) return clone(run);
        terminalNoAction = (action.type === 'match_person' && output.isDuplicate) || (action.type === 'build_recipient_list' && output.userIds.length === 0);
      } catch (error) {
        if (error?.code === 'INJECTED_CRASH') throw error;
        const record = errorRecord(error);
        run.steps[index] = { ...run.steps[index], status: 'failed', startedAt: run.steps[index].startedAt ?? this.now(), finishedAt: this.now(), output: clone(error.partialOutput ?? null), error: record };
        run.status = 'failed'; run.error = record; run.finishedAt = this.now();
        await (this.unitOfWork?.run ?? (work => work())).call(this.unitOfWork, async () => {
          await this.runs.save(run);
          await this.actionClaims?.save({ actionKey, runId: run.runId, actionId: action.actionId, actionIndex: index, status: 'committed', error: record, createdAt: run.steps[index].startedAt, updatedAt: this.now() });
          const reservedEffect = await this.effects?.get(actionKey);
          await this.effects?.save({ ...(reservedEffect ?? {}), effectKey: actionKey, actionKey, runId: run.runId, actionId: action.actionId, actionIndex: index, status: 'failed', input: clone(run.steps[index].input), output: clone(error.partialOutput ?? reservedEffect?.output ?? null), error: record, createdAt: reservedEffect?.createdAt ?? this.now(), updatedAt: this.now() });
          for (const outbox of this.#pendingOutbox(action, run, run.steps[index].input, error.partialOutput ?? null, 'pending')) await this.outbox?.saveIfAbsent(outbox);
          await this.runClaims?.save({ claimId: stableObjectId('runclaim', { eventId: event.eventId, flowId: flow.flowId }), runId: run.runId, eventId: event.eventId, flowId: flow.flowId, status: 'failed', updatedAt: this.now() });
        });
        return clone(run);
      }
    }
    this.faultInjector?.({ point: 'run_before_terminal', runId: run.runId });
    run.status = terminalNoAction ? 'succeeded_no_action' : 'succeeded';
    run.finishedAt = this.now();
    await (this.unitOfWork?.run ?? (work => work())).call(this.unitOfWork, async () => {
      await this.runs.save(run);
      await this.runClaims?.save({ claimId: stableObjectId('runclaim', { eventId: event.eventId, flowId: flow.flowId }), runId: run.runId, eventId: event.eventId, flowId: flow.flowId, status: run.status, updatedAt: this.now() });
    });
    return clone(run);
  }
  #input(action, event, context, flow) {
    const payload = event.payload;
    switch (action.type) {
      case 'initialize_task_attachment': return { taskAttachmentId: action.params.taskAttachmentId };
      case 'send_group_message_and_file': return clone(action.params);
      case 'match_person': return { taskAttachmentId: action.params.taskAttachmentId, userId: payload.senderUserId, originalFile: clone(payload.file) };
      case 'rename_received_file': return { filePath: payload.file.sourceRef, person: clone(context.person), taskAttachmentId: flow.taskAttachmentId, userId: payload.senderUserId, nameTemplate: action.params.nameTemplate };
      case 'mark_submission': return { taskAttachmentId: action.params.taskAttachmentId, userId: payload.senderUserId, filePath: context.filePath };
      case 'reply_to_sender': return { senderUserId: payload.senderUserId, conversationId: payload.conversationId, conversationType: payload.conversationType, text: action.params.text };
      case 'read_unsubmitted': return { taskAttachmentId: action.params.taskAttachmentId };
      case 'build_recipient_list': return { members: clone(context.members) };
      case 'send_direct_message_batch': return { userIds: clone(context.userIds), text: action.params.text };
      default: return {};
    }
  }
  #pendingOutbox(action, run, input, output, journalStatus) {
    if (!['send_group_message_and_file','reply_to_sender','send_direct_message_batch'].includes(action.type)) return [];
    const recipients = action.type === 'send_direct_message_batch' ? (input.userIds ?? []) : [action.type === 'send_group_message_and_file' ? input.groupId : input.senderUserId];
    const effectKey = stableObjectId('action', { runId: run.runId, actionId: action.actionId, recipientKey: '*' });
    return recipients.map((recipientKey, index) => {
      const actionKey = stableObjectId('action', { runId: run.runId, actionId: action.actionId, recipientKey });
      const delivery = action.type === 'send_direct_message_batch' ? output?.deliveries?.[index] : null;
      return {
        actionKey, effectKey, runId: run.runId, actionId: action.actionId, recipientKey,
        input: clone(input), output: clone(output), delivery: clone(delivery),
        journalStatus, createdAt: this.now(), updatedAt: this.now()
      };
    });
  }
  async #action(action, event, context, input, { effectKey } = {}) {
    if (action.type === 'initialize_task_attachment') { const attachment = await this.attachments.get(input.taskAttachmentId); assert(attachment, '找不到作业任务附件', 'ATTACHMENT_NOT_FOUND'); return { taskAttachmentId: attachment.taskAttachmentId }; }
    if (action.type === 'send_group_message_and_file') return this.adapters.sendGroupMessageAndFile({ ...input, effectKey });
    if (action.type === 'match_person') {
      const attachment = await this.attachments.get(input.taskAttachmentId); assert(attachment, '找不到作业任务附件', 'ATTACHMENT_NOT_FOUND');
      const person = (attachment.members ?? []).find(member => member.userId === input.userId); assert(person, `用户ID${input.userId}不在花名册`, 'PERSON_NOT_FOUND');
      return { person: clone(person), userId: person.userId, name: person.name, studentId: person.studentId, isDuplicate: person.submissionStatus === 'submitted' };
    }
    if (action.type === 'rename_received_file') { assert(context.person, '缺少人员映射结果'); const output = this.adapters.copyOrRenameFile(input.filePath, renamedFileName(input.nameTemplate, context.person, input.filePath), { taskAttachmentId: input.taskAttachmentId, memberUserId: input.userId }); return output; }
    if (action.type === 'mark_submission') {
      const attachment = await this.attachments.get(input.taskAttachmentId); assert(attachment, '找不到作业任务附件', 'ATTACHMENT_NOT_FOUND');
      const person = (attachment.members ?? []).find(member => member.userId === input.userId); assert(person && input.filePath, '缺少登记输入');
      person.submissionStatus = 'submitted'; person.lastSubmittedAt = event.occurredAt; person.filePath = input.filePath; person.reminderStatus = 'not_needed'; person.remindedAt = null; attachment.updatedAt = this.now(); await this.attachments.save(attachment);
      await this.#syncRecordStore(attachment);
      return { submissionStatus: 'submitted', reminderStatus: 'not_needed', filePath: input.filePath };
    }
    if (action.type === 'reply_to_sender') return this.adapters.replyToSender({ ...input, effectKey });
    if (action.type === 'read_unsubmitted') { const attachment = await this.attachments.get(input.taskAttachmentId); assert(attachment, '找不到作业任务附件', 'ATTACHMENT_NOT_FOUND'); return { taskAttachmentId: input.taskAttachmentId, members: (attachment.members ?? []).filter(member => member.submissionStatus === 'unsubmitted').map(clone) }; }
    if (action.type === 'build_recipient_list') return { userIds: [...new Set(input.members.map(member => member.userId))] };
    if (action.type === 'send_direct_message_batch') {
      const output = this.adapters.sendDirectMessageBatch({ ...input, effectKey });
      const succeeded = new Set((output.deliveries ?? []).filter(item => item.status === 'mock_recorded').map(item => item.userId));
      const target = await this.attachments.get(context.taskAttachmentId);
      if (target) {
        for (const member of (target.members ?? [])) if (succeeded.has(member.userId) && member.submissionStatus === 'unsubmitted') { member.reminderStatus = 'sent'; member.remindedAt = event.occurredAt; }
        target.updatedAt = this.now(); await this.attachments.save(target); await this.#syncRecordStore(target);
      }
      return { ...output, partialFailure: (output.deliveries ?? []).some(item => item.status === 'failed') };
    }
    assert(false, `未知Action ${action.type}`);
  }
}
