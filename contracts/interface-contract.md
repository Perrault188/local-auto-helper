# 前端与执行器共享接口候选版

版本`0.2-rc1`

本文件描述本地Demo的读取模型、执行语义和错误展示约定。它不承诺HTTP接口，也不预设具体状态管理库。

## Hook和Action最小参数

| 类型 | 必填参数 | 事件或上一步输入 | 主要输出 |
| --- | --- | --- | --- |
| `self_message` | `conversationId`、`keyword` | `self_message_sent` | 命中或不命中 |
| `scheduled` | `runAt`、`timezone` | `timer_fired` | 命中或不命中 |
| `group_file_received` | `groupId`、`allowedExtensions` | `group_file_received`，`keyword`可选 | 命中或不命中 |
| `initialize_task_attachment` | `taskAttachmentId` | 已导入的附件初始数据 | 初始化后的附件标识 |
| `send_group_message_and_file` | `groupId`、`text`、`filePath` | 无 | 消息标识和文件标识 |
| `match_person` | `taskAttachmentId` | 事件中的`senderUserId`和原始文件信息 | 人员映射和`isDuplicate` |
| `rename_received_file` | `nameTemplate` | 事件文件和人员映射 | 新文件路径 |
| `mark_submission` | `taskAttachmentId` | 人员映射、事件时间和新文件路径 | 更新后的成员记录 |
| `reply_to_sender` | `text` | 事件中的`senderUserId` | 回复消息标识 |
| `read_unsubmitted` | `taskAttachmentId` | 无 | 未交成员数组 |
| `build_recipient_list` | 无 | 未交成员数组 | 去重后的用户ID数组 |
| `send_direct_message_batch` | `text` | 用户ID数组 | 发送数量和消息标识数组 |

## 文件匹配

- 一期不接受glob和任意正则
- `allowedExtensions`由模板声明，至少包含一个带点扩展名
- 扩展名匹配忽略大小写，`.docx`可以匹配`.DOCX`
- `keyword`可选。匹配前去除首尾空格，非空时对文件名执行包含匹配
- Schema保证关键词包含非空白字符，执行器负责实际去除首尾空格

## 固定执行顺序

- 发布Flow先执行`initialize_task_attachment`，再执行`send_group_message_and_file`
- 初始化成功而发送失败时保留附件和失败记录，用户修改设置后可以重新触发
- 收取Flow依次执行`match_person`、`rename_received_file`、`mark_submission`和`reply_to_sender`
- 人员映射失败时第一步失败，后续三步均跳过，不发送成功回复
- 催交Flow依次执行`read_unsubmitted`、`build_recipient_list`和`send_direct_message_batch`
- Flow之间没有回滚、等待、调用和失败补偿

## 运行和步骤状态

- 运行状态包括`running`、`succeeded`、`succeeded_no_action`和`failed`
- `succeeded_no_action`只用于重复提交被幂等跳过和到期时没有未交人员
- 步骤状态包括`running`、`succeeded`、`failed`和`skipped`
- 前序失败后，后续步骤为`skipped`，开始和结束时间均为`null`
- 重复提交时`match_person`成功并输出`isDuplicate`为`true`，其余三个步骤均为`skipped`
- 没有未交人员时，读取和空接收人列表生成成功，发送步骤为`skipped`
- `succeeded_no_action`运行至少包含一个`skipped`步骤，且运行级`error`为`null`
- `failed`运行必须含失败步骤，运行级错误复制第一个失败步骤错误

## 用户ID映射和重复提交

- `members[].userId`是人员唯一键，应用层在导入时拒绝重复用户ID
- 收件后只使用`senderUserId`查找人员，不使用姓名、学号或群昵称兜底
- 找不到映射时`match_person`记录`PERSON_NOT_FOUND`，后续步骤跳过
- 重复键由`taskAttachmentId`和`senderUserId`组成
- 重复提交不覆盖第一次登记和已归档文件，不生成第二份受管理文件
- 重复事件和原始文件信息保存在`eventSnapshot`及`match_person`步骤输入中
- 重复提交属于成功幂等结果，不使用错误码

## 作业附件状态迁移

- 人员初始未提交时，`submissionStatus`取`unsubmitted`，`reminderStatus`取`pending`
- 提交成功后，`submissionStatus`取`submitted`，`reminderStatus`取`not_needed`，并写入`lastSubmittedAt`和`filePath`
- 催交发送成功后，仍未提交人员的`reminderStatus`取`sent`并写入`remindedAt`
- 附件是提交状态和催交状态的权威来源

## Flow停用和软删除

- `enabled`允许新事件触发
- `disabled`只阻止新事件触发，已经开始的运行继续执行到终态
- `deleted`为软删除状态，同样阻止新事件触发，默认列表不展示
- `deleted`必须有`deletedAt`，其他状态的`deletedAt`必须为`null`
- 删除Flow不删除其运行记录、共享附件或其他Flow

## 历史快照和时间

- 每次运行必须保存完整`flowSnapshot`和`eventSnapshot`
- 快照在运行创建时写入，后续修改、停用或删除Flow不会改变历史展示
- 所有持久化时间使用带`Z`或UTC偏移的RFC 3339字符串
- Demo默认时区是`Asia/Shanghai`
- 定时事件既可由Mock控制台手动产生，也可由P1-C单机调度器在`runAt`到期后自动产生`timer_fired`事件。测试通过可注入时钟或手动`tick`推进，不修改系统时间
- `flowId`、`eventId`分别和快照中的对应标识保持一致

## 权威数据来源

| 信息 | 权威来源 | 派生方式 |
| --- | --- | --- |
| 帮办启用、停用和删除状态 | Flow定义 | 直接读取`status` |
| 执行结果和失败原因 | 运行记录 | 直接读取运行和步骤状态 |
| 人员提交和催交状态 | 作业任务附件 | 直接读取成员数据 |
| 最近运行时间和累计次数 | 运行记录 | 按Flow筛选并聚合 |
| 入口异常徽标 | 运行记录 | 统计`failed`且`viewedAt`为`null`的运行 |
| 已交、未交和异常人数 | 作业任务附件 | 按成员状态派生 |

前端不得缓存第二份权威业务状态，也不得通过页面操作直接伪造执行结果。

## 前端读取模型

### 帮办列表

- 默认排除`deleted`
- 读取Flow的`flowId`、`name`、`status`、`templateId`和`updatedAt`
- 从运行记录派生`lastRunAt`、`lastRunStatus`和`runCount`
- 入口异常徽标统计未查看的失败运行，不统计成功和成功无动作

### 帮办详情

读取当前完整Flow，用模板协议生成自然语言链路。历史页使用运行记录中的`flowSnapshot`，不回查当前Flow覆盖历史。

### 运行历史和单次运行

- 历史列表按`startedAt`倒序读取
- 单次运行按快照中的Action顺序展示`steps`
- 查看失败详情后写入带时区RFC 3339格式的`viewedAt`
- 技术视图展示Mock快照、输入和输出，禁止放入真实敏感信息

### 作业任务附件

附件变化只能由执行器写入。前端从成员数据派生已交、未交和异常人数。

## 错误码和前端文案

| 错误码 | 含义 | 用户文案 | 建议操作 |
| --- | --- | --- | --- |
| `PERSON_NOT_FOUND` | 发送人用户ID不在花名册 | 没有找到这位同学的花名册信息 | 补齐用户ID、姓名和学号后重新提交 |
| `ATTACHMENT_NOT_FOUND` | 作业任务附件不存在 | 找不到这次作业的提交记录 | 检查帮办引用或重新初始化 |
| `FILE_NOT_FOUND` | 输入文件不存在 | 找不到要处理的文件 | 重新选择或提交文件 |
| `HOOK_INPUT_INVALID` | 事件缺少Hook匹配字段 | 收到的触发信息不完整 | 检查Demo事件数据 |
| `ACTION_INPUT_INVALID` | Action参数或上一步输出无效 | 这一步缺少必要信息 | 返回帮办设置补齐内容 |
| `ADAPTER_ERROR` | 本地Mock适配器执行失败 | 本次操作没有完成 | 检查用户ID、本地助手和Demo适配器状态后重试 |

前端只根据稳定错误码选择文案。`message`用于技术排查，`recoveryHint`可以覆盖默认建议操作。

## 本地读取操作

- 列出Flow，默认排除软删除项，可按`status`筛选
- 按`flowId`读取Flow
- 保存合法Flow，启用前执行模板级校验
- 更新Flow状态，停用和软删除不终止运行中任务
- 列出某Flow的运行记录
- 按`runId`读取包含双快照的单次运行
- 标记运行已查看
- 按`taskAttachmentId`读取作业任务附件

传输层形式、分页和修改冲突留给实现评审，不扩展一期能力。
