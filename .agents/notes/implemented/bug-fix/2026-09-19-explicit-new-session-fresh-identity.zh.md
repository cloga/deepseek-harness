# Agent Note: 显式新会话创建新的身份

Status: implemented

[English](2026-09-19-explicit-new-session-fresh-identity.md) | 中文

## 问题

空白会话摘要描述的是对话内容，并不表示有权恢复该会话。复用被另一进程持有的空白会话，会让「新会话」反复选择同一个不可用身份。选中操作可能先于异步恢复失败发生，因此同步选中结果无法证明复用安全。

## 决策

`ui-workspace.startSession` 通过会话控制器创建新会话，不搜索已有空白会话。同一工作区的并发新建只共享尚未完成的创建；成功或失败后都会释放该次尝试。每个请求保留既有的最新导航和所有者生命周期检查，因此晚到结果不能覆盖较新的导航，也不能在所有者释放后重新打开 UI。阻止选中不会取消 Host 创建。

`openWorkspace` 和 `connectWorkspace` 为初始选择和 composer 中的工作区切换保留空白会话复用。[Workspace README](../../../../packages/client/ui-workspace/README.zh.md) 定义消费方行为。本决策部分取代[会话作用域与供数](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.zh.md)中的新会话复用策略，不取代其作用域或供数决策。[Client 所有权分层](../architecture/2026-08-20-client-session-conversation-ownership.zh.md)仍将该导航策略归于 `ui-workspace`。

## 考虑过的替代方案

**让新会话继续走复用路径。** 空白状态不能确定写入方是否可用，因此重复点击可能返回同一个被占用的身份，而不是提供新的对话。

**从所有工作区选择中移除空白会话复用。** 初始选择和 composer 切换仍需要普通复用行为；改变这些操作会把修复范围扩大到显式创建之外。

## 后果

新会话提供独立身份，不接管另一进程的所有权。顺序创建可能在一个工作区留下多个空白会话；侧边栏仍只显示当前选中的空白会话。合并仅限于一个 UI 服务，不协调浏览器标签页或进程。会话锁、恢复规则和 API 错误类型保持不变；普通工作区复用仍可能选中不可用的会话。

## 验证

[导航测试](../../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts)区分新建与普通复用，并覆盖重叠的新建请求、完成与重试、后续导航替代和所有者释放。[组装后的 Web 回归](../../../../apps/web/tests/workspace-new-session-folding.e2e.ts)负责验证存在被占用空白会话时的新会话浏览器行为，以及不变的临时行配额。仅有客户端证据和这项导航变更，都不能证明被占用会话本身已经恢复。
