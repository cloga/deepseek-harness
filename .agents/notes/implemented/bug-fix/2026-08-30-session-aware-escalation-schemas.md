# Agent Note: Session-aware sandbox escalation schemas

Status: implemented

English | [中文](2026-08-30-session-aware-escalation-schemas.zh.md)

## Problem

Sandbox-capable tools registered one process-wide escalation schema even though the effective sandbox mode and approval policy belong to each session. A `danger-full-access` or approval-disabled request therefore still advertised `sandbox_permissions` and `justification`. Some tool-call clients require every advertised property, so an ordinary command had to carry escalation metadata that could not request wider access.

## Decision

`ToolDefinition.projectModelSchema(agent)` lets a registered tool project its model-facing description and parameters for one request. `defineTool.modelSchema` compiles that projection through the same parameter-schema DSL. Execution validation remains bound to the complete static registration, so omitted model fields do not weaken injected-call checks.

The bash, pwsh, write, and edit tools resolve the receiving agent's sandbox mode and approval policy during request assembly. Approval policy `ask` exposes only `WIDER_MODES[effectiveMode]`; `danger-full-access`, policy `never`, a missing approval service, or a non-confining provider exposes no escalation fields or retry hint. Diagnostics without an agent retain the complete registered schema.

Recorded-session manifests assign distinct header classes to schemas with two escalation targets, only `danger-full-access`, or no escalation fields. One pin owns each class's readable schema sidecar, so replay checks the exact model input without duplicating it in every scenario.

This decision supersedes only the process-wide escalation-advertisement clauses in [the subprocess sandbox decision](../feature/2026-07-06-sandbox.md) and [the cross-family filesystem sandbox decision](../feature/2026-07-14-cross-family-fs-sandbox.md). Those notes continue to own enforcement, approval ordering, denial semantics, and capability-specific confinement.

## Alternatives considered

**Hide fields from every `danger-full-access` deployment at registration.** Rejected because a session can switch to `read-only` or `workspace-write` while the process default remains unrestricted.

**Let each tool mutate its registered definition on policy changes.** Rejected because concurrent sessions need different schemas at the same time; request assembly already has the exact receiving agent.

## Consequences

Model schemas and denial hints expose only retries the current session can request. Native and PTC presentations use the same per-agent projection. Static diagnostics retain the complete mode vocabulary. Direct or injected equal and narrower requests keep the standing policy without approval or downgrade; wider requests retain strict validation and approval.
