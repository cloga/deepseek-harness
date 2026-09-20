# Agent Note: Creation-time subagent model rules

Status: implemented

English | [中文](2026-09-19-subagent-model-rules.zh.md)

## Problem

A user may want an interactive parent model to delegate implementation to another model without changing the parent Session's selection or granting the model arbitrary child-route choices. Per-tool fixed defaults cannot express exceptions keyed by the direct parent's effective route. A second planner/executor workflow adds unrelated model locks and tool restrictions.

Native child creation also records information that later restores the child. Selecting another route after publication can leave its descriptor and first request inconsistent. Resolving the same parent again after asynchronous validation can inherit an effort from a different parent selection.

## Decision

The Host-owned `subagent.modelRules` setting supplies exact parent/child provider-model pairs. Empty rules preserve inheritance. The native runtime applies one matching rule only to a new model-configurable child that otherwise inherits its parent. Caller-supplied provider, model or reasoning effort, and provider-owned route defaults, remain authoritative. External products without configurable Host Agent options keep their own model control.

Rules are user-owned defaults, not permission for model-authored route selection. The existing Session authorization continues to reject disabled, malformed or disallowed explicit choices before creation. An effort-only choice retains its authorized route instead of applying that effort to a rule-selected model.

The runtime captures the rule and complete effective options before asynchronous target validation. Matched targets use native exact-model resolution; unavailable targets, cancellation and provider changes reject creation rather than selecting a fallback. In-process one-shot providers receive the captured options and detached delegated permissions without another parent read. Capturing sandbox and approval policy before model preflight prevents a later parent permission change from affecting a child already being requested. Continuable creation records the selected route in its existing descriptor; later messages and cold resume do not reapply current rules.

User-authored rules also apply to compatible fork providers. This is distinct from the model-facing fork-selection restriction in [model-selected subagent routes](2026-08-18-model-selected-subagent-routes.md): the user chooses the default, while the model does not gain new route-selection authority. The settings explain that changing a fork child's model can lose inherited-prefix KV Cache reuse and require history reprocessing; lower cost is not guaranteed.

The native settings card edits rules and delegation limits through one revision-checked mutation of their shared namespace. Model-selection permissions retain their separate namespace. The UI identifies saved settings without claiming that a child has already used them; child request records remain the evidence of actual selection.

## Alternatives considered

**Fix the parent model in a dedicated workflow.** Rejected because the requested decision concerns child defaults, not planning roles or restrictions on the main conversation.

**Rewrite native tool arguments or replace delegation tools.** Rejected because changing the model-facing invocation is unnecessary and can separate permission checks and logged arguments from the operation that creates the child. Service-owned defaults cover native consumers without replacing their tools.

**Change a published child's model.** Rejected because creation descriptors and first-request routing must agree, and changing current settings must not rewrite existing children.

**Treat every backend as inheriting the Host model.** Rejected because external products and provider-owned route defaults have their own model authority. A global rule must not disable ordinary delegation to those backends.

## Consequences

The parent Session remains unchanged, and configured rules affect future creations rather than existing children. A matched unavailable target fails visibly instead of silently inheriting. A concurrent adapter-topology change conservatively rejects that preflight, including changes to unrelated adapters; the caller may retry after the catalog settles. No automatic retry creates another child.

Verification covers native tool authorization, exact direct-parent matching, captured options across settings and parent changes, actual spawn/fork requests, descriptor and cold-resume consistency, unchanged external providers, and atomic settings writes. The SDK recorded-session scenario compares parent and child request records rather than relying on assistant text to identify the chosen model.
