---
description: "dsh Web 客户端的「插件」设置分区：功能自有的标签页、可配置宿主平面插件卡片，以及 settings.plugin.item 扩展点。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugins

[English](README.md) | 中文

## 概述

使用**插件**设置分区可以配置当前部署公开的插件，也可以打开插件功能自己的页面。**插件配置**标签页会为每个受支持的插件展示一张可展开卡片，标明用户覆盖过哪些值，并允许用户将它们重置为部署默认值。卡片会在本地保留修改，直到用户保存。如果配置在卡片加载后发生变化，保存会被拒绝，而不会覆盖较新的值。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开设置中的「插件」分区并选择**插件配置**标签页，即可编辑本部署所组装的宿主平面插件。卡片依次为 shell 执行器（`shell`）、agent loop（智能体循环）的工具调用并行度（`agent-loop`）、subagent 模型选择（`subagent-model-selection`）、Auto 模型路由（`model-routing`）以及 DeepSeek 搜索提供方（`web-search-deepseek`）。

### 这里会出现什么

标签页读取 Host 服务了哪些 settings 命名空间，并为每个命名空间派发一个 slot 键，因此渲染出来的是两份账本的交集：存活 Host 插件注册的命名空间，以及注册在这些键上的卡片。被服务却无人认领的命名空间什么都不渲染；命名空间未被本部署服务的卡片根本不会被派发。空态文案要等 Host 的第一次答复，因此一次尚未答复的读取绝不会被读成「本部署没有可配置的插件」。

### 编辑与保存

卡片暂存用户输入，只有用户保存时才写入。每个控件渲染的都是暂存文本，因此屏幕上所见即保存后所存；**放弃修改**丢弃这些草稿，持有未保存修改的卡片即使收起也会在标题上标明。保存成功后，卡片会在回读确认写入后收起；保存失败时，卡片保持展开、报告失败并保留草稿供用户修改。重置暂存的是组装默认值而非立即写入；字段不接受的草稿会阻塞保存，而不是被丢弃。某个值是否被接受只有 Host 说了算。

subagent 卡会同时暂存其权限开关与精确模型复选框。启用时必须至少选择一条适配器路由。保存会在一次 mutation 中提交 `enabled` 与 `allowedModels`，并以草稿开始时的 revision 设栅；Host revision 更新后，草稿会标记为失败，而不会恢复已撤销的路由。关闭时会保留已选路由供以后重新使用。可用模型按提供方分组；当前目录中缺失的已存路由排在末尾，且仍可移除。适配器名称与模型描述仍属于实时目录元数据，不会存储；适配器变化、设置提交和重连后，卡片会刷新这些元数据。

### Auto 模型路由

Auto 卡通过 `model-routing` 命名空间配置 [Host 路由所有者](../../llm/model-routing/README.zh.md)。它公开启用开关、候选 id 与精确模型／强度组合、用户指定的质量等级和相对成本权重、保守候选、分类器路由与预算、各模式／任务的质量下限，以及置信度阈值。模型和强度选项来自 Host 目录；模型名称或目录默认值都不会决定候选的质量或成本。相对权重不是 token 价格或基准测试结果。编辑此命名空间不会改变独立的 subagent 路由允许列表。

提供方默认强度保持为省略值，与显式强度不同。重新选择同一模型会保留其暂存强度；更换模型会清除该路由自有的强度。重复的精确提供方／模型／强度组合会被拒绝，同一模型的不同强度则仍是有效候选。显式建议值按钮只暂存可见且可编辑的质量下限、置信度和限制，不选择路由、强度、质量等级或权重。策略校验由所属路由包记录，本卡不重复其完整 schema。

保存会在开始编辑时捕获的 revision 下，原子替换不含凭据的命名空间。启用路由要求完整配置。禁用的设置可以省略策略和分类器分节，但无效的部分分节仍保留为草稿：关闭开关不会悄然丢弃现有配置。放弃修改恢复当前已存值；显式重置暂存部署层，并在保存时移除用户覆盖。只读状态阻止变更，竞争 revision 保留可见冲突，保存失败则保留修改并显示安全诊断。

目录加载、错误和提供方局部失败会分别显示。已保存但不可用的模型或强度仍可见且可修复；目录条目消失不会删除它们或扩大授权。提供方、设置和凭据变化会刷新元数据，而不替换草稿；重连则丢弃属于旧 Host 代次的草稿并重新加载。保存既不调用收费分类器，也不安装或重启任何内容。现有 Session 保留已捕获策略；用户需要显式重新选择 Auto 才会捕获修改后的设置。本卡不提供恢复或个性化控件。

### secret 角色字段

密钥控件初始为空、只报告是否已配置，并经由 credentials 领域而非 settings 分节写入；空草稿不写入任何东西，保留已存密钥。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本分区是一个扩展点加一条分派规则：功能插件拥有各自的卡片；标签页按 slot 键把被服务的命名空间与已注册卡片配对。

### 标签页扩展点

本分区声明根级列表 slot `settings.plugins.tab`，其标签会成为有序标签页；某个标签页首次被选择后会保持挂载，因此本地草稿与只读快照在切换标签页时不会丢失。本包注册自己的 `configurable` 贡献，由它声明嵌套的 `settings.plugin.item` slot——以卡片所编辑的 settings 命名空间为键。带浏览器半侧的插件把自己的卡片注册在自己的命名空间上，并拥有它的全部：外观、控件与文案。标签页遵循贡献的 `order`；卡片遵循注册顺序。

### 写入路径

保存时，暂存字段通过客户端 settings scope 写入；每次单字段写入或有序 mutation 都以草稿读取时的命名空间 revision 设栅，因此已与文档脱节的表单会被拒绝，而不是覆盖并发变更。字段是否被覆盖，取决于它是否出现在原始用户层中，而非取决于它的值；重置会清除该字段，使其重新继承组装层。secret 角色的字段绝不搭乘响应；卡片会在转发来的 `credentials/reference-updated` 事件报告它所关注的引用时重读。

Auto 卡的控制器拥有草稿和 revision 限制；settings scope 仍是 Host 状态的镜像。注册通过 `hooks.autoModelRoutingCard` 注入私有可观察源，由渲染器绑定为 `useAutoModelRoutingCard`，并同时提供普通编辑回调。组件不直接订阅外部 store，也不依赖 Host 服务或解析器。dispose（资源释放）会使待完成的目录和保存结算失效，并移除订阅；重连则开始新的草稿与目录代次。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置底座、清单标签页与卡片背后的持久化 seam。

- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.plugins.tab` 与 settings scope 的领域底座。
- [ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.zh.md)——同一分区中的只读「插件列表」标签页。
- [settings](../../settings/README.zh.md)——持久化用户设置 seam 及其文件提供方。
- [credentials](../../credentials/README.zh.md)——secret 字段写入所经的凭据引用 seam。
- [ui-settings-general](../ui-settings-general/README.zh.md)——承载本分区的设置外壳。
- [模型路由](../../llm/model-routing/README.zh.md)——策略校验、捕获的 Session 行为、分类器预算和成本。
- [模型选择](../ui-model-selection/README.zh.md)——为普通 Session 选择 Auto 或手动模型。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端设置界面，不注册任何面向模型的接口。

#### KV Cache 影响

无直接影响；该包既不组装也不发送模型生成请求。保存 Auto 设置不会替换现有 Session 已捕获的策略或活动请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义哪些插件会出现、列表有多新鲜；它们是当前包约束。

- **只有宿主平面的插件会出现**：由 agent preset 挂载的插件把配置内联在该 preset 的 `agent.cordis.yml` 中，且根本无法注册 settings 命名空间，因此本分区不会列出它。编辑那些值仍是 preset 编辑器的职责。
- **卡片仍然需要一份浏览器 bundle**：浏览器半侧必须是按客户端模块系统的 lazy-CJS factory 格式构建的 `dsh.client` 包，而产出它的 `clientBundle` 预设位于 `../../../packages/client/tsdown.client.ts`，并非已发布的包，因此本仓库之外的插件得自行复刻该构建。
- **被服务的命名空间只在两种信号上重读**：协议通告的是 settings 文档提交与连接重置，而非注册行为，因此在标签页读取之后才被其拥有方注册的命名空间，要等下一次文档提交或重连才会加入列表。
- **shell 卡只编辑有限字段**：它暂存 `shell` 命名空间中的 `timeoutMs` 和 `maxOutputBytes`；执行器特有的配置仍由其所属 shell 插件负责。
- **已存 Auto 选择不是提供方健康检查**：不可用的已存路由仍可修复，设置校验成功并不保证后续 Session 选择 Auto 时能够解析这些路由。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是浏览器端设置界面，node half 不持有事件流或可变运行时数据；分层与写入拒绝是 Host 约定，由相应插件和 api-proxy 覆盖。
