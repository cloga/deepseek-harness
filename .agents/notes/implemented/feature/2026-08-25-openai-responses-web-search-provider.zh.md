# Agent Note: OpenAI Responses 兼容 Web 搜索提供方

Status: implemented

[English](2026-08-25-openai-responses-web-search-provider.md) | 中文

## 问题

使用 OpenAI Responses 兼容网关（例如 Copilot2api）的部署需要原生服务器侧 Web 搜索，同时不改变对话适配器。Responses API 可以调用 `web_search`，并返回结构化操作来源和 URL 引用，但当前 pi-ai 对话路径没有公开服务器工具调用及其引用的完整日志化生命周期。

向主 LLM（大语言模型）请求注入 Responses 服务器工具，会让模型可见的搜索输入和引用状态在用于重建轮次的会话事件之外到达模型或提供方。会话可能保留最终助手文本，却丢失服务器搜索操作、请求字段和结构化引用，从而违反模型可见输入必须可记录并可回放的仓库规则。

## 决策

`@deepseek-ai/dsh-web-search-openai-responses` 是现有 [`ctx.web` 能力 seam](../architecture/2026-06-24-web-capability-seam.zh.md)的可选 Service Provider（服务提供方）。它只注册 `WebSearchProvider`；`dsh-tool-web` 仍是唯一面向模型的 Consumer（消费方），默认 bundle 继续使用现有提供方。

每次 `search()` 都在第一个 await 前快照已解析设置，为该次操作解析指定凭据，并发送一次非流式 `POST {规范化 baseURL}/responses`。固定请求体包含配置的模型、作为 `input` 的查询、一个 `{type: "web_search"}` 服务器工具、`include: ["web_search_call.action.sources"]` 和配置的 `max_output_tokens`。基地址在进入持久请求事件前会拒绝内嵌凭据、查询参数和片段。携带凭据的请求使用 `redirect: "error"`，且此包不公开任意标头、payload（载荷）或工具 JSON 扩展。

由 Agent（智能体）发起的操作会在分发前追加 `web/openai-responses-search-request`，其中包含已解析端点和精确且不含密钥的请求体。它沿用已建立的 DeepSeek 提供方请求事件机制，同时将提供方专属线路请求体的类型留在所属包中；两个提供方互不导入，且与提供方无关的 Web Service Definition（服务定义）继续独立于 Agent 和会话服务。

响应解析器校验每个被消费的外部 JSON 字段。响应携带 `status` 时只接受 `completed`，因此不完整、失败、已取消和仍在运行的响应不会把部分输出暴露为成功搜索。它只接受 `web_search_call.action.sources`，以及 `message` 中标记为 `url_citation` 的 `output_text` annotation（注解）作为来源；按首次出现的绝对 HTTP(S) URL 保序去重，并且后续结构化条目只能补充缺失的标题或摘要。最终 `output_text` 值成为 `content`。最终文本为空、没有结构化来源或消费字段格式错误都会失败，不会降级为从正文提取 URL。

## 考虑过的替代方案

**向主 pi-ai 请求注入 `web_search`。** 拒绝，因为 pi-ai 当前不会把 Responses 服务器工具生命周期和引用投影为持久会话事件。添加该工具会使提供方可见输入和模型可见引用无法从日志重建。

**扩展 `GenerateOptions`、`agent-loop` 或 pi-ai 适配器以理解 Responses 服务器工具。** 拒绝，因为该部署需要 Web 搜索后端，而不是新的对话生成 contract（契约）。只有在同时具备明确会话事件、回放投影、两个 SDK 更新，以及适配器对完整服务器工具生命周期的支持时，才能设计协调后的主请求方案。

**让提供方注册自己的模型工具。** Web 能力决策不允许这样做：提供方包注册能力，而 `dsh-tool-web` 拥有稳定的面向模型 schema、结果渲染、提供方选择和 `maxResults`。

**从生成正文解析 URL。** 拒绝，因为正文无法证明 URL 来自原生搜索，不能保留提供方顺序或引用元数据，并且会把缺失服务器工具结果变成伪成功。

**为兼容性公开任意标头、请求 payload 或工具 JSON。** 拒绝，因为这会允许设置改变 typed request event（类型化请求事件）之外的身份验证和模型可见输入。兼容服务只配置凭据引用、端点、模型和输出上限。

**替换默认 DeepSeek 搜索提供方。** 拒绝，因为 Responses 后端供显式选择它的部署使用。提供方注册与已发布默认值是独立决策；[默认搜索决策](2026-07-31-web-default-search.zh.md)仍然是已发布 bundle 的权威说明。

## 后果

OpenAI Responses 兼容部署获得原生 Web 搜索，而无需把 `ctx.web` 与对话适配器耦合。辅助请求和规范化工具结果可独立回放：提供方请求事件保留精确模型输入，现有 `tool/call` 和 `tool/result` 事件则保留对话模型通过 `dsh-tool-web` 收到的内容。

每次搜索都会产生独立 Responses 模型调用和原生搜索成本。提供方无法在执行前减少来源数量，因此只有在端点返回后，`ctx.web` 才应用 `maxResults`。由于 `WebSearchProvider.available()` 是同步的，动态凭据可用性在执行时解析。

真实 Loader 测试通过 Loader 和 Include 启动测试专用 `cordis.yml`，再覆盖命名空间解包、配置、请求路由和 Loader 所有的释放。提供方测试固定日志与线路请求的精确相等和脱敏、结构化映射和补充、严格的不完整/格式错误/空文本/无来源失败、HTTP 与取消映射、操作局部设置快照、逐操作凭据轮换、设置命名空间生命周期、基地址凭据拒绝，以及真实重定向目标 tripwire（触发线）。现有真实 Web 搜索轮次快照仍是与提供方无关的 Consumer contract 组装证据：它启动 `dsh-tool-web`，记录持久 `tool/call` 和 `tool/result`，并渲染模型可见结果。此包只改变生成已固定结果 contract 的后端，因此再用另一个提供方复制浏览器快照不会覆盖新的模型可见表示。

范围内的取代审计保留 Web 能力 seam、默认搜索、多查询搜索和插件配置说明。此提供方只新增一种实现，不会替换其中的提供方/Consumer 所有权、已发布默认值、批处理策略或设置分层依据；没有任何活跃 Web 搜索说明被完全取代，也没有低价值到应归档的说明。
