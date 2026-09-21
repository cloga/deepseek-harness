# Agent Note: 输入框下的会话统计 —— 双图标 pill 与点击展开的统计弹层

Status: implemented

[English](2026-09-07-composer-session-stats-pills.md) | 中文

## 问题

输入框下方的会话统计条（`StatsLine`，ui-chat，挂载于 `conversation.composer.dock`）把所有数字渲染成一整行常驻文本：轮/步计数、模型与工具用时、TTFT/TPS 均值、紧凑 token 总量与缓存命中率。数字越多行越拥挤，精确 token 计数无处可看（带 `ResizeObserver` 溢出测量的悬停提示只在截断时复述同一行紧凑文本），纯文本也没有分组——时间类数字和计费类数字读起来混作一行。一次页面内 A/B 对比双 pill 变体后方向定案：pill 方案在可扫读性和"每类数字有归属"上胜出。

## 决定

`StatsPills`（packages/client/ui-chat/src/client/chat/StatsPills.tsx）在同一 `conversation.composer.dock` 插槽上取代 `StatsLine`；落选变体已删除，其共享工具函数（`deriveStats`、`formatDuration`、`cacheHitPercent`、`billedInputTokens`）并入新模块，废弃的 `stats.llm`、`stats.toolCall`、`stats.ttftAverage`、`stats.tokensPerSecond`、`stats.tokens` 文案键一并移除。

- **两个图标 pill、两个弹层。** 仪表盘 pill（新增 `IconGaugeOutline16`，因下开口圆弧视觉偏高而把表盘中心光学下移到 y=8.75）展示 `{turns} 轮 {steps} 步` 加输出 TPS，点击打开「会话统计」弹层（模型用时、工具调用用时、首 token 平均、输出速度）；日志里没有任何计时数字时弹层会是空的，此时该 pill 渲染为静态读数而非按钮。数据库 pill（`IconDatabaseOutline16`）展示紧凑计费总量加缓存命中率，点击打开「Token 用量」弹层（缓存命中、未缓存输入、缓存读取、输出，以及非零时的缓存写入——精确计数）。两个弹层共用为这两处消费者抽出的 `stat-dialog` 模块（portal 面板、锚定定位、点击外部关闭、可选的外部持有开合状态）；pill 行持有唯一的互斥开合槽位，打开任一弹层即关闭另一个，且每个按钮携带显式 `aria-label`，用 ` · ` 分隔 aria-hidden 分隔符在视觉上连接的两段文本。[引导起始页与统计 pill 的细化](2026-09-10-guide-start-page-and-stat-pill-refinements.zh.md)负责缓存写入为零时省略该行的规则。
- **数据来源架构不变。** 计数与用时优先读取持久的 `sessionStats` 投影，窗口折叠仅作无该单元装配时的回退（[全会话计数](../../archived/bug-fix/2026-08-12-full-session-turn-step-counts.md)）；token 数字只走 `tokenUsage`，投影缺席时直接不渲染用量 pill，而非展示窗口推算的计费。缓存写入仍计入计费总量与缓存命中分母（[投影决定](../architecture/2026-07-29-projected-token-usage-and-request-context.zh.md)）。上下文占用仍归 ui-conversation 的 `ContextMeter` 所有，在输入卡片下方、两个统计 pill 之后显示圆环和百分比。共用 dock 将统计信息放在一起，工具栏保留给输入操作；ui-chat 不导入上下文组件。上下文面板通过 portal 渲染，复用 ui-primitives 的视口内定位与外部指针关闭工具，统计贡献项缺席时也不会越界。
- **渲染纪律。** 该行只折叠已定稿节点（`chat.legacy.nodes` 身份），流式 chunk 帧零重渲染——由渲染计数单测钉住。无已完成步且无计费 token 的会话什么都不渲染。
- **输入框负责 dock 间距。** `InputBar` 将 slot 贡献项和 `ContextMeter` 放在同一个居中的 flex 行中，在 dock 上下各提供 4px 留白，即使 slot 没有可见贡献项也保持该间距。hero 保持无底部留白，并隐藏空 dock。`StatsPills` 提供可收缩的时间与计费内容，不占满整行宽度，也不添加外部 padding。

## 共享 dock 布局

Composer 拥有居中、可换行的单个 dock 行；StatsPills 提供按内容宽度排列的分组，而不是全宽行。后续公开 dock entry 可紧随原生缓存命中 pill，无需导入 Chat 组件或操作其他插件的 DOM。外部行和原生分组在窄宽度下都可换行；各原生锚点与弹层保持独立。真正为空的 dock 或唯一的空布局中立 outlet 不增加 padding。当前 alpha2 壳保留官方 4px 底部留白及 dock 内的 ContextMeter，不恢复 alpha1 根据统计标记有条件调整底部留白的策略。

官方 Core `0.1.6-alpha.2` 已提供共享 flex dock 和按内容宽度排列的统计分组。保留 alpha.1 的 Desktop 只采用这种呈现排列并增加换行，同时保留 alpha.1 的 ContextMeter 工具栏位置及 composer 渲染资格。它不升级 Core、不采用 alpha.2 的 ContextMeter 移位，也不改变 Session 投影或 token 记账。该 alpha.1 回移保留为历史背景。当前 alpha.2 集成保留官方 ContextMeter／dock 结构，仅增加换行和空 outlet 处理；整合后的精确源码仍须通过相同的打包几何验收。

现有有序公开 dock 已支持这种位置，因此不需要新的统计项 Slot。也不需要将原生 StatsPills 组改为 `display: contents`：保留其盒可保留其几何并避免改变可访问性分组。打包几何验收通过已发布应用打开测试拥有的持久化 Session，测量真实 InputBar、StatsPills 和已发布插件控件；合成历史与登出账户状态不代表模型推理或实时额度访问。

Renderer 稳定的公开 `[data-slot="conversation.composer.dock"]` outlet 本身使用 `display: contents`，在空、返回 null 和卸载状态下也保留。Shell 隐藏唯一的空 outlet，不会把纯文本内容或崩溃标记误当成空。几何验收一起测量有界查找得到的实体 flex 所有者及其真实控件，而不是 outlet 不存在的盒。只有缺失或暂未布局的控件可在现有期限内重置采样；错误锚点、错误所有者和歧义直接失败。

## 备选方案

- **单行变体（StatsLine，A/B 落选方）。** 全部数字常驻一行文本，悬停提示只在截断时复述整行。败在拥挤与可达性：精确 token 计数无处可看（行内和提示里都只有紧凑总量），单行也无法给时间与计费数字分组。
- **三个常驻分组共享一个弹层。** 中间迭代曾把计数、时间、token 保持为三个内联分组。双 pill 胜出是因为时间/用量的切分与两个底层投影一一对应，且每个 pill 的图标直接预告其弹层内容。
- **抽出与 `TurnUsagePanel` 共享的 dl 分桶行。** 会话总量弹层与逐轮面板皮肤相同但约定不同（会话输入、缓存读取与输出行始终存在，缓存写入行仅在非零时出现；逐轮字段可选且含模型路由）；共享组件只是给九行代码包一层条件。该镜像以 `jscpd:ignore` 标注并内联说明理由。

## 后果

- `ChatSnapshotBuilder` 的 legacy 切片现在服务于 StatsPills；[节点装配 note](../architecture/2026-08-09-client-conversation-node-assembly.zh.md) 已跟进该消费者更名。
- 精确 token 计数第一次变得可达——一次点击即可；`StatsLine` 只展示过紧凑总量。统计条本身只承载两个头条读数。
- Web e2e 对统计条的断言匹配时间 pill 内的子串文本；fresh-round-trip 的 aria golden 钉住提交操作下方的时间、计费、上下文顺序，stats-paged-history 则在无计费 token 的日志上钉住单独的计数读数。
- 生成的插槽目录中 `conversation.composer.dock` 占用者为 `client-ui-chat StatsPills id 'stats'`。
