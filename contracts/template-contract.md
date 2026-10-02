# 三个班委预制模板协议

当前模板可生成`0.3-rc1`和`0.4-rc1`对象，并保留对`0.2-rc1`数据的读取兼容。

本文件规定模板生成器可以产生的结构。模板只能机械补齐槽位，不能调用大模型，不能添加、重排或串联Flow。

## 通用约束

- 每个模板实例生成一条独立Flow
- 每条Flow只有一个Hook
- Action按声明顺序执行，任何失败都会终止后续执行
- 三条Flow通过相同`taskAttachmentId`引用同一份作业任务附件
- `taskAttachmentId`仅用于业务数据读写，不表达依赖或调度
- 模板实例化后必须通过`flow.schema.json`校验，并执行本文件中的模板级顺序校验
- 用户界面仅展示自然语言名称和确认卡，不展示本文件中的技术字段

## `homework_publish_v1`

用途为发布作业并初始化作业任务附件。

允许的Hook二选一

- `self_message`
- `scheduled`

固定Action顺序

1. `initialize_task_attachment`
2. `send_group_message_and_file`

必填槽位

- `name`
- `taskAttachmentId`
- `hook.params`
- `actions[1].params.groupId`
- `actions[1].params.text`
- `actions[1].params.filePath`

默认值

- `status`取`draft`
- 定时Hook的`timezone`取`Asia/Shanghai`

允许裁剪

- 无

校验规则

- `actions[1].params.groupId`必须等于附件的`groupId`
- Flow与初始化Action中的`taskAttachmentId`必须相同
- 定时Hook使用带时区的RFC 3339时间
- 初始化成功而发送失败时保留附件和失败运行记录，用户修改设置后可以重新触发

降级提示

> 一期可以按你发出的约定消息开始，或在指定时间开始。暂不支持其他复杂条件。

确认卡规则

> 当你发出「{keyword}」后，先初始化「{taskName}」提交记录，再向「{groupName}」发送作业通知和文件。

定时Hook时将首句替换为`到{runAt}时`。

## `homework_collect_v1`

用途为收到作业文件后匹配人员、改名、登记并回复。

唯一允许的Hook

- `group_file_received`

固定Action顺序

1. `match_person`
2. `rename_received_file`
3. `mark_submission`
4. `reply_to_sender`

必填槽位

- `name`
- `taskAttachmentId`
- `hook.params.groupId`
- `hook.params.allowedExtensions`
- `actions[3].params.text`
- `actions[1].params.nameTemplate`

选填槽位

- `hook.params.keyword`

默认值

- `status`取`draft`
- `actions[3].params.text`建议取`收到，已帮你登记`
- `actions[1].params.nameTemplate`建议取`{studentId}_{name}{originalExtension}`

允许裁剪

- 无

校验规则

- Hook的`groupId`必须等于附件的`groupId`
- Flow、人员匹配Action与登记Action中的`taskAttachmentId`必须相同
- 文件名模板只允许`{studentId}`、`{name}`和`{originalExtension}`三个占位符
- 扩展名白名单至少一项，匹配时忽略大小写
- 可选关键词先去除首尾空格，再对文件名做包含匹配
- 人员映射失败时`match_person`失败，后续三个步骤均记为`skipped`，不得发送成功回复
- 重复提交由`match_person`识别，后续三个步骤均记为`skipped`，运行状态取`succeeded_no_action`
- 重复事件和原始文件信息保留在运行记录的事件快照和步骤输入中

降级提示

> 一期只能按发送人的用户ID匹配花名册。请先补齐用户ID、姓名和学号。

确认卡规则

> 在「{groupName}」收到符合规则的作业文件后，匹配花名册，按「{nameTemplate}」改名并登记，完成后回复「{replyText}」。

## `homework_remind_v1`

用途为到期筛选未交人员并发送统一提醒。

唯一允许的Hook

- `scheduled`

固定Action顺序

1. `read_unsubmitted`
2. `build_recipient_list`
3. `send_direct_message_batch`

必填槽位

- `name`
- `taskAttachmentId`
- `hook.params.runAt`
- `hook.params.timezone`
- `actions[2].params.text`

默认值

- `status`取`draft`
- `hook.params.timezone`取`Asia/Shanghai`

允许裁剪

- 无

校验规则

- Flow与读取Action中的`taskAttachmentId`必须相同
- 催未交任务的`hook.params.runAt`应等于附件的`deadlineAt`。独立提醒使用用户设定的`remindAt`
- 接收人数组只能由`submissionStatus`为`unsubmitted`的成员用户ID生成
- 所有接收人使用同一段`text`
- 未交名单为空时，读取和生成空接收人列表成功，发送步骤记为`skipped`，运行状态取`succeeded_no_action`
- 催交消息发送成功后，将对应未提交成员的`reminderStatus`更新为`sent`并写入`remindedAt`

降级提示

> 一期会向所有未交同学发送同一段提醒，暂不支持逐人生成不同内容。

确认卡规则

> 到{runAt}时，读取「{taskName}」未交名单，并向这些同学发送「{reminderText}」。

## 模板级拒绝条件

以下情况即使JSON Schema合法，也必须拒绝保存或启用。

- Hook类型不在模板允许范围内
- Action数量、类型或顺序与模板声明不一致
- 三处`taskAttachmentId`引用不一致
- 群标识与附件目标群不一致
- 出现模板没有声明的槽位或占位符
- 试图引用另一条Flow的标识、运行状态或输出
