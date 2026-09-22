# Agent Note：允许显式兼容的 Desktop 用户覆盖

Status: implemented

[English](2026-09-21-desktop-compatible-user-plugin-overrides.md) | 中文

## 问题

用户拥有、通过校验和证明的同名插件可以在安装时通过完整的暂存 Host 健康检查，但后续冷启动会拒绝它，因为旧 provisioning 状态要求 receipt 来源与发行版来源完全相同。精确来源相等能保留发行版意图，却无法表达允许用户选择的已评审策略；版本顺序也不能证明运行时兼容性。

## 决策

Provisioning plan schema 2 为每个条目显式指定 `strict-pin` 或 `compatible-user-override` 来源策略。Schema 1 plan 保持严格语义及原有规范哈希。兼容覆盖必须已启用、显式归用户所有、具有校验和证明、制品一致，并使用计划中的包名。Registry 包、源码快照、旧版未知归属、禁用条目、损坏制品及矛盾 receipt 仍然属于冲突。

Provisioning state schema 2 分别记录 plan schema、请求来源和策略，以及有效来源与 `plan` 或 `user-override` 处置。Schema 1 state 使用其历史 capability 严格验证，仅在内存中规范化。成功事务写入 schema 2；读取不会改写保留证据。

一个 resolver 统一选择启动、复用、暂存、用户变更和最终激活检查使用的有效来源。它从不比较版本。保留的覆盖继续归用户所有，复制到暂存区时无需再次下载；只有完整暂存依赖图通过验证且目标运行时 Host 就绪，才存在兼容性。因此，运行时变化会重新检查覆盖。无关用户插件和仅删除发行版归属插件的规则保持不变。

目标运行时健康检查失败时，活动 profile 保持不变。恰好一个覆盖处于活动状态时，Desktop 会把其打包来源发布为带类型的恢复建议，但不会把失败归因于该覆盖；多个活动覆盖不会产生任意的限定目标建议。启动页面和不依赖 preload 的紧急页面只能恢复该保留失败所指向的打包请求来源。Main 会根据打包 plan 重新验证包；renderer 不提供来源或包名。恢复复用现有暂存、健康检查、激活 journal 和回滚事务，并保留无关用户插件。禁用全部插件与重置仍是独立的广泛后备操作。

本决策部分取代 [Desktop 用户清单保护](2026-09-19-desktop-user-inventory-guards.zh.md)中的同源规则。该决策对异常清单的拒绝、事务检查、审计、恢复副本和回滚规则仍然适用。Release plan 按条目选择加入；现有 schema 1 release 不会获得覆盖行为。

## 已考虑的替代方案

**把所有较新且已验证的版本视为兼容。** Semantic version 顺序不能验证 peer dependency、bundle 加载或 Host 就绪。

**启动检查失败后静默恢复发行版来源。** 这会在未经同意时丢弃明确的用户意图。限定目标的恢复操作是同意点。

**只存储有效来源。** Completion 与启动将无法区分发行版意图和实际运行的制品。

## 后果

只有暂存 Host 接受时，兼容的用户选择才能跨冷启动和运行时升级保留。严格条目仍会在 profile 激活前拒绝替代的已验证来源，普通变更也不能提交一个会被下次启动拒绝的 required 计划包状态。持久状态与 capability 版本发生变化，来源 receipt 和归属记录保持不变。
