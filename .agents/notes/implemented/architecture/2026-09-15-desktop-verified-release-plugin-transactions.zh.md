# Agent Note: 在 Desktop 原子激活前验证 Release 插件

Status: implemented

[English](2026-09-15-desktop-verified-release-plugin-transactions.md) | 中文

## Problem

公司网络可能阻止公共 npm registry，同时允许 GitHub Releases 与企业依赖 registry。通过 registry 安装根插件无法证明 Desktop 收到了经过审核的 Release 资产，而直接修改活动 profile 会把失败的包操作或 Host 启动留给人工修复。

## Decision

[插件保留决策](../bug-fix/2026-09-17-desktop-plugin-retention-and-lockfiles.zh.md)取代本记录中基于 receipt 的归属与删除规则。本记录继续负责来源获取、依赖图验证与事务激活。

Desktop 接受版本化的 `githubRelease` 来源，其中锁定仓库所有者、仓库、tag、artifact asset id 与名称、包名、包版本、字节大小、SHA-256、可选 SHA-512 integrity、目标 commit、可选依赖 registry 与可选 checksum-manifest 资产。由 Release 拥有的自动 provisioning 要求 checksum manifest。它的 lock 包含精确 asset id、规范 GitHub Release URL、名称、字节大小、SHA-256、`sha256sums` 格式与可选 SHA-512 integrity。Desktop 要求存在且只存在一个匹配的 `<sha256>  <artifact>` 行，并拒绝缺失、重复、格式错误、重命名或不匹配的条目。Desktop 根据 repository 与锁定 asset id 构造 GitHub API 请求。它拒绝可变 Release 选择器、未批准的重定向主机、Release 或 tag commit 不匹配、资产元数据不匹配、归档路径逃逸、逃逸链接、异常归档根目录、包身份不匹配与包生命周期脚本。

根包是经过验证的本地 tgz。内置 pnpm 只通过显式、无凭据的 HTTPS registry 解析其传递依赖，忽略生命周期脚本，使用 Desktop 自有的 store 与配置路径，并且不接收继承的包管理器凭据或 secret 环境变量。普通 npm 来源保持其精确 registry 包行为。经过验证的制品仍必须满足目标共享包依赖图：应用拥有的包必须声明为 peer，而非普通或 optional dependency，即使相同名称也出现在 peer 中。制品完整性不能授权第二个 Host 包身份。在 profile 组合前，Desktop Host 为 profile `node_modules` 下的物理模块及锁定 runtime generation 使用的精确 fallback-parent URL 注册同步 package-resolution policy。其 bare package 请求经过 realpath 规范化后只能解析到 profile 内，或打包 runtime 下的同名 package 内，无需旧 profile link。该策略固定公共 Harness-home resolver 的 profiles scope，以及配置路径和规范路径对应的活动 profile scope；托管 profile 使用 home 的 `package.json` 作为 fallback anchor，外部 staging profile 则使用父目录的 `package.json`。使用这些精确 anchor URL 的真实调用者也有意接受同样严格的策略，因为 hook 无法将其与 generation 的合成查找区分。祖先 optional peer 呈现 module-not-found 语义；必需的外部依赖仍无效。内置模块、显式 file 请求及其他 scope 外调用者保持 Node.js 行为。继承 preload 的默认与嵌套 Worker 使用 Worker environment data 中经过验证的版本化根路径记录，而非任务参数或 Worker 自身的 home 变量；显式丢弃 preload 的 Worker 不属于该覆盖范围。

每次插件变更只把 profile 元数据和保留 artifact 复制到私有事务中，排除所有 `node_modules` 目录。内置 pnpm 在其中重建私有依赖；应用升级绝不在活动 profile 中安装或 rebuild。目标运行时链接和目标插件清单一起准备，然后验证 peer。每个来源 acquisition 使用独立的独占目录，GitHub 必须明确证明 `immutable: true`。

Desktop 保留旧 profile，直到 staged 健康检查、激活重命名、最终位置 Host ready 与活动清单验证全部完成。外部事务锁和经过 fsync 的 activation journal 标识中断的重命名。恢复在该锁下还原未提交的旧 profile。恢复失败保留 journal 与 rollback 目录，而不删除唯一剩余的旧数据。两次重命名是可恢复操作，并非 crash-atomic 目录交换。

经过验证的安装在版本化 receipt 中持久保存锁定来源、GitHub Release 与资产标识、产物 hash、包身份与事务状态，并在 profile 私有目录中保留本地 tgz。类型化 preload API 暴露 source schema version 1 与 capability `{ id: "desktopNativeVerifiedRelease", schemaVersion: 1 }`，但不暴露自由格式下载 URL。一个事务只接受一种来源路径，因此外部 provisioner 与原生安装器不能同时提供根包。

Desktop release 也可以携带通用的 `desktopNativePluginProvisioning` schema 1 精确状态 plan。启动协调 release-owned 插件，同时保留无关的手动 registry、来源快照与 verified-release 插件和应用拥有的 shared package。Required 条目建立经过验证的基线。Optional 条目在独立 candidate 中测试。只有[用户清单检查](../bug-fix/2026-09-19-desktop-user-inventory-guards.zh.md)允许该条目缺失时，download、validation、install、graph 或 health 失败才排除该条目；已有手动安装不能因 optional 失败而被丢弃。其持久结果记录阶段与原因，不包含成功 receipt；required 失败保留先前 profile。

活动 profile 存储规范 plan hash、逐插件 source 与 receipt、required 标记、组合状态、被删除的 release-owned 包、rollback 状态和 verification 状态。复用要求 desired/result 成员完全一致，已安装版本、启用状态、receipt 与来源、本地 artifact 字节均匹配，且没有多余 release-owned 根包，空 plan 也不例外。托管 completion 在最终位置的 Host ready 后独立验证此清单。Neutral browser 证据证明通用 Models 组合与认证 dispatch，而不是某个外部 provider release。

受信管理页为既有 verified-release 安装 API 提供独立 JSON 入口。它不会把普通归档 URL 变成经过证明的 Release，不会弱化原生来源解析器，也不会授予应用渲染进程安装权限。显式安装仍归用户所有；同名手动来源冲突会按用户清单决策停止自动启动协调，而不是授权接管。

原生插件管理变更在串行事务首次调用 `beforeChange` 时获取中断同意，此时 staging 已完成而 Host 尚未停止。确认绑定当前 Host 活动数量与最新的渲染进程输入影响；影响变化时必须再次确认。缺少影响数据时拒绝中断。在获得同意前保持应用文档存活，可在准备失败或用户取消时保留草稿。回滚的 stop hook 不再询问：profile 激活后允许取消会阻止必要的恢复。启动协调保留其启动流程，不打开手动插件对话框。

桌面壳在停止 Host 或更改应用页面前，确保手动恢复、插件变更和应用更新安装互斥。它保留插件事务 Promise，直到清理结束。退出会取消尚未中断 Host 的确认和读取，等待已获准事务完成激活或回滚并释放 staged Host，然后关闭后端。中断后的启动页导航位于 staged 健康检查的恢复路径内，因此导航失败也会重新启动先前的 Host。

## Consumer transition

Windows Ops 在由源码拥有的 Desktop release plan 中选择插件 lock。受保护的 workflow 嵌入规范化 plan，将它与 installer 一起发布，并在 build receipt 中记录文件 hash 与规范 hash。部署只有在 release 包含该 plan 后才能依赖自动 provisioning。0.1.5 恢复 plan 通过 `https://packagefeedproxy.microsoft.io/npm/` 解析传递依赖；后续 plan 各自显式选择无凭据的 HTTPS registry。

## Alternatives considered

**接受任意 tgz URL。** URL 不绑定 Release 状态、tag 身份、资产元数据或重定向所有权，并会把内部 lock 变成通用下载器。

**从企业 registry 安装根包。** 代理可能落后于经过审核的 GitHub Release，因此 registry 解析无法证明得到所需的不可变根产物。

**修改活动 profile 并保留部分失败。** 这种方案占用更少磁盘并避免复制 profile，但无法满足外部 verified 产物的无人值守激活与回滚要求。先前的原地修改决策作为冻结历史记录保留。

**把一个硬编码的 GitHub Copilot 包加入 Desktop。** 这只能解决一个 provider，而 restart、removal、rollback 与未来外部 provider 仍然没有由 Release 拥有的机制。

## Consequences

发布工作流单独运行项目事务夹具，采用 Windows 覆盖率通道的 90 秒测试及 hook 预算；其他 Desktop 测试保留默认值。派生发布配置向每个内联 Vitest project 添加排除项，实际执行的收集检查要求两组发现结果互不重叠，并且合集等于原始清单。这些事务等待多个真实 Node 子进程，并非性能基准。夹具持有操作及完整测试函数的 Promise，并保留有界阶段耗时。清理先阻止新夹具工作，仅终止仍由夹具持有的 fake-pnpm 子进程，等待其 close 事件和后续操作结束后，才恢复 mock 或删除目录。25 秒清理期限到达时保持关闭，保留尚未静止的状态并阻止后续用例使用它；生产进程期限、重试与事务断言均不变。

插件变更需要临时磁盘空间并重建包，即使只是兼容运行时升级或 bundle toggle。Required 与 optional 健康检查增加启动工作，但阻止失败 candidate 修改活动依赖图。精确状态删除只作用于 release-owned 插件；无关手动插件仍由用户拥有。测试覆盖多来源 checksum acquisition、来源与清单漂移、Host peer 替换/删除、按阶段隔离 optional 失败、最终激活失败、rollback 恢复失败、中断重命名以及拒绝提前 completion。每个选定 provider release 都需要其实际不可变制品、目标共享包依赖图及 Models、account、discovery、device-code 行为的独立证据；neutral fixture 不能证明其符合要求。

经过评审的 release plan 选择不可变的 `dsh-github-copilot@0.4.0-alpha.30`，同时保留 Core `0.1.6-alpha.1`。其搜索 UI 声明路由 Remote namespace 依赖，打包的 authorization 与 Schemastery 依赖均为必需的 Host peer。React 是 Client external，而非必需的 Node peer 或第二份私有运行时副本。打包设置验收要求只读显示当前工作区、无需模型前置条件的仅提供方 primary 与 fallback 控件，以及不包含已移除 compatibility disclosure 的登出 Manage。它不发起 OAuth、验证导航、模型调用或搜索。Cron 不进入 release plan，继续归用户所有。已发布制品和 peer 范围检查不证明新 Desktop 的物化或已安装 UI 行为。Models、account、discovery、device-code 与更新持久性仍属于 rehearsal 和 release 的验收义务；[托管 Copilot 维护决策](2026-09-20-managed-desktop-copilot-maintenance.zh.md)拥有官方优先迁移条件和发布证据。
