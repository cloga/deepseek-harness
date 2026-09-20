# Agent Note：将托管 Desktop Copilot 维护与 Core 升级分开验收

状态：已实现

[English](2026-09-20-managed-desktop-copilot-maintenance.md) | 中文

## 问题

托管 Windows Desktop 需要升级其 release-owned Copilot 包，但不能悄然提升 Core 基线，也不能在官方 Core 已提供完整等价能力后继续无条件保留 companion 行为。插件发布、Core 兼容性、打包 Desktop 行为和已安装机器激活是彼此独立的证据。

当前发布计划保留 Core `0.1.6-alpha.1`，并固定不可变的 [Copilot `0.4.0-alpha.30`](https://github.com/cloga/dsh-github-copilot/releases/tag/v0.4.0-alpha.30)。Copilot alpha.30 同时支持 Core alpha.1 与 alpha.2，但这种兼容性并不能验收由其他负责人维护的 Core alpha.2 Desktop 适配。

## 决策

仅升级 Copilot 的 Desktop 维护版本保留已评审的 Core 基线和精确依赖 registry，并替换完整的 verified-release source lock。计划绑定 Release tag、asset 标识、字节大小、SHA-256、SHA-512 SRI、目标源码以及校验和清单。测试比较完整 provisioning 对象，而不是只比较部分字段。本决策细化 provider Release 选择与官方优先评审；[verified release transaction](2026-09-15-desktop-verified-release-plugin-transactions.zh.md)继续作为 acquisition、staging、ownership、rollback 与 receipt 的权威。

打包验收保持登出且只读。它检查真实账户与 Manage 界面、已移除 compatibility disclosure 不再出现、只读 Model roles 视图、仅提供方级别的 **Search provider** 与 **Fallback provider** 控件、已注册提供方目录、精确 provisioning 清单以及重启后稳定的 receipt。它绝不保存设置、发起 OAuth、打开验证地址、调用模型或搜索提供方，也不修改 profile。Copilot 自己的合成 Client 测试覆盖 Desktop 同窗口验证导航、Web 新标签页行为以及可选择的手动 URL 交接；Desktop 验收不会在操作者浏览器上重复这些动作。

Alpha.28 保留插件拥有的独立 prompt 与 input/output 组合准入，同时向官方有界 compaction 路径发出信号。Alpha.29 保留仅提供方路由、一次 routing namespace compare-and-swap、一个不同的最终回退，以及无需模型前置条件的 Copilot 账户拥有搜索模型解析。Alpha.30 保留现有 Desktop 外部导航交接与可选择的手动验证地址。在官方 Core 尚未提供等价策略之处，这些行为继续由插件拥有。

## 官方优先比较

精确官方评审目标是 [Core `0.1.6-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2)。插件的 [alpha.2 比较](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.30/docs/official-first-016-alpha2.md)与 [compaction 决策](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.30/docs/copilot-compaction.md)提供源码级证据。

| 领域 | 官方 alpha.2 支持 | 决策与迁移条件 |
|---|---|---|
| OAuth、常规 Copilot transport、严格 Remote factory、service tracing、串行初始化、原生 subagent descriptor | Alpha.30 已使用完整原语 | 继续使用官方原语。只有在受支持 Core 下限提升且打包 alpha.2 验收通过后，才移除 alpha.1 compatibility bridge。 |
| 账户拥有的模型发现 | 部分支持；官方 catalog 不能替代经过认证的 Copilot 账户刷新与 ownership proof | 保留 discovery、proof、cache、cooldown 与 route 处理，直到官方账户与 entitlement discovery 能保留受支持 endpoint、capability、route、Session 和 profile 状态。 |
| 跨提供方搜索路由 | 部分支持；官方提供方选择没有提供完整的 initiating-Chat、显式 primary、单一最终 fallback、cancellation、account invalidation、disclosure 与 legacy migration 策略 | 保留仅提供方 companion 策略，直到官方 settings 与 runtime 提供等价行为及迁移测试。 |
| Compaction 与恢复 | 部分支持；官方有界 compaction 是权威实现，但 Copilot 特定独立准入与 summary-purpose 默认值不是官方策略 | 复用官方恢复。只有官方行为执行等价 provider budget 并通过 oversized-history 验收后，才移除 companion 准入与默认值。 |
| Plugin Manager 与 runtime unload | Alpha.2 已提供 | 只有独立 alpha.2 Desktop 路线完成精确 source conversion、ownership retention、staged health、rollback、recovery 与 packaged runtime 验收后，才优先采用这些原语。 |
| Desktop 验证导航 | 现有 Desktop navigation 拥有同窗口外部交接；Copilot 仍拥有提供方特定呈现与手动恢复 | 只有官方 provider/account UI 提供等价 Desktop handoff、manual URL、cancellation 与 packaged acceptance 后，才移除插件 glue。 |

没有任何完整 companion 功能在此维护版本中拥有足以删除的等价性证据。由其他负责人维护的 alpha.2 draft 继续独立；本发布不修改、合并、rebase 或吸收它。

## 发布证据边界

Copilot alpha.30 PR CI 在 [run 35509010326](https://github.com/cloga/dsh-github-copilot/actions/runs/35509010326) 中完成 alpha.1/alpha.2 与操作系统矩阵并全部成功。合并后的 [run 35509515713](https://github.com/cloga/dsh-github-copilot/actions/runs/35509515713) 在不可变 GitHub 发布与 npm 步骤之后报告失败。独立只读 verifier [run 35509895667，第 2 次尝试](https://github.com/cloga/dsh-github-copilot/actions/runs/35509895667/attempts/2)通过，并在 artifact `10604789589` 中记录发布验证以及 GitHub/npm 字节一致性。Desktop 使用已经发布的不可变 GitHub 字节；它既不重新发布，也不改写插件 Release。

这些证据不证明实时 OAuth、模型推理、托管搜索、fallback 费用、本地安装或激活。这些操作需要单独授权，不能从 CI、包哈希或打包的登出验收推断。

## 考虑过的替代方案

**随插件 pin 一起提升 Core alpha.2。** 兼容性不是打包验收。合并两条路线会吸收他人负责的工作，并失去狭窄的维护回滚点。

**删除名称相似的官方原语所对应的 companion 行为。** 名称相似不能证明策略、持久化、取消或迁移等价性。移除必须等待比较表中的条件成立。

**在 Desktop 打包期间执行 OAuth 或搜索。** 这需要账户状态、可能产生费用，并会修改验收状态。不可变字节加只读 UI、inventory 与 restart 检查是发布条件；实时提供方检查继续保持独立。

## 结果

每次托管 Copilot 更新都要推进 Desktop 版本与 sequence，即使 Core 和 shell 代码保持不变。打包 Release 携带精确插件 source 与 dependency registry，Windows Ops 可以独立固定由此产生的 Desktop 资产。后续 Core 升级必须刷新此比较，并完成自己的 packaged rehearsal，才能迁移或移除 companion 行为。
