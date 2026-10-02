# 共享协议目录

本目录保存引擎、本地HTTP服务和前端共同使用的协议。以Schema、模板约束和自动化测试为准。

## 版本兼容

- `task-attachment.schema.json`支持`0.2-rc1`和`0.3-rc1`
- `flow.schema.json`、`mock-event.schema.json`和`run-record.schema.json`支持历史`0.2-rc1`、`0.3-rc1`与当前`0.4-rc1`
- 新写入优先使用当前引擎版本，历史版本仅用于读取兼容

## 文件索引

- `flow.schema.json`定义单Hook和线性Action的Flow结构
- `task-attachment.schema.json`定义任务附件和成员状态
- `mock-event.schema.json`定义本地Demo可接收的事件
- `run-record.schema.json`定义运行结果与步骤记录
- `template-contract.md`定义三类预制模板的固定结构
- `interface-contract.md`定义参数、状态、错误和读取语义

合法与非法样例位于`fixtures/contract-examples/`。契约回归由`tests/contracts.test.mjs`和相关执行测试覆盖。
