---
description: "Web GUI 的模型选择：/model 弹窗与 composer 模型位共用一份按提供方分组的会话级目录；供模型路由的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

[English](README.md) | 中文

## 概述

通过 `/model` 或 composer 模型控件，可以为既有普通 Session 选择具体模型与推理（reasoning）强度，或选择 Auto 模式。两个入口共享 Host 自有的选择状态。在 Auto 下，composer 区分所选模式与最后实际模型及强度，不会根据目录预测下一条路由。运行中的步骤保留已组装的选择；已寻址的 subagent Session 不公开这两个控件。

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

与 `ui-conversation` 及命令包一起挂载本插件；composer 显示模型位，`/model` 则以弹窗打开同一份共享目录。Host 提供提供方分组和持久选择状态。目录名称改善展示，但目录行缺失不会抹去已知的具体选择：composer 可以改为显示提供方／模型 id。

### 模型与推理强度

模型按提供方分组。`/model` 弹窗显示提供方名称与目录说明；其中两个内置 DeepSeek 模型的说明使用当前语言，外部说明保持原文。手动选择使用确切模型公布的强度词汇和 Host 校验，而非浏览器自有的全局强度枚举。composer 不支持任意强度输入；适配器没有推理元数据时不显示 Effort 行。

### Auto 意图与实际使用

当 Host 报告可以接受新选择时，Auto 提供 `efficiency`、`balanced` 和 `intelligence` 模式。弹窗省略不可用的 Auto 选项；composer 的 Auto 面板说明不可用状态并禁用这些选项。就绪状态后来变为 false 时，已有的捕获 Auto 模式仍保持可见。[Host 路由所有者](../../llm/model-routing/README.zh.md)决定任务边界和模型／强度策略；两个浏览器入口都不运行分类器或给候选排序。

composer 把 Auto 模式标签与 `modelRouting.lastDecision` 或 `modelSelection.lastUsed` 提供的最后实际路由分开展示。尚无实际路由时，它显示待定提示，而不是部署默认值。在 Auto 下，缺失的实际强度保持缺失，不会由目录默认值补齐。Effort 控件由 Auto 管理；选择具体模型会固定手动意图并退出 Auto，即使提供方／模型对未变也是如此。重新选择 Auto 会捕获 Host 当前配置，而不是原地修改已经捕获的策略。

### 不可路由的会话

手动选择时，Host 明确报告没有适配器服务所选提供方，才会触发 composer 阻塞块；恢复后无需重新加载即清除。目录读取处于加载中或失败时保持未知，而不是阻塞；单个模型行缺失也不构成拒绝。Auto 活动时，旧提供方或默认提供方不能触发这项手动路由阻塞：Host 在工作开始时解析资格，仍可能拒绝不可用路由。未来 Auto 选择的就绪状态，并不保证某次请求一定可用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`ModelDirectoryResolver`（`ctx.modelDirectories`）基于共享的 Host 代次 `session.modelCatalog()` 结果，为每个 Session 持有一份目录。`/model` popupSelect 贡献项和 `conversation.input.model` 位通过同一份目录提交 `session.selectModel` 或 `session.selectAutoModel`。持久 `modelSelection` 和 `modelRouting` 投影提供已接受意图与实际使用；成功的 RPC 响应不会被用来虚构具体的 Auto 选择。渲染器把注入的 `hooks.directory` 源绑定为 `useDirectory`；组件不直接使用 `useSyncExternalStore` 订阅，也不接收服务属性。

选择代次防止陈旧响应替换较新的操作状态。提供方、设置和凭据失效信号会刷新共享目录；连接重置使旧的进行中工作失效，并刷新 Host 代次，Session 投影则通过其所属模型重连。刷新期间可以保留最后已知的展示数据，并单独报告加载或失败状态。每个 Session 的订阅和 composer 阻塞块随其作用域一起撤销。已寻址的 subagent Session 不公开这两个选择入口。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当仅了解模型界面还不够时，请阅读以下页面。这些页面从浏览器界面逐步深入到命令弹窗外壳与选择约定。

- [ui-commands](../ui-commands/README.zh.md)——`/model` 贡献项注册进的 popupSelect 外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 composer 的 `conversation.input.model` 位与 composer 阻塞块。
- [dsh-agent-default-model](../../core/agent-default-model/README.zh.md)——为从未选择的会话提供默认模型的默认模型服务。
- [模型路由](../../llm/model-routing/README.zh.md)——Host 自有的任务策略、分类器成本和实际使用决策。
- [插件设置](../ui-settings-plugins/README.zh.md)——暂存的 Auto 候选和分类器配置。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过两个入口提交的 `session.selectModel` 和 `session.selectAutoModel` 意图产生影响：Host 负责下一次提示词组装边界的解析及任何模型可见效果，运行中的步骤则保留已组装的选择。浏览器不添加分类器请求、对话消息或面向模型的 schema。

#### KV Cache 影响

修改 UI 意图本身不会重写提示词或发送提供方请求。Host 解析出的模型或强度变化可能减少后续工作的缓存复用；任务亲和性和路由切换通知由 Host 路由及 Agent 包负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前模型选择界面。它们是当前包约束，不是通用模型路由器对比或任务积压。

- **无创建期或已寻址 subagent 选择**——两个入口都要求既有普通会话的 agent（智能体）；没有可纳入会话创建的草稿阶段模型选择，subagent 继续执行也有意不公开独立的模型选择约定。
- **目录名仅供呈现**——选择与持久化使用提供方／模型／推理强度 id；目录查询或确切模型元数据查询失败的提供方以不可选失败行列出，重新加载前保持原样。
- **不能任意输入推理强度**——composer 仅提供确切模型由适配器公布的推理强度；适配器没有推理元数据时不显示 Effort 行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 command contribution，HMR（热模块替换）安全性测试证明该注册的 dispose 能正确完成；它不发出 Cordis 事件，也不持有跨插件可变状态。
