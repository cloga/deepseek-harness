# Agent Note: 在 Desktop provisioning 中保留用户插件

Status: implemented

[English](2026-09-17-desktop-plugin-retention-and-lockfiles.md) | 中文

## Problem

验证安装 receipt 证明包来源，不证明该包由发行计划还是用户安装。把每个 receipt 都视为发行版归属，会让后续精确计划删除用户插件。若归属只根据新计划推断，重建未改变的来源也会抹去显式手动安装的意图。

Windows pnpm 可能用反斜杠记录本地 tarball specifier，而 Desktop 用正斜杠记录同一制品。下一次冻结重建会因字符串不同而失败，请求的操作尚无机会修复它们。

## Decision

私有 receipt store 独立于公开 source 与 receipt schema，记录完整的 `user` 或 `release` 归属映射。手动验证安装记录用户归属。Required 与 optional provisioning 在精确来源和制品引用匹配时保留既有用户归属，包括跨运行时或计划变更的重建；真正的计划替换记录发行版归属。当前计划仍决定每个目标包名所要求的来源。精确删除只覆盖计划中已不存在的发行版归属包名，清单复用允许无关用户插件存在。

旧归属推断要求先前计划 hash 一致、active 结果包含相同 receipt，且 manifest 制品引用匹配。缺失或不完整证据不能授权删除。无效元数据明确失败。迁移只写暂存副本，并参与既有激活 journal 和回滚。旧 receipt 无法揭示留下完全相同历史数据的手动重装；显式归属消除了后续安装的这一歧义。

锁文件修复只适用于 receipt 绑定的 Windows 分隔符差异。Manifest 引用、锁定包版本与 tarball 路径、制品 SHA-256 及锁定 SHA-512 必须一致。暂存修复只改变 specifier，不改变依赖解析或 integrity。非普通锁文件会被拒绝，避免复制的符号链接把写操作导向活动 profile。其他漂移仍由冻结安装检查。

本决策取代[验证 Release 事务决策](../architecture/2026-09-15-desktop-verified-release-plugin-transactions.zh.md)中基于 receipt 的删除规则；其制品获取、依赖图验证、健康检查与回滚要求仍然有效。

## Alternatives considered

**把验证视为发行版归属。** 这会混淆来源证明与用户意图，并删除手动安装的验证插件。

**只从最新计划推导归属。** 显式手动重装同一来源后，重建又会把它归为发行版。持久归属元数据保留该选择，同时不覆盖计划要求的不同来源。

**关闭冻结验证来恢复旧锁文件。** 通用依赖刷新可能接受无关漂移。Receipt 绑定的修复保留经过审查的制品和全部既有锁定解析。

## Consequences

Profile 元数据增加私有归属记录，公开 provisioning capability 和 schema 保持不变。空计划保留用户插件；optional 失败仍排除失败的目标条目，required 失败保留先前 profile。忽略归属的旧客户端不提供此保留保证。共享任务、Session 与凭据数据不属于该事务。

所属回归覆盖复用与强制重建、required 和 optional 来源、显式替换、旧证据、错误归属、回滚，以及真实 pnpm 对旧失配锁文件的操作。文件链接拒绝使用 POSIX 文件符号链接和无需额外权限的 Windows junction 验证；两种夹具都不要求改变用户安全设置。发布安装包验证仍由既有隔离 Desktop 发布工作流承担，不修改已安装应用。
