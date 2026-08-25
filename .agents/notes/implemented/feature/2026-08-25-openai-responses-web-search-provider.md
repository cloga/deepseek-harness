# Agent Note: OpenAI Responses-compatible Web search provider

Status: implemented

English | [中文](2026-08-25-openai-responses-web-search-provider.zh.md)

## Problem

Deployments using OpenAI Responses-compatible gateways such as Copilot2api need native server-side Web search without changing the conversation adapter. The Responses API can invoke `web_search` and return structured action sources and URL citations, but the current pi-ai conversation path does not expose a complete logged lifecycle for server-tool calls or their citations.

Injecting a Responses server tool into the primary LLM request would make model-visible search input and citation state reach the model/provider outside the session events that reconstruct a turn. The session could preserve the final assistant text while losing the server search action, its request fields, and its structured citations, violating the repository rule that model-visible inputs are logged and replayable.

## Decision

`@deepseek-ai/dsh-web-search-openai-responses` is an opt-in Service Provider for the existing [`ctx.web` capability seam](../architecture/2026-06-24-web-capability-seam.md). It registers only `WebSearchProvider`; `dsh-tool-web` remains the sole model-facing Consumer, and the default bundles keep their existing provider.

Each `search()` snapshots its resolved settings before the first await, resolves the named credential for that operation, and sends one non-streaming `POST {normalized baseURL}/responses`. The fixed body carries the configured model, the query as `input`, one `{type: "web_search"}` server tool, `include: ["web_search_call.action.sources"]`, and the configured `max_output_tokens`. The base URL rejects embedded credentials, query parameters, and fragments before it can enter the durable request event. Credential-bearing requests use `redirect: "error"`, and the package exposes no arbitrary header, payload, or tool-JSON extension.

Immediately before dispatch, an Agent-initiated operation appends `web/openai-responses-search-request` with the resolved endpoint and exact secret-free body. This follows the established DeepSeek provider request-event mechanism while keeping the provider-specific wire body typed in its owning package; neither provider imports the other, and the provider-neutral Web Service Definition remains independent of Agent and session services.

The response parser validates every consumed external JSON field. When a response carries `status`, only `completed` is accepted, so incomplete, failed, cancelled, and still-running envelopes cannot expose partial output as a successful search. It accepts sources only from `web_search_call.action.sources` and `message` `output_text` annotations tagged `url_citation`, deduplicates by absolute HTTP(S) URL in first-seen order, and uses later structured entries only to fill missing titles or snippets. The final `output_text` values become `content`. Blank final text, absence of structured sources, or malformed consumed fields fails rather than falling back to URL extraction from prose.

## Alternatives considered

**Inject `web_search` into the primary pi-ai request.** Rejected because pi-ai does not currently project the Responses server-tool lifecycle and citations into durable session events. Adding the tool would make provider-visible input and model-visible citation output unreconstructable from the log.

**Extend `GenerateOptions`, `agent-loop`, or the pi-ai adapter to understand Responses server tools.** Rejected because this deployment needs a Web search backend, not a new conversation-generation contract. A coordinated primary-request design remains possible only with explicit session events, replay projection, both SDK updates, and adapter support for the complete server-tool lifecycle.

**Let the provider register its own model tool.** Rejected by the Web capability decision: provider packages register capabilities, while `dsh-tool-web` owns stable model-facing schemas, result rendering, provider selection, and `maxResults`.

**Parse URLs from generated prose.** Rejected because prose does not establish that a URL came from native search, cannot preserve provider ordering or citation metadata, and turns an absent server-tool result into false success.

**Expose arbitrary headers, request payload, or tool JSON for compatibility.** Rejected because it would allow settings to alter authentication and model-visible input outside the typed request event. Compatible services configure only credential reference, endpoint, model, and output bound.

**Replace the default DeepSeek search provider.** Rejected because the Responses backend is for deployments that explicitly select it. Provider registration and the shipped default are separate decisions; the [default-search decision](2026-07-31-web-default-search.md) remains authoritative for shipped bundles.

## Consequences

OpenAI Responses-compatible deployments gain native Web search without coupling `ctx.web` to the conversation adapter. The auxiliary request and normalized tool result are independently replayable: the provider request event preserves exact model input, while the existing `tool/call` and `tool/result` events preserve what the conversation model receives through `dsh-tool-web`.

One search incurs a separate Responses model call and native search cost. The provider cannot reduce source count before execution, so `ctx.web` applies `maxResults` only after the endpoint has returned. Dynamic credential availability is resolved at execution because `WebSearchProvider.available()` is synchronous.

The real Loader test boots a test-only `cordis.yml` through Loader and Include, then exercises namespace unwrapping, configuration, request routing, and Loader-owned disposal. Provider tests pin exact logged/wire equality and redaction, structured mapping and enrichment, strict incomplete/malformed/empty/no-source failures, HTTP and cancellation mapping, operation-local settings snapshots, per-operation credential rotation, settings namespace lifecycle, base-URL credential rejection, and a real redirect target tripwire. The existing real Web search round snapshot remains the assembled evidence for the provider-neutral Consumer contract: it boots `dsh-tool-web`, records durable `tool/call` and `tool/result`, and renders the model-visible result. This package changes only the backend producing that already-pinned result contract, so duplicating the browser snapshot with another provider would not exercise a new model-visible representation.

The scoped supersession audit retains the Web capability seam, default-search, multi-query search, and plugin-configuration notes. This provider adds one implementation without replacing their provider/Consumer ownership, shipped default, batching policy, or settings layering rationale; no active Web search note is fully superseded or low-value enough to archive.
