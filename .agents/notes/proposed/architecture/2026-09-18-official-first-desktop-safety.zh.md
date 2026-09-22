# Agent Note: 官方优先的 Desktop 安全迁移

Status: proposed

[English](2026-09-18-official-first-desktop-safety.md) | 中文

## 问题

官方 `0.1.6-alpha.2` Desktop 共享 Web 应用、插件管理器和更新展示。继续保留 fork 的独立插件窗口、分帧字节管道 Host 和协议 2 更新提示栏，会重复官方已有的职责。同时删除 fork 的获取、快照、隔离和回滚规则，又会丢失仅凭共享界面无法证明存在的安全属性。

## 提案

Core#67 集成官方基于 Web 的 Host 和共享 `runProfile` 拓扑。官方 PluginManager 保持唯一的管理 UI。拟议的类型化 app-boot 事务后端保留受限获取与暂存，而不允许处理请求的 Host 停止自身。此集成仍在进行中：源码声明或保留的辅助函数测试，不证明事务路径可用、经过验证或已经发布。

后端应暂存私有候选并报告 PREPARED（`state: 'prepared'`），包含事务标识、基础指纹和健康状态。PREPARED 既不是活动 receipt，也不授权停止 Host。独立的壳操作必须在健康检查所需的中断、提升和最终位置激活之前，取得当前中断授权。在同一个规范外部租约下重新检查基础指纹，拒绝陈旧候选，并保留旧 profile 和恢复 journal，直到最终位置 Host 就绪且清单验证完成。恢复失败时保留 journal 与回滚数据；两次重命名可恢复，但不具备崩溃原子性。

### 官方优先决策

| 定制项 | `0.1.6-alpha.2` 的官方证据 | 决策与回归官方的条件 |
|---|---|---|
| 独立更新提示栏与协议 2 | Settings 的 `DesktopUpdateIndicator`、收起状态的 `DesktopUpdateBadge` 及协议 1 的 `status`/`open`/`subscribe` 已负责展示 | 退役重复提示栏及其适配器；使用官方所有者，而非第二套轮询 UI。 |
| 未保存输入的更新保护 | 官方任务检查本身不证明覆盖所有已挂载草稿、附件或待完成发送 | 仅保留可选的标量 `reportImpact`（`hasDraft`、`attachmentCount`、`submitting`）；官方等效覆盖经过验证后删除。它只能阻止安装，不能授权安装或携带内容。 |
| Fork 插件窗口和插件 IPC | 共享 Web PluginManager 和认证 HTTP 路由负责管理 | 退役独立 UI；通过类型化 app-boot 集成迁移有依据的后端安全能力。端到端验收前不得宣称这些操作就绪。 |
| 私有 Desktop slash-command 桥接 | 框架完整支持，但没有该桥接：精确目标版本提供 commands registry 及 `command/run`／`command/done` 事件，其 Desktop Host 入口没有注册 Desktop 插件命令 | 复用官方 registry 和 Session 生命周期；在官方 Desktop 提供等效持久化落盘、确认应答、原生同意及活动 Host 取消归属前，保留狭窄的精确子进程适配器。 |
| Launcher 暂存与待处理记录 | 官方不提供：精确目标版本既无 app-boot `types.ts`，也无 `profile-package-transactions.ts`，其 PluginManager `ChangeResult` 没有 `prepared` 状态或字段 | 既有五字段暂存结果和七字段选择待处理结果都是 alpha2 上的 fork 集成，不是官方功能。普通暂存保持不变，仅扩展待处理查询；在官方提供等效支持及明确数据迁移后回归。 |
| 原子选择及受控 registry 更新 | 部分支持：官方 PluginManager 和 profile helper 提供普通文件锁保护的原地组合包选择，但没有仅候选的原子选择、日志绑定的命令授权或保留来源／receipt 的原生激活 | 保留官方共享 UI 和组合包表达；在官方行为验证等效的 lease 内目标资格、产物／归属保留、确认、准入、健康及恢复前，保留 fork 事务所有者。 |
| 来源快照和经过验证的 Release | 共享包安装不证明具备等效的不可变获取、快照重建、归属保留或回滚 | 保留现有机制并迁移消费方；仅在官方等效行为及失败覆盖经过验证后退役。 |
| InputHub 壳与独立发送安全 | 官方对话与输入变更要求迁移消费方；名称相似不构成等效证据 | 保留 InputHub 并迁移壳与独立发送处理；删除任何适配器前，必须验证草稿、附件、发送中状态、资源释放和导航回归。 |
| 祖先 SDK/包约束 | 运行时解析代际本身不约束祖先包查找 | 保留 profile/共享包与继承 Worker 约束；退役前要求等效原生解析及拒绝逃逸用例。 |
| Windows 文件系统 birthtime | 通用文件身份检查不证明能检测 Windows 上的删除再创建 | 保留 birthtime 差异，直到 Windows 替换回归证明官方等效。 |
| 多行 Goal 编辑 | 官方 Goal 控件不证明具备多行目标编辑的等效行为 | 保留多行行为，直到换行保留与现有 Goal 操作通过等效 UI 覆盖。 |
| 手动 compaction 模型选择 | 部分支持：精确官方 `0.1.6-alpha.2` 与合并前候选使用持久化的先前请求路由，而非维护操作获准时的当前选择器快照；证据所属文件为 `packages/compaction/compaction-basic/src/index.ts` 和 `packages/core/agent/src/model-selection.ts` | 保留 PR #92 的修复：维护操作获准时一次性捕获 owner-scoped 选择，用于策略和默认摘要目标；显式摘要覆盖仍优先，自动压力／溢出路径仍使用持久化路由。仅在官方等效选择、作用域、取消、错误、UI 和 replay 覆盖经过验证后退役。 |
| 滚动采样待处理时自身消息的可见性 | 部分支持：官方 [ChatView](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) 在读者采样期间推迟整个布局 effect。有序的源码回调反例表明，当本地提交在采样完成前被持久化用户与 Assistant 节点替代时，其唯一的强制跟随观察会丢失；这不证明历史浏览器失败的原因。 | 仅在已打开且没有带锚点前插的视图中保留狭窄的自身追加例外。普通流式／布局、首次位置恢复、定时器归属及后续读者操作保持不变。官方实现通过等效的有序自身发送、恢复、前插、读者输入与真实浏览器覆盖后退役。 |

### 保留的理由与部分取代

[来源快照决策](../../implemented/feature/2026-09-17-desktop-plugin-source-snapshots.zh.md)保留受限输入语法、预构建输出验证、钩子拒绝、隔离打包、内容寻址归档、显式同版本替换及损坏快照删除规则。快照标识字节，不证明发布者身份；经过验证的来源绝不能静默降级为 registry 或通用来源。这些约束在共享 UI 后仍然必要。

[验证 Release 事务决策](../../implemented/architecture/2026-09-15-desktop-verified-release-plugin-transactions.zh.md)保留不可变发布/资产/校验和绑定、有界白名单获取、应用包 peer 身份、祖先查找约束、暂存重建、回滚和最终位置完成要求。[保留决策](../../implemented/bug-fix/2026-09-17-desktop-plugin-retention-and-lockfiles.zh.md)保留用户与发行版归属、保守的旧数据推断、精确计划删除、可选失败隔离，以及不削弱冻结安装的产物支持 Windows 分隔符规范化。这些属于部分取代：后端理由仍保留，但旧的仅壳暴露方式不再是新 UI 的当前依据。

[持续提示决策](../../implemented/feature/2026-09-17-persistent-desktop-update-notice.zh.md)被部分取代。重复展示和轮询实现退役；不中断的发现、壳拥有更新权限和未保存输入保护仍指导迁移。保留活动记录并双向链接，而非归档混合当前与退役内容的决策，或把它改写为相反结论。已经封存的归档三件套及原始哈希保持不变；传入官方归档的封存记录也保持完整。

[Fork 发布通道决策](../../implemented/architecture/2026-09-15-fork-owned-windows-desktop-release-channel.zh.md)继续负责未签名托管发现、经过验证的 helper 交接及安装完成证据。已签名原生模式和未签名托管模式保持互斥。无依赖的复制 helper 确认、隔离 Models fixture（测试前置数据）、已准备 profile 和认证后的提供方可用性是不同观察，彼此不能替代。

## 考虑过的替代方案

**保留两个插件管理器和两个更新指示器。** 这保留了旧接线，却产生竞争的所有权、重复用户操作，也不满足官方优先要求。

**完全采用官方实现并删除所有 fork 安全规则。** 这减少代码，却没有证明等效的获取完整性、重建、隔离、未保存输入保护或可恢复激活。

**从暂存请求直接激活。** 这可能停止处理该请求的 Host，把已准备字节与用户同意混为一谈，并丢失响应。准备与壳拥有且显式授权的激活必须分离。

**立即归档所有旧 fork 记录。** 其安全、持久数据和回滚理由仍然有用，迁移尚未验收。部分取代要求活动交叉链接，不能把封存历史当作当前依据。

## 验收标准

- 官方 PluginManager 是唯一管理 UI；协议 1 负责更新展示，不存在 fork 提示栏或协议 2 要求。
- 普通 Web“稍后”保留 PREPARED 供状态查询／丢弃，不触发在线激活、成功活动 receipt 或 Host 中断。准入前的命令取消在工作停止后只丢弃自己的准备；孤立命令准备不能获得普通 Web 激活权。并发请求、陈旧指纹、进程退出及重启恢复在同一 lease 下失败关闭；已经获准激活的事务保留独立恢复规则。
- 恶意归档、钩子、来源漂移、损坏的保留产物、peer 身份冲突、祖先 SDK 查找和 Worker 继承保留拒绝测试。Windows birthtime 与产物锁分隔符用例在 Windows 上执行。
- 显式授权的壳激活验证暂存健康、最终位置就绪、实际清单与 receipt，以及失败回滚。可选失败或仅完成准备都不记录成功 receipt。
- 官方更新 UI 与 InputHub 迁移取得已挂载输入框、独立发送、陈旧报告、资源释放和多行 Goal 的浏览器证据。安装绝不把标量影响报告当作同意。
- 手动 compaction 使用获准时的选择，不消耗待处理的聊天选择。`MAX_TOKENS` / `summary-truncated` 失败关闭，不提高输出上限、不重试，也不提交不完整 checkpoint。作用域、取消、错误、UI 和 replay 检查不证明超大历史救援、真实提供方验收或 alpha2 候选已通过验收。
- 文档配对、归档封存、针对性单元测试、集成构建/类型检查和隔离打包发布验收在精确选定源码上通过。验收期间不触碰现有安装、活动 Session 或不可变发布。

## 风险

类型化事务后端需要协调 app-boot、PluginManager、启动器和壳变更。任何消费方继续使用原地修改或旧 IPC，都可能绕过暂存或导致 profile 租约死锁。仅保留辅助函数不能证明集成路径通过验收；完整测试和打包验收仍未完成。迁移不授权安装、激活、重启或发布。现有只读源码证据和此前发布测试不能提升为对当前 WIP 的验收。
