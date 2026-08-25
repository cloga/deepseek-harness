# @deepseek-ai/dsh-web-search-openai-responses

[English](README.md) | 中文

这是一个可选启用的 `WebSearchProvider`，适用于 OpenAI Responses 兼容服务，包括 Copilot2api 等部署。它使用原生 `web_search` 服务器工具发送一次非流式 `POST {baseURL}/responses` 请求，并且只向 [`ctx.web`](../web/README.zh.md) 注册后端；面向模型的 `web_search` 工具仍仅由 [`dsh-tool-web`](../tool-web/README.zh.md) 拥有。

该请求独立于对话模型。此包不修改 `GenerateOptions`，不向主 LLM（大语言模型）请求注入服务器工具，也不依赖 pi-ai 适配器。[提供方决策](../../../.agents/notes/implemented/feature/2026-08-25-openai-responses-web-search-provider.zh.md)说明了独立 `ctx.web` 请求为何能保留完整的请求与引用日志。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 省略 | 字面 bearer 令牌。应优先使用 `apiKeyEnv`；非空字面值优先。设置 schema 将此字段标记为密钥。 |
| `apiKeyEnv` | `OPENAI_API_KEY` | 每次搜索都通过 `ctx.credentials` 解析的凭据引用；未挂载该服务时从启动环境解析。 |
| `baseURL` | `https://api.openai.com/v1` | 不含凭据、查询参数或片段的绝对 HTTP(S) Responses 兼容基址。追加 `/responses` 前会移除末尾斜杠。 |
| `model` | `gpt-5-mini` | Responses 请求使用的模型。 |
| `maxOutputTokens` | `2048` | 作为 `max_output_tokens` 发送的正整数。 |

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: openai-responses

- id: web-search-openai-responses
  name: '@deepseek-ai/dsh-web-search-openai-responses'
  config:
    apiKeyEnv: COPILOT2API_KEY
    baseURL: https://copilot2api.example/v1
    model: gpt-5-mini
    maxOutputTokens: 2048
```

已发布 bundle 不挂载此包。部署必须添加提供方条目，并在 `dsh-web` 上选择 `openai-responses`。

`web-search-openai-responses` 设置命名空间将用户值叠加在组合条目上。提交后的端点、模型、令牌上限或凭据引用会在下一次搜索生效，而无需重新注册提供方。每次操作都在解析凭据之前快照完整的已解析设置，因此并发设置更新不会把一个设置版本的凭据与另一个版本的端点或请求体配对。

## 线路请求与响应映射

每次搜索发送 `model`、作为 `input` 的查询、`tools: [{ type: "web_search" }]`、`include: ["web_search_call.action.sources"]`、`max_output_tokens` 和 `stream: false`。请求携带 `Authorization: Bearer <key>`，在跟随 `Location` 前拒绝重定向，并将调用方取消传给凭据预检和 `fetch`。

`content` 按提供方顺序拼接经过校验的 `output_text.text` 字段。来源仅取自 `web_search_call.action.sources`，以及 `message` 中标记为 `url_citation` 的 `output_text` annotation（注解）；绝不解析正文中的 URL。来源按首次出现的绝对 HTTP(S) URL 保序去重；后续结构化条目可以补充缺失的 `title` 或 `snippet`，但不会覆盖较早的元数据。

提供方会校验其消费的每个外部 JSON 字段。响应包含 `status` 时只接受 `completed`；不完整、失败、已取消或仍在运行的响应会失败，而不会返回部分输出。最终文本缺失或为空、没有结构化来源、消费字段格式错误、网络失败、重定向和非成功 HTTP 响应都会以 `WEB_PROVIDER_ERROR` 失败；取消以 `WEB_ABORTED` 失败，凭据缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。提供方返回全部结构化来源并报告 `truncated: false`；最终 `maxResults` 上限由 `ctx.web` 拥有。

## 请求日志

由 Agent（智能体）发起的搜索会在分发前向该 Agent 会话追加 `web/openai-responses-search-request`。事件包含规范化端点和线路上发送的精确 JSON 请求体，不包含标头或凭据。日志写入失败会阻止分发；分发后的 HTTP 或响应失败仍会留下持久请求记录。

## 模型体验

### 辅助 Responses 搜索请求

#### 模型看到什么

配置的辅助模型会收到作为 Responses `input` 的搜索查询、一个原生 `web_search` 工具声明，以及结构化 action（操作）来源请求。该请求与对话模型上下文分离。

#### Token 影响

每次搜索都会产生独立的提供方输入、搜索和输出用量；`maxOutputTokens` 限制生成输出。

#### KV Cache 影响

它独立于对话请求缓存。稳定请求字段可以形成可复用的提供方前缀，而查询会从 `input` 起改变请求。

### 间接对话工具结果

#### 模型看到什么

与 [`dsh-tool-web`](../tool-web/README.zh.md) 组合后，对话模型会收到提供方最终文本，以及 `ctx.web` 应用来源上限后的结构化 URL、标题和摘要。提供方诊断通过消费方现有的工具错误投影返回。

#### Token 影响

注册不会增加对话 token。工具结果 token 随最终文本和受限来源列表增长。

#### KV Cache 影响

仅追加；工具结果位于可复用对话前缀之后。

## 已知限制与延后工作

- **兼容范围有意保持狭窄**——端点必须实现非流式 OpenAI Responses 请求以及此包消费的 `status` 和 `output` 字段；不能配置任意标头、payload（载荷）扩展或工具 JSON。
- **动态凭据可用性是异步的**——`available()` 可以确认解析器存在，但不能检查解析结果，因此已选择但无法解析密钥的提供方会在执行时失败。
- **无法控制提供方侧结果数量**——Responses Web 搜索在执行后才公开来源，因此过量来源可能已消耗辅助 token，随后 `ctx.web` 才应用 `maxResults`。
