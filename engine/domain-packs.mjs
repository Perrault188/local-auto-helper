import {
  createEntityDirectory,
  createRecordStore,
  createResource,
  packEducationAssignment,
  projectSubmissionRecords
} from './objects.mjs';

const PACKS = {
  education: {
    packId: 'EducationAssignmentPack',
    projectionKey: 'education_submission_v1',
    labels: { entity: '成员', completed: '已提交', pending: '未提交' }
  },
  finance: {
    packId: 'FinanceReceiptPack',
    projectionKey: 'finance_receipt_v1',
    labels: { entity: '提交人', completed: '待审核', pending: '待收件' }
  },
  retail: {
    packId: 'RetailDailyReportPack',
    projectionKey: 'retail_daily_report_v1',
    labels: { entity: '门店', completed: '已提交', pending: '缺失' }
  }
};

export function getDomainPack(domain = 'education') {
  const pack = PACKS[domain];
  if (!pack) throw new Error(`未注册领域包：${domain}`);
  return pack;
}

// 领域输入只在边界处映射成现有确定性运行契约。执行器不解释领域。
export function toRuntimeTaskInput(input) {
  const domain = input?.domain ?? 'education';
  getDomainPack(domain);
  if (domain === 'education') return { ...input, domain };

  if (domain === 'finance') {
    return {
      ...input,
      domain,
      capabilities: ['collect'],
      roster: (input.submitters ?? []).map(item => ({
        userId: String(item.userId ?? ''),
        name: item.name,
        studentId: String(item.entityId ?? item.projectCode ?? '')
      })),
      collectRule: input.collectRule ?? { allowedExtensions: ['.pdf', '.jpg', '.png'], keyword: '单据' },
      nameTemplate: input.nameTemplate ?? '{studentId}_{name}{originalExtension}',
      replyText: input.replyText ?? '已登记到待审核清单。本帮办不会自动审核、付款或入账。'
    };
  }

  const capabilities = input.capabilities ?? ['collect', 'remind'];
  return {
    ...input,
    domain,
    capabilities: [...capabilities],
    roster: (input.stores ?? []).map(item => ({
      userId: String(item.ownerUserId ?? ''),
      name: item.storeName,
      studentId: String(item.storeId ?? '')
    })),
    collectRule: input.collectRule ?? { allowedExtensions: ['.docx', '.xlsx', '.pdf'], keyword: '日报' },
    nameTemplate: input.nameTemplate ?? '{studentId}_{name}{originalExtension}',
    replyText: input.replyText ?? '日报已登记。',
    ...(capabilities.includes('remind')
      ? { remindText: input.remindText ?? '今日日报尚未登记，请尽快提交。' }
      : {})
  };
}

function financeRecords(members = []) {
  return members.map(member => ({
    submitterUserId: member.userId,
    entityId: member.studentId,
    submitterName: member.name,
    reviewStatus: member.submissionStatus === 'submitted' ? 'pending_review' : 'awaiting_receipt',
    receivedAt: member.lastSubmittedAt,
    filePath: member.filePath
  }));
}

function retailRecords(members = []) {
  return members.map(member => ({
    ownerUserId: member.userId,
    storeId: member.studentId,
    storeName: member.name,
    reportStatus: member.submissionStatus === 'submitted' ? 'received' : 'missing',
    receivedAt: member.lastSubmittedAt,
    filePath: member.filePath,
    reminderStatus: member.reminderStatus,
    remindedAt: member.remindedAt
  }));
}

const PROJECTORS = {
  education_submission_v1: projectSubmissionRecords,
  finance_receipt_v1: financeRecords,
  retail_daily_report_v1: retailRecords
};

// Executor只调用本中性投影入口，不含领域分支。
export function projectRecordStoreRecords(store, members = []) {
  const projectionKey = store?.schema?.projectionKey ?? 'education_submission_v1';
  const projector = PROJECTORS[projectionKey];
  if (!projector) throw new Error(`未注册记录投影：${projectionKey}`);
  return projector(members);
}

export function packAutomationDomain(attachment, { automationId = null, domain = 'education' } = {}) {
  if (domain === 'education') return packEducationAssignment(attachment, { automationId });
  const pack = getDomainPack(domain);
  const isFinance = domain === 'finance';
  const records = projectRecordStoreRecords({ schema: { projectionKey: pack.projectionKey } }, attachment.members ?? []);
  const resource = createResource({
    automationId,
    kind: pack.packId,
    name: attachment.taskName,
    payload: {
      packId: pack.packId,
      mappingVersion: 1,
      taskAttachmentId: attachment.taskAttachmentId,
      groupId: attachment.groupId,
      deadlineAt: attachment.deadlineAt,
      ...(isFinance ? {
        riskPolicy: {
          humanApprovalRequired: true,
          autoReview: false,
          autoPayment: false,
          autoBookkeeping: false
        }
      } : {})
    },
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt
  });
  const entityDirectory = createEntityDirectory({
    automationId,
    name: `${attachment.taskName} ${pack.labels.entity}目录`,
    matchKey: isFinance ? 'entityId' : 'storeId',
    entities: (attachment.members ?? []).map(member => isFinance
      ? { entityId: member.studentId, submitterName: member.name, userId: member.userId }
      : { storeId: member.studentId, storeName: member.name, ownerUserId: member.userId }),
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt
  });
  const recordStore = createRecordStore({
    automationId,
    name: `${attachment.taskName} ${isFinance ? '待审核清单' : '日报记录'}`,
    schema: {
      projectionKey: pack.projectionKey,
      entityKey: isFinance ? 'entityId' : 'storeId',
      statusField: isFinance ? 'reviewStatus' : 'reportStatus'
    },
    records,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt
  });
  entityDirectory.sourceAttachmentId = attachment.taskAttachmentId;
  recordStore.sourceAttachmentId = attachment.taskAttachmentId;
  return { resource, entityDirectory, recordStore };
}

export function domainLabels(domain = 'education') {
  return PACKS[domain]?.labels ?? { entity: '对象', completed: '已完成', pending: '待处理' };
}
