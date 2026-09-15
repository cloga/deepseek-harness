# Agent Note: 在 Desktop 原子激活前验证 Release 插件

Status: implemented

[English](2026-09-15-desktop-verified-release-plugin-transactions.md) | 中文

## Problem

公司网络可能阻止公共 npm registry，同时允许 GitHub Releases 与企业依赖 registry。通过 registry 安装根插件无法证明 Desktop 收到了经过审核的 Release 资产，而直接修改活动 profile 会把失败的包操作或 Host 启动留给人工修复。

## Decision

Desktop 接受版本化的 `githubRelease` 来源，其中锁定仓库所有者、仓库、tag、artifact asset id 与名称、包名、包版本、字节大小、SHA-256、可选 SHA-512 integrity、目标 commit、可选依赖 registry 与可选 checksum-manifest 资产。由 Release 拥有的自动 provisioning 要求 checksum manifest。它的 lock 包含精确 asset id、规范 GitHub Release URL、名称、字节大小、SHA-256、`sha256sums` 格式与可选 SHA-512 integrity。Desktop 要求存在且只存在一个匹配的 `<sha256>  <artifact>` 行，并拒绝缺失、重复、格式错误、重命名或不匹配的条目。Desktop 根据 repository 与锁定 asset id 构造 GitHub API 请求。它拒绝可变 Release 选择器、未批准的重定向主机、Release 或 tag commit 不匹配、资产元数据不匹配、归档路径逃逸、逃逸链接、异常归档根目录、包身份不匹配与包生命周期脚本。

根包是经过验证的本地 tgz。内置 pnpm 只通过显式、无凭据的 HTTPS registry 解析其传递依赖，忽略生命周期脚本，使用 Desktop 自有的 store 与配置路径，并且不接收继承的包管理器凭据或 secret 环境变量。普通 npm 来源保持其精确 registry 包行为。

每次插件变更都把活动 profile 复制到私有事务目录，在活动 Host 继续运行时准备完整包依赖图、恢复官方 Host 包链接并验证组合。随后 Desktop 停止活动 Host，针对 staged profile 启动临时 Host，把 staged 目录交换到保留 profile 路径，再启动新 Host。health check 失败会在不修改旧 profile 的情况下重启原 Host。激活失败时，它恢复先前 profile，并在报告失败前重启原 Host。事务锁位于可交换 profile 目录之外。

经过验证的安装在版本化 receipt 中持久保存锁定来源、GitHub Release 与资产标识、产物 hash、包身份与事务状态，并在 profile 私有目录中保留本地 tgz。类型化 preload API 暴露 source schema version 1 与 capability `{ id: "desktopNativeVerifiedRelease", schemaVersion: 1 }`，但不暴露自由格式下载 URL。一个事务只接受一种来源路径，因此外部 provisioner 与原生安装器不能同时提供根包。

Desktop release 也可以携带通用的 `desktopNativePluginProvisioning` schema 1 精确状态 plan。启动在 Host 启动前把 receipt-owned 插件协调到该 plan，同时保留手动安装的插件与所有由应用拥有的 shared package。它删除被省略的 receipt-owned 插件，安装或替换 required artifact，启用其 profile bundle，并通过同一个 staged transaction 验证完整 Host 与 Client 组合。Required 失败时保留先前 profile。Optional 条目导致组合失败时，Desktop 会禁用 optional 条目、验证剩余组合并记录失败。

活动 profile 存储规范 plan hash、逐插件 source 与 receipt、required 标记、组合状态、被删除的 receipt-owned 包、rollback 状态和 verification 状态。只有已安装版本、启用状态、receipt-backed source 与本地 artifact evidence 仍然匹配时，重启才复用该状态。由于启用的 profile bundle 会进入 Desktop Host loader 与 Client module registry，外部 provider 的服务端 patch 和 `dsh.client` bundle 会进入同一个应用组合；该机制不会特殊处理某个 provider。Neutral fixture 证明这一通用组合。采用某个 provider 的 release plan 负责该 provider 实际 Settings registration 与 authentication UI 的证据。

## Consumer transition

Windows Ops 在由源码拥有的 Desktop release plan 中选择插件 lock。受保护的 workflow 嵌入规范化 plan，将它与 installer 一起发布，并在 build receipt 中记录文件 hash 与规范 hash。部署只有在 release 包含该 plan 后才能依赖自动 provisioning。传递依赖继续使用 plan 中无凭据的企业 registry。

## Alternatives considered

**接受任意 tgz URL。** URL 不绑定 Release 状态、tag 身份、资产元数据或重定向所有权，并会把内部 lock 变成通用下载器。

**从企业 registry 安装根包。** 代理可能落后于经过审核的 GitHub Release，因此 registry 解析无法证明得到所需的不可变根产物。

**修改活动 profile 并保留部分失败。** 这种方案占用更少磁盘并避免复制 profile，但无法满足外部 verified 产物的无人值守激活与回滚要求。先前的原地修改决策作为冻结历史记录保留。

**把一个硬编码的 GitHub Copilot 包加入 Desktop。** 这只能解决一个 provider，而 restart、removal、rollback 与未来外部 provider 仍然没有由 Release 拥有的机制。

## Consequences

插件变更需要足够临时磁盘空间保存完整 profile，而且 pnpm 链接由其他事务路径创建时可能重复准备包。health check 会增加耗时，但可以阻止包、组合、Host 与 Client 失败进入活动 profile。精确状态删除只作用于 receipt-owned 插件；手动插件状态仍由用户拥有。测试锁定 Release 元数据、现有 `SHA256SUMS` manifest、可选 SRI、重定向、hash、归档安全、包身份、生命周期脚本拒绝、registry 与凭据隔离、官方 Host 链接、精确协调、staged Host 与 Client 组合、激活回滚、receipt、持久状态、capability discovery 与单一来源 provisioning。
