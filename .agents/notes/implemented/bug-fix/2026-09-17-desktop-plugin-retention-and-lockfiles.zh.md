# Agent Note: 在 Desktop provisioning 中保留用户插件

Status: implemented

[English](2026-09-17-desktop-plugin-retention-and-lockfiles.md) | 中文

## Problem

验证安装 receipt 证明包来源已经验证，不证明该包由发行计划还是用户安装。把每个 receipt 都视为发行版归属，会让后续精确计划删除用户插件。若归属只根据新计划推断，重建未改变的来源也会抹去显式手动安装的意图。

Windows pnpm 可能用反斜杠记录本地 tarball specifier，而 Desktop 用正斜杠记录同一产物。在普通变更、optional provisioning 或运行时重建中，冻结重建可能因这些字符串不同而失败，使请求的操作无法继续。

## Decision

私有 receipt 存储独立于公开 source 与 receipt schema，记录完整的 `user` 或 `release` 归属映射。手动验证安装记录用户归属。Required 与 optional provisioning 在精确来源和产物引用匹配时保留既有用户归属，包括跨运行时或计划变更的重建。[用户清单决策](2026-09-19-desktop-user-inventory-guards.zh.md)取代与手动安装发生冲突时的自动 desired 同名优先级与 optional 失败排除规则；本决策继续负责持久归属迁移和锁文件规范化。精确删除只覆盖计划中已不存在的发行版归属包名，清单复用允许无关用户插件存在。

旧归属推断要求先前计划 hash 一致、active 结果包含相同 receipt，且 manifest（元数据清单）产物引用匹配。缺失或不完整证据不能授权删除。无效元数据明确失败。迁移只写暂存副本，并参与既有激活 journal 和回滚。旧 receipt 无法揭示留下完全相同历史数据的手动重装；显式归属消除了后续安装的这一歧义。

每次 staged 冻结 pnpm 安装都使用既有[产物锁文件规范化器](../../../../apps/desktop/src/plugin-lock-normalization.ts)，包括 optional candidate 与运行时重建。候选项必须精确匹配 manifest 中的规范引用，由已验证的来源快照 lock 或 verified-release receipt 支持，随后还需匹配产物 SHA-256。规范化仅处理单个 importer 的依赖 specifier 中的 Windows 分隔符差异。包解析结果、版本、integrity、manifest 和冻结校验均保持不变。规范化器限制读取大小，检查无链接的普通文件和产物目录，并在验证所有保留候选项后原子替换 staged 锁文件。未知 schema、多个 importer 和无关失配保持不变，留给冻结校验；不安全的文件、错误格式文本和损坏产物会导致失败，不重写锁文件。

本决策取代[验证 Release 事务决策](../architecture/2026-09-15-desktop-verified-release-plugin-transactions.zh.md)中基于 receipt 的归属与删除规则；其产物获取、依赖图验证、健康检查与回滚要求仍然有效。[来源快照决策](../feature/2026-09-17-desktop-plugin-source-snapshots.zh.md)继续负责快照获取、持久身份与产物规范化；这里不引入仅处理 receipt 的独立锁文件修复路径。

## Alternatives considered

**把验证视为发行版归属。** 这会混淆来源验证与用户意图，并删除手动安装的验证插件。

**只从最新计划推导归属。** 显式手动重装同一来源后，重建又会把它归为发行版。持久归属元数据保留该选择，而不覆盖计划要求的不同来源。

**关闭冻结验证来恢复旧锁文件。** 通用依赖刷新可能接受无关漂移。基于产物的分隔符规范化保留选定的包依赖图及全部既有锁定解析结果。

## Consequences

Profile 元数据增加私有归属记录，公开 provisioning capability 和 schema 保持不变。空计划保留用户插件；只有用户清单检查允许目标缺失时，optional 失败才排除该目标条目，required 失败保留先前 profile。忽略归属的旧客户端不提供此保留保证。共享任务、Session 与凭据数据不属于该事务。

所属回归覆盖复用与强制重建、required 和 optional 来源、显式替换、旧证据、错误归属及回滚。运行时模式精确计划升级用例验证旧记录与显式归属记录中的已禁用用户插件均被保留。既有规范化测试覆盖来源快照与验证 receipt、真实 pnpm 重建、有界读取、不安全文件和依赖解析结果保持不变。发布安装包验证仍由隔离 Desktop 发布工作流负责，不修改已安装应用。
