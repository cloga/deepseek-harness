# Agent Note: 会话感知的沙箱升级 schema

Status: implemented

[English](2026-08-30-session-aware-escalation-schemas.md) | 中文

## 问题

支持沙箱的工具注册一份进程级升级 schema，但有效沙箱模式与审批策略归每个会话所有。因此，`danger-full-access` 或禁用审批的请求仍会公布 `sandbox_permissions` 和 `justification`。部分工具调用客户端要求填写所有已公布属性，导致普通命令必须携带升级元数据，而执行阶段又会因其没有严格加宽而拒绝。

## 决策

`ToolDefinition.projectModelSchema(agent)` 允许已注册工具为单次请求投影面向模型的描述与参数。`defineTool.modelSchema` 通过同一套参数 schema DSL 编译该投影。执行校验仍绑定完整的静态注册，因此从模型 schema 省略字段不会削弱对注入调用的检查。

bash、pwsh、write 与 edit 工具在请求组装期间解析接收方 agent 的沙箱模式和审批策略。审批策略为 `ask` 时仅公开 `WIDER_MODES[effectiveMode]`；`danger-full-access`、策略 `never`、缺少审批服务或提供方不施加约束时，不公开升级字段或重试提示。没有 agent 的诊断仍保留完整注册 schema。

Recorded-session manifest 会为包含两个升级目标、仅包含 `danger-full-access` 或不含升级字段的 schema 分配不同 header class。每个 class 由一个 pin 持有可读 schema sidecar，使重放能够检查确切的模型输入，而无需在每个场景中重复保存。

本决策只取代[子进程沙箱决策](../feature/2026-07-06-sandbox.zh.md)和[跨工具族文件系统沙箱决策](../feature/2026-07-14-cross-family-fs-sandbox.zh.md)中的进程级升级公布条款。这些记录继续负责强制执行、审批顺序、拒绝语义与各能力的约束方式。

## 曾考虑的替代方案

**把相同或更窄的请求模式视为成功的空操作。** 不采用：这会把无效升级元数据伪装成有效输入，也不会移除禁用审批的客户端无法使用的字段。

**在所有默认 `danger-full-access` 的部署中于注册时隐藏字段。** 不采用：会话可以切换到 `read-only` 或 `workspace-write`，而进程默认值仍不受限。

**让每个工具在策略变化时修改其注册定义。** 不采用：并发会话需要同时获得不同 schema；请求组装已经持有确切的接收方 agent。

## 后果

模型 schema 与拒绝提示只公开当前会话可以请求的重试。Native 与 PTC 呈现使用同一个逐 agent 投影。静态诊断保持稳定，直接或注入调用仍接受完整执行校验与严格加宽检查。
