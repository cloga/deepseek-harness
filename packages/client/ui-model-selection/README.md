---
description: "Model selection for the Web GUI: the /model popup and the composer model seat over one per-session provider-grouped directory; for users and maintainers of model routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

English | [中文](README.zh.md)

## Summary

Choose a concrete model and reasoning effort or an Auto mode for an existing ordinary Session through `/model` or the composer's model control. Both entries share Host-owned selection state. Under Auto, the composer distinguishes the chosen mode from the last actual model and effort; it does not predict the next route from the catalog. A running step keeps its assembled selection, and addressed subagent Sessions expose neither control.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-conversation` and the commands package; the composer shows the model seat, and `/model` opens the same shared directory as a popup. The Host supplies provider groups and durable selection state. Catalog names improve display, but a missing row does not erase a known concrete selection: the composer can show its provider/model ids instead.

### Model and effort

Models stay grouped by provider. The `/model` popup shows provider names and catalog descriptions; it localizes the two built-in DeepSeek descriptions and leaves external descriptions verbatim. Manual choices use the exact model's advertised effort vocabulary and Host validation, not a browser-owned global effort enum. The composer has no arbitrary effort input; an adapter without reasoning metadata leaves the Effort row absent.

### Auto intent and actual use

Auto offers `efficiency`, `balanced`, and `intelligence` when the Host reports readiness for a new selection. The popup omits unavailable Auto choices; the composer's Auto pane explains unavailability and disables those choices. An existing captured Auto mode remains visible when readiness later becomes false. The [Host routing owner](../../llm/model-routing/README.md) decides task boundaries and model/effort policy; neither browser entry runs a classifier or ranks candidates.

The composer labels the Auto mode separately from the last actual route supplied by `modelRouting.lastDecision` or `modelSelection.lastUsed`. Before any actual route exists, it shows a pending indication instead of the deployment default. Under Auto, an absent actual effort remains absent: catalog defaults do not fill it in. The Effort control is managed by Auto; selecting a concrete model pins manual intent and exits Auto even when that provider/model pair is unchanged. Reselecting Auto captures the Host's current configuration rather than modifying an already captured policy in place.

### Unroutable sessions

For manual selection, a definite Host report that no adapter serves the selected provider raises a composer block; recovery clears it without a reload. Loading or failed catalog reads remain unknown rather than blocking, and a missing model row alone is not a refusal. While Auto is active, an old or default provider cannot trigger this manual-route block: the Host resolves eligibility when work starts and may still reject unavailable routes. Readiness for future Auto selections is not an availability guarantee for a particular request.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`ModelDirectoryResolver` (`ctx.modelDirectories`) owns one directory per Session over a shared Host-generation `session.modelCatalog()` result. The `/model` popupSelect contribution and `conversation.input.model` seat submit `session.selectModel` or `session.selectAutoModel` through that same directory. Durable `modelSelection` and `modelRouting` projections supply accepted intent and actual use; a successful RPC response is not used to invent a concrete Auto selection. The renderer binds the injected `hooks.directory` source as `useDirectory`; the component has no direct `useSyncExternalStore` subscription or service prop.

Selection generations prevent stale responses from replacing newer operation state. Provider, settings, and credential invalidations refresh the shared catalog; connection reset invalidates old in-flight work and refreshes the Host generation while Session projections reconnect through their owning model. Last-known display data can remain visible during refresh, with loading or failure reported separately. Per-Session subscriptions and composer blocks leave with that Session's scope. Addressed subagent Sessions expose neither selection entry.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the model surface is not enough. They move from the browser surfaces to the command popup shell and the selection contract.

- [ui-commands](../ui-commands/README.md) — the popupSelect shell the `/model` contribution registers into.
- [ui-conversation](../ui-conversation/README.md) — declares the composer's `conversation.input.model` seat and the composer block.
- [dsh-agent-default-model](../../core/agent-default-model/README.md) — the default-model service for sessions that never choose.
- [Model routing](../../llm/model-routing/README.md) — Host-owned task policy, classifier costs, and actual-use decisions.
- [Plugin settings](../ui-settings-plugins/README.md) — staged Auto candidate and classifier configuration.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `session.selectModel` and `session.selectAutoModel` intents both entries submit: the Host owns resolution at the next prompt-assembly boundary and any model-visible effect, while a running step keeps its assembled selection. The browser adds no classifier request, conversation message, or model-facing schema.

#### KV Cache effect

Changing UI intent does not itself rewrite a prompt or send a provider request. A Host-resolved model or effort change can reduce cache reuse on later work; the Host routing and Agent packages own task affinity and route-change notices.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current model surface. They are current package constraints, not a general model-router comparison or a task backlog.

- **No create-time or addressed-subagent selection** — both entries require an existing ordinary session's Agent; there is no draft-phase model choice to fold into session creation, and subagent continuation deliberately exposes no independent model-selection contract.
- **Directory names are presentation-only** — selection and persistence use provider/model/effort ids; a provider whose catalog or exact-model metadata lookup fails lists as an unselectable failure row until reload.
- **No arbitrary effort input** — the composer offers only the exact model's adapter-advertised levels; an adapter without reasoning metadata leaves the Effort row absent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The plugin registers a single command contribution, and the HMR-safety spec proves that the registration is disposed correctly. The plugin emits no Cordis events and owns no cross-plugin mutable state.
