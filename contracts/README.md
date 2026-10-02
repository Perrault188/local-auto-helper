# 共享协议目录

本目录由执行协议会话起草，总控会话评审。

第一次接口评审至少需要以下文件。

```text
flow.schema.json
task-attachment.schema.json
mock-event.schema.json
run-record.schema.json
template-contract.md
interface-contract.md
```

第一次接口评审已完成。当前版本为`0.2-rc1`候选协议，仍需通过校验和实现方确认后锁定。

## 当前候选版索引

- `flow.schema.json`定义单Hook和线性Action的Flow结构
- `task-attachment.schema.json`定义三条班委帮办共享的受控业务附件
- `mock-event.schema.json`定义本地Demo的三类输入事件
- `run-record.schema.json`定义单次运行和Action步骤结果
- `template-contract.md`定义三个预制模板的固定结构
- `interface-contract.md`定义参数、状态、错误码和前端读取语义
- `协议评审清单.md`记录锁定条件和总控决策项
- `交接记录.md`记录本轮产物、验证边界和后续输入

合法和非法纯协议样例位于`fixtures/contract-examples/`。
