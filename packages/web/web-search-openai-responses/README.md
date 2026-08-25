# @deepseek-ai/dsh-web-search-openai-responses

English | [中文](README.zh.md)

An opt-in `WebSearchProvider` for OpenAI Responses-compatible services, including deployments such as Copilot2api. It sends one non-streaming `POST {baseURL}/responses` request with the native `web_search` server tool and registers only a backend on [`ctx.web`](../web/README.md); [`dsh-tool-web`](../tool-web/README.md) remains the sole owner of the model-facing `web_search` tool.

The request is auxiliary to the conversation model. This package does not modify `GenerateOptions`, inject server tools into the primary LLM request, or depend on the pi-ai adapter. The [provider decision](../../../.agents/notes/implemented/feature/2026-08-25-openai-responses-web-search-provider.md) records why the separate `ctx.web` request preserves complete request and citation logging.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal bearer token. Prefer `apiKeyEnv`; a non-empty literal wins. The settings schema marks this field secret. |
| `apiKeyEnv` | `OPENAI_API_KEY` | Credential reference resolved for every search through `ctx.credentials`, or from the launching environment when that service is absent. |
| `baseURL` | `https://api.openai.com/v1` | Absolute HTTP(S) Responses-compatible base without credentials, query parameters, or a fragment. Trailing slashes are removed before `/responses` is appended. |
| `model` | `gpt-5-mini` | Model sent in the Responses request. |
| `maxOutputTokens` | `2048` | Positive integer sent as `max_output_tokens`. |

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

The package is not mounted by a shipped bundle. A deployment must add the provider row and select `openai-responses` on `dsh-web`.

The `web-search-openai-responses` settings namespace layers user values over the composition entry. A committed endpoint, model, token bound, or credential reference reaches the next search without re-registering the provider. Each operation snapshots the complete resolved section before credential resolution, so a concurrent settings update cannot pair one section's credential with another section's endpoint or body.

## Wire request and response mapping

Each search sends `model`, the query as `input`, `tools: [{ type: "web_search" }]`, `include: ["web_search_call.action.sources"]`, `max_output_tokens`, and `stream: false`. The request carries `Authorization: Bearer <key>`, rejects redirects before following `Location`, and forwards caller cancellation to credential preflight and `fetch`.

`content` is the concatenation of validated `output_text.text` fields in provider order. Sources come only from `web_search_call.action.sources` and `message` `output_text` annotations tagged `url_citation`; prose URLs are never parsed. Sources are deduplicated by absolute HTTP(S) URL in first-seen order, and later structured entries fill a missing `title` or `snippet` without replacing earlier metadata.

The provider validates every consumed external JSON field. When the response includes `status`, only `completed` is accepted; incomplete, failed, cancelled, or still-running responses fail rather than returning partial output. Missing or blank final text, no structured source, malformed consumed fields, network failures, redirects, and non-success HTTP responses fail as `WEB_PROVIDER_ERROR`; cancellation fails as `WEB_ABORTED`, and a missing credential fails as `WEB_PROVIDER_CREDENTIAL_MISSING`. The provider returns every structured source and reports `truncated: false`; `ctx.web` owns the final `maxResults` cap.

## Request logging

Immediately before dispatch, an Agent-initiated search appends `web/openai-responses-search-request` to that Agent's session. The event contains the normalized endpoint and the exact JSON body sent on the wire; it contains no headers or credential. A logging failure prevents dispatch, while an HTTP or response failure after dispatch leaves the attempted request durable.

## Model Experience

### Auxiliary Responses search request

#### What the model sees

The configured auxiliary model receives the search query as Responses `input`, one native `web_search` tool declaration, and the request for structured action sources. This request is separate from the conversation model's context.

#### Token effect

Every search incurs separate provider input, search, and output usage; `maxOutputTokens` limits generated output.

#### KV Cache effect

Independent of the conversation request cache. Stable request fields can form a reusable provider prefix, while the query changes the request from `input`.

### Conversation tool result, indirectly

#### What the model sees

When composed with [`dsh-tool-web`](../tool-web/README.md), the conversation model receives the provider's final text plus the structured URLs, titles, and snippets after `ctx.web` applies its source bound. Provider diagnostics are returned through the consumer's existing tool-error projection.

#### Token effect

Registration adds no conversation tokens. Tool-result tokens scale with final text and the capped source list.

#### KV Cache effect

Append-only; the tool result follows the reusable conversation prefix.

## Known Limitations and Deferred Work

- **Compatibility is intentionally narrow** — the endpoint must implement the non-streaming OpenAI Responses request and the consumed `status` and `output` fields; arbitrary headers, payload extensions, and tool JSON are not configurable.
- **Dynamic credential availability is asynchronous** — `available()` can prove that a resolver exists but cannot inspect it, so a selected provider with no resolved key fails at execution.
- **Provider-side result count is not controlled** — Responses web search exposes sources after execution, so over-returned sources can consume auxiliary tokens before `ctx.web` applies `maxResults`.
