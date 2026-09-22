# Agent Note：将托管 Desktop Copilot 维护与 Core 升级分开验收

状态：已实现

[English](2026-09-20-managed-desktop-copilot-maintenance.md) | 中文

## 问题

托管 Windows Desktop 需要升级其 release-owned Copilot 包，但不能悄然提升 Core 基线，也不能在官方 Core 已提供完整等价能力后继续无条件保留 companion 行为。插件发布、Core 兼容性、打包 Desktop 行为和已安装机器激活是彼此独立的证据。

仅升级 Copilot 的维护工作保留经过评审的 Core 基线，不因插件选择而改变。alpha.2 Desktop 候选纳入不可变的 [Copilot `0.4.0-alpha.35`](https://github.com/cloga/dsh-github-copilot/releases/tag/v0.4.0-alpha.35) 及其维护验收要求。插件发布及声明的 alpha.1/alpha.2 兼容性并不能证明 Core alpha.2 Desktop 适配通过验收。

## 决策

Copilot 维护版本保留已评审的 Core 版本和精确依赖 registry，并替换完整的 verified-release source lock。计划绑定 Release tag、asset 标识、字节大小、SHA-256、SHA-512 SRI、目标源码以及校验和清单。测试比较完整 provisioning 对象，而不是只比较部分字段。Client 布局适配使用支持换行的公开 shared composer dock，同时保留目标 Core 的 ContextMeter 位置、Host 行为、token 统计与计费。alpha.2 已拥有 dock 和卡片下方的 ContextMeter；其适配只增加换行及安全的空 outlet 处理，不导入 alpha.1 的整个 composer。本决策细化 provider Release 选择与官方优先评审；[verified release transaction](2026-09-15-desktop-verified-release-plugin-transactions.zh.md)继续作为 acquisition、staging、ownership、rollback 与 receipt 的权威。

首次启动及重启后的设置验收保持登出且只读。它要求先确认账户与搜索视图就绪，再记录已退役 Model roles 不存在；同时检查不含已移除 compatibility disclosure 的 Manage、仅提供方级别的 **Search provider** 与 **Fallback provider** 控件、已注册目录、精确 provisioning 清单及重启后稳定的 receipt。`settingsAcceptance` 包含两次真实的 schema-3 观察及 `retiredModelRolesAbsent: true`；历史 schema-2 角色加载证据不会被重新标记。不再为已退役卡片截图。验收绝不保存设置、发起 OAuth、打开验证地址、调用模型或搜索提供方、请求实时额度，也不改变用户 profile。Copilot 的合成 Client 测试另行覆盖 Desktop 同窗口验证导航、Web 新标签页行为以及可选择的手动 URL 交接；Desktop 验收不会在操作者浏览器上重复这些动作。

Alpha.28 保留插件拥有的独立 prompt 与 input/output 组合准入，同时向官方有界 compaction 路径发出信号。Alpha.29 保留仅提供方路由、一次 routing namespace compare-and-swap、一个不同的最终回退，以及无需模型前置条件的 Copilot 账户拥有搜索模型解析。Alpha.30 保留现有 Desktop 外部导航交接与可选择的手动验证地址。Alpha.31 将 OAuth renewal 与 credential persistence 交给原生实现，同时保留有界 managed-route HTTP 401 proof retirement。Alpha.32 增加规范化账户额度快照和可选 Session 级 composer 呈现，不替换原生 Context meter，也不虚构 Session credits。在官方 Core 尚未提供等价策略之处，这些行为继续由插件拥有。

Alpha.33 修复 Client 必需的 `useSession(selector)` 调用，不改变 Core。原始 alpha.32 到 alpha.33 归档比较确认依赖、exports、全部 36 个 capability ID 和 compaction 行为保留；其 Host JavaScript 仅改变内嵌版本，其他四个运行时 JavaScript 文件保持一致。正向合成 Session 验收使用实际打包 renderer 与已发布 Client，补充登出检查。它保留继承与显式缺席 Session binding 的区别、四次符合条件的额度读取、可见状态下的资源释放及原始应用恢复。[release-channel 决策](2026-09-15-fork-owned-windows-desktop-release-channel.zh.md#positive-packaged-plugin-acceptance)拥有隔离与证据限制。Core alpha.1 与 alpha.2 已提供 selector hook 和 Slot 错误边界；插件遵循这些官方 API，而不是增加 Core fallback。

Alpha.34 退役 Model roles 卡片、旧版 Settings 入口、角色选择器和新建专用根会话功能。Alpha.35 保留该退役决定，以及仅服务于已有历史的兼容 Host 支持；布局维护不恢复角色设置写入或 Host 功能。原始 alpha.33 到 alpha.35 比较确认全部 36 个 capability ID、精确 alpha.2 peer 准入、用量 Session binding 和 compaction 行为保留。Host 变更还包括角色退役与可选重置数据规范化，因此不能把 alpha.33 的 Host 仅版本变化结论移用于 alpha.35。

初次启动／重启与合成正向检查之后，第三次应用启动通过打包的公开 Session、JSONL persistence 与 WorkspaceRegistry API，在同一个自有临时 home 内写入一个测试独有的持久化 Session。独占归属标记限制该写入。合成 `github-copilot` / `synthetic-layout-model` 历史提供 10 个 input、90 个 cache-read、5 个 output token，不执行推理。真实应用在 1280 与 400 像素宽度下测量 InputBar、StatsPills 和已发布 Client，要求宽布局中控件与 Cache hit 同行并位于其后方，两种宽度均水平方向不越界／不重叠，并核对字号、行高及颜色一致。原生时间、Token usage 和未登录 Copilot 对话框必须能够打开、用 Escape 关闭并恢复焦点。Copilot 对话框省略 Session credits 及不可用重置日期，不强制刷新。完整的自有源码／运行身份及原始字节哈希绑定这些临时观察；它们不代表实时 quota 或就绪的数字 credits。检查错误在主动关闭前封存，同一个外层清理所有者控制所有阶段。[Desktop 测试参考](../../../../apps/desktop/tests/README.zh.md#verification-hosted)负责版本化完成协议及独立安装升级要求。

## 官方优先比较

精确官方评审目标是 [Core `0.1.6-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2)。插件 alpha.35 的 [alpha.2 比较](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.35/docs/official-first-016-alpha2.md)、[compaction 决策](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.35/docs/copilot-compaction.md)与[账户用量约定](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.35/docs/copilot-usage.md)提供源码级策略证据；制品验证仍是独立检查。

| 领域 | 官方 alpha.2 支持 | 决策与迁移条件 |
|---|---|---|
| OAuth、常规 Copilot transport、严格 Remote factory、service tracing、串行初始化、原生 subagent descriptor | Alpha.35 已使用完整原语 | 继续使用官方原语。只有在受支持 Core 下限提升且打包 alpha.2 验收通过后，才移除 alpha.1 compatibility bridge。 |
| Managed HTTP 401 recovery | 原生 `Models.getAuth()` 与 canonical credentials 拥有 renewal 和 persistence；Core 不拥有 Copilot route proof、同 token 拒绝、cooldown 或 generation race | 仅保留有界 managed-route rejection policy。官方 provider transport 提供等价 provider-scoped rejected-token renewal 并通过 Desktop 验收后移除。 |
| 账户额度与 composer 用量 | Public Remote codec 与原生 Context meter 是官方原语；Core 不暴露完整 Copilot provider quota、credits 或 Session attribution | 保留规范化账户快照与可选 Copilot Session UI。官方 API 提供等价账户语义和受支持 Session-scoped composer seam 后移除。 |
| Composer dock 位置 | 官方 shared flex dock 与固有宽度统计组支持相邻的公开 dock 条目 | 保留官方 alpha.2 dock 和 ContextMeter 位置；在官方几何通过等效宽／窄原生检查之前，保留换行与不影响布局的空 outlet 处理。alpha.1 回移实现不是另一套 alpha.2 所有者。 |
| 账户拥有的模型发现 | 部分支持；官方 catalog 不能替代经过认证的 Copilot 账户刷新与 ownership proof | 保留 discovery、proof、cache、cooldown 与 route 处理，直到官方账户与 entitlement discovery 能保留受支持 endpoint、capability、route、Session 和 profile 状态。 |
| 跨提供方搜索路由 | 部分支持；官方提供方选择没有提供完整的 initiating-Chat、显式 primary、单一最终 fallback、cancellation、account invalidation、disclosure 与 legacy migration 策略 | 保留仅提供方 companion 策略，直到官方 settings 与 runtime 提供等价行为及迁移测试。 |
| Compaction 与恢复 | 部分支持；官方有界 compaction 是权威实现，但 Copilot 特定独立准入与 summary-purpose 默认值不是官方策略 | 复用官方恢复。只有官方行为执行等价 provider budget 并通过 oversized-history 验收后，才移除 companion 准入与默认值。 |
| Plugin Manager 与 runtime unload | Alpha.2 已提供 | alpha.2 候选已在源码中采用这些原语；精确 source conversion、ownership retention、staged health、rollback、recovery 与 runtime 行为的打包验收仍待完成。 |
| Desktop 验证导航 | 现有 Desktop navigation 拥有同窗口外部交接；Copilot 仍拥有提供方特定呈现与手动恢复 | 只有官方 provider/account UI 提供等价 Desktop handoff、manual URL、cancellation 与 packaged acceptance 后，才移除插件 glue。 |

Alpha.34 的 Model roles 退役是产品决定，不代表官方已提供等价功能。不会仅因官方原语名称相似而移除其他 companion 功能。[官方优先 Desktop 评估](../../proposed/architecture/2026-09-18-official-first-desktop-safety.zh.md)负责 alpha.2 源码采用及剩余产物验收；纳入此维护工作不证明打包或已安装验收通过。

## 发布证据边界

`.cloga.18` 正式运行通过其打包态原生几何检查，但全新 home 的 observer 在获取插件时遇到 HTTP 403；该运行没有发布 Desktop。单独的 HTTP 403 不能确定限流原因。[手动获取诊断](../../../../apps/desktop/README.zh.md#plugin-acquisition-diagnostic)隔离执行一次匿名获取，使用未改变的精确 alpha.35 plan，不修改产品源码、认证策略、完整性检查、版本或发布验收。协调操作者负责在合并后的 workflow 完成注册后发起 dispatch；此诊断不是重试发布。

该诊断有意在托管 Node 下运行源码获取 helper，而非打包的 Electron 载体，runner IP 也可能不同。有界、脱敏的 HTTP 观察能够缩小失败路由范围并提供有效的 rate-limit header，但不能仅凭状态确定原始拒绝原因。它既不安装也不执行下载的插件，并删除自有临时目录；清理失败仍使运行失败。即使诊断成功，也不证明打包启动、原生 Session 几何、发布或本地安装/激活，不替代正式发布检查。

Copilot alpha.35 的[合并后运行 35603503257](https://github.com/cloga/dsh-github-copilot/actions/runs/35603503257)通过兼容性、精确 alpha.2 Windows/Ubuntu、构建及不可变 GitHub 发布检查；整体运行在 npm 发布／完整性回读步骤失败。[只读验证运行 35605111730](https://github.com/cloga/dsh-github-copilot/actions/runs/35605111730)报告成功。独立原始资产评审检查了不可变 GitHub tarball、校验和清单、源码／tag／tree 绑定及 SHA-512 integrity，但未获取该验证器的 receipt 归档，也不作独立 npm 验证声明。插件字节验证不代表 Desktop 安装器或本地激活通过验收。

历史 alpha.33 的 [run 35559690050](https://github.com/cloga/dsh-github-copilot/actions/runs/35559690050) 与后续 [verifier run 35560198211，第 2 次尝试](https://github.com/cloga/dsh-github-copilot/actions/runs/35560198211/attempts/2)仅涉及 alpha.33，不代表 alpha.35 或新的 Desktop 发布。其原始资产评审同样只验证 GitHub 字节，未取得 npm 验证器 receipt。每个维护版本都需要自己的不可变插件 lock 与 Desktop 验收；Desktop 使用已发布字节，不重新发布或改写插件 Release。

经过评审的目标或验收代码本身都不构成已发布 Desktop 验证。历史证据与合成用量或几何检查不证明实时 OAuth、账户 quota、模型推理、托管搜索、fallback 费用、本地安装或激活。这些操作需要单独授权，不能从 CI、包哈希或打包的登出验收推断。

## 考虑过的替代方案

**将插件 pin 视为 Core alpha.2 验收。** 兼容性不是打包验收。仅升级 Copilot 的维护版本保留狭窄的回滚点；纳入该更新的 Core 升级候选仍须完成自身产物验收。

**删除名称相似的官方原语所对应的 companion 行为。** 名称相似不能证明策略、持久化、取消或迁移等价性。移除必须等待比较表中的条件成立。

**在 Desktop 打包期间执行 OAuth 或搜索。** 这需要账户状态、可能产生费用，并会修改验收状态。不可变字节加未登录 UI、inventory、restart 与隔离合成 Session 检查是发布条件；实时提供方检查继续保持独立。

## 结果

每次托管 Copilot 更新都要推进 Desktop 版本与 sequence，即使 Core 和 shell 代码保持不变。打包 Release 携带精确插件 source 与 dependency registry，Windows Ops 可以独立固定由此产生的 Desktop 资产。Core 升级会刷新此比较，并在迁移或移除 companion 行为前要求自身的打包与已安装演练。
