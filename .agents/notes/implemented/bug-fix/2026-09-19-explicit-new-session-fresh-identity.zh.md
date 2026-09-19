# Agent Note: 显式新会话创建新的身份

Status: implemented

[English](2026-09-19-explicit-new-session-fresh-identity.md) | 中文

## 问题

空白会话摘要描述的是对话内容，并不表示有权恢复该会话。复用被另一进程持有的空白会话，会让「新会话」反复选择同一个不可用身份。选中操作可能先于异步恢复失败发生，因此同步选中结果无法证明复用安全。若将 Creator preset 暂存给接下来成为当前会话的任意空白会话，也可能影响旧会话或无关会话。

## 决策

`ui-workspace.startSession` 通过 Session Controller 创建新 Session，不搜索已有空白会话。只有完整的 Workspace 与创建时的 preset 意图相同，并发新建才共享尚未完成的创建。普通 Workspace 复用保有独立的待完成操作。成功或失败后，每次尝试都会释放。请求仅在其精确的已提交 `mainView` reference 仍为当前引用时返回新 id；后续导航或 owner 释放会阻止该结果及晚到的 UI 提交。阻止选中不会取消 Host 创建。

Creator 通过 Client 创建链路，把 `agentPreset: 'cordis'` 传给 Host 既有的创建时 preset 字段。其提示仅有视觉作用：共享的 preset 暂存值或创建后的 select 均不会把 Creator 应用到旧的或无关的空白会话。Creator 动作仅在精确的新主 binding 与 Host 报告的 preset 仍匹配时报告成功。Settings 只会为同一分区生命周期内的该成功请求关闭。Creator 在等待创建前丢弃未绑定的 chip 暂存值；普通的已绑定 chip 选择及 Settings 中显式默认值同步仍指向各自捕获的 Session。

没有目标 Workspace 时，新会话保留 `clearMain` 行为，不创建任何会话。Creator 保持 Settings 打开，并在按钮旁显示本地化指引：先选择 Workspace，再次调用 Creator。该动作不排队保留延后的 Creator 意图，也不根据晚到且已被替代的结果推断 Workspace 缺失。

`openWorkspace` 和 `connectWorkspace` 为初始选择和 composer 中的 Workspace 切换保留空白会话复用。[Workspace README](../../../../packages/client/ui-workspace/README.zh.md) 定义消费方行为。本决策部分取代[会话作用域与供数](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.zh.md)中的新会话复用策略，不取代其作用域或供数决策。[Client 所有权分层](../architecture/2026-08-20-client-session-conversation-ownership.zh.md)仍将该导航策略归于 `ui-workspace`；`SessionReference`、`mainView` 和直接 subagent 所有权保持不变。

## 官方优先比较

官方 `0.1.6-alpha.2` 在 [Workspace 导航](../../../../packages/client/ui-workspace/src/client/navigation.ts)中让 `startSession` 经过 `openWorkspace` 与 `connectWorkspace`，因此缺少独立的显式新身份操作。其 [Host 创建处理器](../../../../packages/api/session-controller/src/commands.ts)已接受 `agentPreset`；保留的适配通过 Client 转发该既有字段，不新增 Host 创建协议。官方的引用所有权导航仍是选择与生命周期处理的基础。

在官方实现提供等价的新身份、保留引用所有权与创建时绑定的 Creator 选择之前，保留此适配。普通复用、Host 写入互斥和无关 Session 恢复，不是这项狭窄行为的替代标准。

## 考虑过的替代方案

**让新会话继续走复用路径。** 空白状态不能确定写入方是否可用，因此重复点击可能返回同一个被占用的身份，而不是提供新的对话。

**从所有 Workspace 选择中移除空白会话复用。** 初始选择和 composer 切换仍需要普通复用行为；改变这些操作会把修复范围扩大到显式创建之外。

**为下一个空白会话暂存 Creator，或延后到 Workspace 出现时应用。** 两种做法都会把 preset 意图与它授权的创建分离，并可能在无关导航之后应用。创建时绑定消除了这种歧义，同时不改变普通 chip 行为。

## 后果

新会话提供独立身份，不接管另一进程的所有权。顺序创建可能在一个 Workspace 留下多个空白 Session；侧边栏仍只显示当前选中的空白会话。合并仅限于一个 UI 服务，不协调浏览器标签页或进程。会话锁、恢复规则和 API 错误类型保持不变；普通 Workspace 复用仍可能选中不可用的 Session。此变更既不恢复被占用的 Session，也不接管其写入方。

## 验证

[导航测试](../../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts)负责新建与普通复用、完整意图合并、完成与重试、后续导航替代和 owner 释放。[Preset UI 测试](../../../../packages/client/ui-agent-preset/tests)负责创建时绑定的 Creator 选择与不变的 chip 行为。[组装后的 Web 回归](../../../../apps/web/tests/workspace-new-session-folding.e2e.ts)负责验证存在被占用空白会话时的新会话浏览器行为，以及不变的临时行配额。这些覆盖职责不表示某个源码版本已通过测试或发布资格验证。

[组装后的输入夹具](../../../../apps/web/tests/assembled-boot.ts)在交互前，会等待选中的会话 ID 改变，且替换后的输入框可编辑。创建尚未完成时，匹配到的输入框仍可能属于先前的会话。
