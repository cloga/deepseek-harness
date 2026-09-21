# Agent Note：将托管 Desktop Copilot 维护与 Core 升级分开验收

状态：已实现

[English](2026-09-20-managed-desktop-copilot-maintenance.md) | 中文

## 问题

托管 Windows Desktop 需要升级其 release-owned Copilot 包，但不能悄然提升 Core 基线，也不能在官方 Core 已提供完整等价能力后继续无条件保留 companion 行为。插件发布、Core 兼容性、打包 Desktop 行为和已安装机器激活是彼此独立的证据。

仅升级 Copilot 的维护工作保留经过评审的 Core 基线，不因插件选择而改变。alpha.2 Desktop 候选已纳入不可变的 [Copilot `0.4.0-alpha.33`](https://github.com/cloga/dsh-github-copilot/releases/tag/v0.4.0-alpha.33) 及其维护验收要求。Copilot alpha.33 同时支持 Core alpha.1 与 alpha.2，但这种兼容性并不能证明 Core alpha.2 Desktop 适配通过验收。

## 决策

仅升级 Copilot 的 Desktop 维护版本保留已评审的 Core 基线和精确依赖 registry，并替换完整的 verified-release source lock。计划绑定 Release tag、asset 标识、字节大小、SHA-256、SHA-512 SRI、目标源码以及校验和清单。测试比较完整 provisioning 对象，而不是只比较部分字段。本决策细化 provider Release 选择与官方优先评审；[verified release transaction](2026-09-15-desktop-verified-release-plugin-transactions.zh.md)继续作为 acquisition、staging、ownership、rollback 与 receipt 的权威。

打包验收保持登出且只读。它检查真实账户与 Manage 界面、已移除 compatibility disclosure 不再出现、只读 Model roles 视图、仅提供方级别的 **Search provider** 与 **Fallback provider** 控件、已注册提供方目录、精确 provisioning 清单以及重启后稳定的 receipt。它在初次启动和重启时均等待登出账户与登录入口可见，再检查额度控件和 credit summary 未出现。这些 DOM 证据不观察 Host quota 数据包、实时账户访问或 Session 计费；不可变插件的 gateway regression 拥有其无启动/登出网络请求的结论。它绝不保存设置、发起 OAuth、打开验证地址、调用模型或搜索提供方、请求实时额度，也不修改 profile。Copilot 自己的合成 Client 测试覆盖 Desktop 同窗口验证导航、Web 新标签页行为以及可选择的手动 URL 交接；Desktop 验收不会在操作者浏览器上重复这些动作。

Alpha.28 保留插件拥有的独立 prompt 与 input/output 组合准入，同时向官方有界 compaction 路径发出信号。Alpha.29 保留仅提供方路由、一次 routing namespace compare-and-swap、一个不同的最终回退，以及无需模型前置条件的 Copilot 账户拥有搜索模型解析。Alpha.30 保留现有 Desktop 外部导航交接与可选择的手动验证地址。Alpha.31 将 OAuth renewal 与 credential persistence 交给原生实现，同时保留有界 managed-route HTTP 401 proof retirement。Alpha.32 增加规范化账户额度快照和可选 Session 级 composer 呈现，不替换原生 Context meter，也不虚构 Session credits。在官方 Core 尚未提供等价策略之处，这些行为继续由插件拥有。

Alpha.33 修复 Client 必需的 `useSession(selector)` 调用，不改变 Core。与直接前序 alpha.32 的原始归档比较确认依赖、exports、全部 36 个 capability ID 和 compaction 行为保留；Host JavaScript 仅改变内嵌版本，其他四个运行时 JavaScript 文件保持一致。正向合成 Session 验收使用实际打包 renderer 与已发布 Client，补充登出检查；[release-channel 决策](2026-09-15-fork-owned-windows-desktop-release-channel.zh.md#positive-packaged-plugin-acceptance)拥有隔离与证据限制。Core alpha.1 与 alpha.2 已提供 selector hook 和 Slot 错误边界；插件遵循这些官方 API，而不是增加 Core fallback。

## 官方优先比较

精确官方评审目标是 [Core `0.1.6-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2)。插件的 [alpha.2 比较](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.33/docs/official-first-016-alpha2.md)、[compaction 决策](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.33/docs/copilot-compaction.md)与[账户用量约定](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.33/docs/copilot-usage.md)提供源码级证据。

| 领域 | 官方 alpha.2 支持 | 决策与迁移条件 |
|---|---|---|
| OAuth、常规 Copilot transport、严格 Remote factory、service tracing、串行初始化、原生 subagent descriptor | Alpha.33 已使用完整原语 | 继续使用官方原语。只有在受支持 Core 下限提升且打包 alpha.2 验收通过后，才移除 alpha.1 compatibility bridge。 |
| Managed HTTP 401 recovery | 原生 `Models.getAuth()` 与 canonical credentials 拥有 renewal 和 persistence；Core 不拥有 Copilot route proof、同 token 拒绝、cooldown 或 generation race | 仅保留有界 managed-route rejection policy。官方 provider transport 提供等价 provider-scoped rejected-token renewal 并通过 Desktop 验收后移除。 |
| 账户额度与 composer 用量 | Public Remote codec 与原生 Context meter 是官方原语；Core 不暴露完整 Copilot provider quota、credits 或 Session attribution | 保留规范化账户快照与可选 Copilot Session UI。官方 API 提供等价账户语义和受支持 Session-scoped composer seam 后移除。 |
| 账户拥有的模型发现 | 部分支持；官方 catalog 不能替代经过认证的 Copilot 账户刷新与 ownership proof | 保留 discovery、proof、cache、cooldown 与 route 处理，直到官方账户与 entitlement discovery 能保留受支持 endpoint、capability、route、Session 和 profile 状态。 |
| 跨提供方搜索路由 | 部分支持；官方提供方选择没有提供完整的 initiating-Chat、显式 primary、单一最终 fallback、cancellation、account invalidation、disclosure 与 legacy migration 策略 | 保留仅提供方 companion 策略，直到官方 settings 与 runtime 提供等价行为及迁移测试。 |
| Compaction 与恢复 | 部分支持；官方有界 compaction 是权威实现，但 Copilot 特定独立准入与 summary-purpose 默认值不是官方策略 | 复用官方恢复。只有官方行为执行等价 provider budget 并通过 oversized-history 验收后，才移除 companion 准入与默认值。 |
| Plugin Manager 与 runtime unload | Alpha.2 已提供 | alpha.2 候选已在源码中采用这些原语；精确 source conversion、ownership retention、staged health、rollback、recovery 与 runtime 行为的打包验收仍待完成。 |
| Desktop 验证导航 | 现有 Desktop navigation 拥有同窗口外部交接；Copilot 仍拥有提供方特定呈现与手动恢复 | 只有官方 provider/account UI 提供等价 Desktop handoff、manual URL、cancellation 与 packaged acceptance 后，才移除插件 glue。 |

仅凭此次维护更新，没有任何完整 companion 功能拥有足以删除的等价性证据。[官方优先 Desktop 评估](../../proposed/architecture/2026-09-18-official-first-desktop-safety.zh.md)负责 alpha.2 源码采用及剩余产物验收；将此维护工作纳入该候选不证明打包或已安装验收通过。

## 发布证据边界

Copilot alpha.33 合并后的 [run 35559690050](https://github.com/cloga/dsh-github-copilot/actions/runs/35559690050) 通过 compatibility、精确 alpha.1/alpha.2 Windows/Ubuntu、verification 与 packaging 检查，并发布不可变 GitHub Release；整体运行在 npm 发布／完整性验证步骤失败。只读 verifier [run 35560198211，第 2 次尝试](https://github.com/cloga/dsh-github-copilot/actions/runs/35560198211/attempts/2)随后报告成功。原始资产评审独立验证了 GitHub tarball 与校验和记录，但未获取该 verifier 的 receipt 归档，因此不提供独立 npm 验证。Desktop 使用已经发布的不可变 GitHub 字节；它既不重新发布，也不改写插件 Release。

这些证据不证明实时 OAuth、模型推理、托管搜索、fallback 费用、本地安装或激活。这些操作需要单独授权，不能从 CI、包哈希或打包的登出验收推断。

## 考虑过的替代方案

**将插件 pin 视为 Core alpha.2 验收。** 兼容性不是打包验收。仅升级 Copilot 的维护版本保留狭窄的回滚点；纳入该更新的 Core 升级候选仍须完成自身产物验收。

**删除名称相似的官方原语所对应的 companion 行为。** 名称相似不能证明策略、持久化、取消或迁移等价性。移除必须等待比较表中的条件成立。

**在 Desktop 打包期间执行 OAuth 或搜索。** 这需要账户状态、可能产生费用，并会修改验收状态。不可变字节加只读 UI、inventory 与 restart 检查是发布条件；实时提供方检查继续保持独立。

## 结果

每次托管 Copilot 更新都要推进 Desktop 版本与 sequence，即使 Core 和 shell 代码保持不变。打包 Release 携带精确插件 source 与 dependency registry，Windows Ops 可以独立固定由此产生的 Desktop 资产。后续 Core 升级必须刷新此比较，并完成自己的 packaged rehearsal，才能迁移或移除 companion 行为。
