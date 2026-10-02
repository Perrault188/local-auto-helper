export const DOMAIN_LABELS = {
  education: { scope:'班级', entity:'同学', entityName:'姓名', entityId:'学号', contact:'用户ID', progressTitle:'名单与进度', completed:'已交', pending:'未交', completedCount:'已交', pendingCount:'未交', reminder:'提醒状态', remindAction:'到点提醒', collectAction:'收文件登记', deadline:'截止时间', remindPlaceholder:'到点发给未交同学的提醒', recoveryTarget:'花名册' },
  finance: { scope:'业务范围', entity:'提交人', entityName:'提交人', entityId:'关联编号', contact:'提交人用户ID', progressTitle:'单据与进度', completed:'待审核', pending:'待提交', completedCount:'待审核', pendingCount:'待提交', reminder:'催办状态', remindAction:'到点催办', collectAction:'收单据登记', deadline:'提交期限', remindPlaceholder:'到点发给待提交人员的催办内容', recoveryTarget:'提交人清单' },
  retail: { scope:'门店范围', entity:'门店负责人', entityName:'门店', entityId:'门店编号', contact:'负责人用户ID', progressTitle:'门店与进度', completed:'已上报', pending:'待上报', completedCount:'已上报', pendingCount:'待上报', reminder:'提醒状态', remindAction:'到点提醒', collectAction:'收日报登记', deadline:'上报期限', remindPlaceholder:'到点发给待上报门店负责人的提醒', recoveryTarget:'门店负责人清单' }
};
const GENERIC_LABELS = { scope:'作用范围', entity:'成员', entityName:'名称', entityId:'成员编号', contact:'联系方式', progressTitle:'名单与进度', completed:'已完成', pending:'待完成', completedCount:'已完成', pendingCount:'待完成', reminder:'提醒状态', remindAction:'到点提醒', collectAction:'收文件登记', deadline:'截止时间', remindPlaceholder:'到点发送的提醒内容', recoveryTarget:'成员清单' };
export const labelsFor=domain=>DOMAIN_LABELS[domain]||GENERIC_LABELS;
export function capabilityLabel(capability,domain){const l=labelsFor(domain);return capability==='publish'?'发通知':capability==='collect'?l.collectAction:capability==='remind'?l.remindAction:capability}
const EDUCATION_ACTIONS={initialize_task_attachment:'建立本次作业记录',send_group_message_and_file:'发送作业通知和文件',match_person:'确认提交人信息',rename_received_file:'按学号和姓名改名',mark_submission:'登记为已交',reply_to_sender:'回复已登记',read_unsubmitted:'找出未交同学',build_recipient_list:'整理提醒名单',send_direct_message_batch:'发送统一提醒'};
export function actionLabel(type,domain){
  if(domain==='education')return EDUCATION_ACTIONS[type]||type;
  if(domain==='finance')return({initialize_task_attachment:'建立本次单据记录',send_group_message_and_file:'发送收件通知和文件',match_person:'确认提交人信息',rename_received_file:'按规则整理单据文件名',mark_submission:'登记为待审核',reply_to_sender:'回复已收件',read_unsubmitted:'找出待提交人',build_recipient_list:'整理提交人催办名单',send_direct_message_batch:'向提交人发送统一催办'})[type]||type;
  if(domain==='retail')return({initialize_task_attachment:'建立本次门店日报记录',send_group_message_and_file:'发送日报通知和文件',match_person:'确认门店负责人信息',rename_received_file:'按门店规则整理文件名',mark_submission:'登记门店为已上报',reply_to_sender:'回复已登记',read_unsubmitted:'找出待上报门店负责人',build_recipient_list:'整理门店负责人提醒名单',send_direct_message_batch:'向门店负责人发送统一提醒'})[type]||type;
  const l=labelsFor(domain);
  return({initialize_task_attachment:'建立本次任务记录',send_group_message_and_file:'发送通知和文件',match_person:`确认${l.entity}信息`,rename_received_file:'按规则改名',mark_submission:`登记为${l.completed}`,reply_to_sender:'回复已登记',read_unsubmitted:`找出${l.pending}对象`,build_recipient_list:'整理提醒名单',send_direct_message_batch:'发送统一提醒'})[type]||type;
}
