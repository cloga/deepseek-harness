# Agent Note: Issue 策略的选择性求值

Status: implemented

[English](2026-09-07-selective-issue-policy-evaluation.md) | 中文

## 问题

信息型 Issue 引用提供背景，解决型引用则带有 Priority 义务。两者都要求 Project 访问，会让无关的看板配置或 App 可用性阻止仅提供背景的 PR（Pull Request）。在确定强制范围之前读取被引用 Issue，也会为不可能因策略而失败的 PR 消耗凭据与 API 请求。

生命周期事件有独立成本：批准、评论、推送、标签变更或指派变更不一定需要执行 Project 状态交接。为已知无操作的事件分配 runner，会占用容量而不改变 Issue。

## 决策

[Issue policy](../../../../.github/workflows/issue-policy.yml)保留 job 与受信任的实现。强制范围判定先于引用读取与 Project App token 创建：草稿 PR、Bot/App 作者，以及既无评审请求也无已提交评审的人类 PR 均不需要策略校验。

工作流在调用命令前检查受信任检出中的选择性预检能力标记。缺少标记的检出对人类 PR 执行完整旧版校验，并保留旧版 Bot/App 豁免。这支持 PR 工作流 YAML 与缺少预检功能的默认分支代码配合执行；执行错误不会触发回退。

强制范围内的 PR 通过仓库 REST 读取解析引用。信息型引用无需 Project 访问即可证明 Issue 身份。只有解决型引用指向的实际 Issue 需要读取 Project Priority；PR 编号既不能满足 Issue 引用要求，也不会引发 Project 查询。[所属参考文档](../../../../.github/issue-management/README.zh.md)定义元数据校验与失败行为。

[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml)订阅与状态相关的 PR 事件，并过滤仅标题编辑。它不订阅 PR 推送、PR 标签变更或 Issue 指派变更。job 条件在 runner 分配前排除 approved/commented 评审。请求修改的评审保留其状态命令。

本调度决策部分取代[事件驱动评审状态](2026-08-10-event-directed-pr-review-status.zh.md)中无操作 job 的调度方式，但不取代交接语义或人工状态归属保护。[Project 局部规划字段](2026-09-02-project-local-issue-planning-fields.zh.md)仍拥有对每个被引用 Issue（包括信息型引用）仅在 PR 打开时、仅对空值初始化 Start Date 的规则。校验读取豁免不豁免该生命周期 mutation。

## fork 仓库权威来源

Issue #64 和 #90 指出另一类路由缺陷：用 Project 所属组织的仓库读取 fork PR，会在强制范围或元数据校验之前失败。PR 读取器将经上下文验证的仓库所有者与不变的 Project 组织分开。fork 工作流使用现有、经明确批准的不可变实现，其他仓库保留默认分支权威来源。PR head 实现不能自行授权；[所属参考文档](../../../../.github/issue-management/README.zh.md#configuration-and-limitations)定义生效时点和固定版本维护规则。

即使不需要 Project 访问，fork 仍执行最终元数据校验。App 请求仍以实际解决型 Issue 需求为条件，必需访问失败仍会阻塞。生命周期写入独立存在，不继承仅用于 PR 的所有者覆盖值。仓库引用检查识别 YAML 所属的检出版本标识，而不是豁免整个文件或改变正文中禁止 commit 引用的规则。

## 考虑过的替代方案

**跳过 fork 策略或将错误仓库的 404 视为豁免。** 两者都会删除标签/引用校验，而不是修复其输入。经验证的仓库路由仍会对缺失 Issue 或不可用的必需 Project 数据报错。

**执行当前 PR head 或自动更新固定版本。** 两者都允许未经评审的实现替换受信任策略。复用已批准的固定实现，使信任决策可独立于 PR 推送接受评审。

**读取每个被引用 Issue 的 Project 字段。** 信息型引用不约束 Priority，因此这些查询只增加失败依赖，不贡献校验结果。

**为批准与评论保留成功的无操作生命周期 job。** 这可以保持绿色 job 展示，却会为没有生命周期命令的事件分配 runner。生命周期与保留的必需策略 job 相互独立。

**删除必需策略 job 或重新设计检查权威来源。** 选择性读取和生命周期调度可以减少可避免的工作，无需改变 GitHub 期待的必需检查。检查权威来源的重新设计不属于本决策。

## 影响

仅含信息型引用的校验需要仓库访问，但不需要 Project 凭据。解决型校验在所需 Project 读取或字段检查失败时仍会失败。预检与最终校验各自读取实时 REST 状态，重复仓库请求而不缓存结论。避免 Project 读取与 token 创建不保证减少 API 请求总数。必需策略 job 仍分配 runner；它并非零成本的必需检查。

维护者手动管理 Project 自定义 Priority 字段。原生 Issue 字段的 skill 指引不会更新该值。不提供 Priority 同步或字段迁移，也不改变[不检查展示形式的策略](2026-09-03-semantic-issue-templates-and-policy.zh.md)。

被省略的生命周期事件不能修复过时的 Project 状态。事件重放和并发写入仍有生命周期与规划字段文档记录的竞态。实际 Actions 分钟节省与 GitHub App 实际访问权限需要运营观察，不能从模拟 API 测试推断。

## 验证

[策略测试](../../../../.github/issue-management/policy.test.mjs)验证早期豁免、仅使用 REST 的信息型引用、实际 Issue 过滤、解决型 Priority 读取及失败，以及生命周期命令选择。[工作流测试](../../../../scripts/ci-workflow.spec.ts)验证 Project token 条件、保留的必需 job、精简后的订阅及 runner 级生命周期过滤。fork 回归还拒绝不一致的仓库上下文、Ready PR 缺失元数据、Project 访问被拒、动态检出来源及位置错误的固定版本标识；测试继续覆盖非 fork 工作流范围。本地 fixture 不能证明实际 webhook 交付或计费结果。
