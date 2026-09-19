# Agent Note: Explicit New Session creates a fresh identity

Status: implemented

English | [中文](2026-09-19-explicit-new-session-fresh-identity.zh.md)

## Problem

A blank Session summary describes conversation content, not permission to resume that Session. Reusing a blank held by another process makes New Session repeatedly select the same unavailable identity. Selection can precede an asynchronous resume failure, so a synchronous selection result cannot establish that reuse is safe. A Creator preset staged for whichever blank becomes current can also affect an older or unrelated Session.

## Decision

`ui-workspace.startSession` creates a fresh Session through the Session Controller instead of searching existing blanks. Concurrent starts share only pending creation with the same complete Workspace and creation-time preset intent. Ordinary Workspace reuse has separate pending work. Settlement releases each attempt on success or failure. The request returns its new id only while its exact committed `mainView` reference remains current; later navigation or owner disposal suppresses that result and the late UI commit. Suppressing selection does not cancel Host creation.

Creator supplies `agentPreset: 'cordis'` through Client creation to the Host's existing create-time preset field. Its cue is visual only: neither a shared preset stage nor a post-creation select applies Creator to an old or unrelated blank. The Creator action reports success only after the exact fresh main binding and Host-reported preset still match. Settings closes only for that successful request in the same section lifetime. Creator discards an unbound chip stage before awaiting creation; ordinary bound chip selection and explicit Settings default synchronization remain addressed to their captured Session.

With no target Workspace, New Session preserves `clearMain` and creates nothing. Creator leaves Settings open and displays localized guidance beside its button: choose a Workspace, then invoke Creator again. The action queues no deferred Creator intent and does not infer a missing Workspace from a late superseded result.

`openWorkspace` and `connectWorkspace` retain blank reuse for initial selection and composer Workspace switching. The [Workspace README](../../../../packages/client/ui-workspace/README.md) owns the consumer behavior. This decision partially supersedes the New Session reuse policy in [Session scope and provisioning](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md), not its scope or provisioning decisions. [Client ownership layers](../architecture/2026-08-20-client-session-conversation-ownership.md) still places this navigation policy in `ui-workspace`; `SessionReference`, `mainView`, and direct-subagent ownership remain intact.

## Official-first comparison

Official `0.1.6-alpha.2` routes `startSession` through `openWorkspace` and `connectWorkspace` in [Workspace navigation](../../../../packages/client/ui-workspace/src/client/navigation.ts), so it lacks a separate explicit fresh-identity operation. Its [Host creation handler](../../../../packages/api/session-controller/src/commands.ts) already accepts `agentPreset`; the retained adaptation forwards that existing field through the Client rather than adding a Host creation protocol. The official reference-owned navigation remains the basis of selection and lifetime handling.

Retain the adaptation until an official implementation supplies equivalent fresh identity, retained-reference ownership, and creation-bound Creator selection. Ordinary reuse, Host writer exclusion, and unrelated Session recovery are not replacement criteria for this narrowly scoped behavior.

## Alternatives considered

**Keep New Session on the reuse path.** Blank status does not establish writer availability, so repeated clicks can return the same occupied identity instead of providing a new conversation.

**Remove blank reuse from all Workspace selection.** Initial selection and composer switching still need their ordinary reuse behavior; changing those operations broadens the fix beyond explicit creation.

**Stage Creator for the next blank or defer it until a Workspace appears.** Either approach separates the preset intent from the creation it authorizes and can apply it after unrelated navigation. Creation-time binding avoids that ambiguity without changing ordinary chip behavior.

## Consequences

New Session provides an independent identity without taking ownership from another process. Sequential creation can leave multiple blank Sessions in one Workspace; the sidebar still displays only the selected blank. Coalescing is local to one UI service and does not coordinate browser tabs or processes. Session locks, resume rules, and API error types remain unchanged; ordinary Workspace reuse can still select an unavailable Session. This change neither recovers an occupied Session nor takes over its writer.

## Verification

The [navigation tests](../../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) own fresh creation versus ordinary reuse, complete-intent coalescing, settlement and retry, superseding navigation, and disposal. The [preset UI tests](../../../../packages/client/ui-agent-preset/tests) own creation-bound Creator selection and unchanged chip behavior. The [assembled Web regression](../../../../apps/web/tests/workspace-new-session-folding.e2e.ts) owns browser evidence for New Session beside an occupied blank and the unchanged provisional-row quota. These coverage responsibilities do not assert that a particular source revision has passed tests or release qualification.

[Assembled input fixtures](../../../../apps/web/tests/assembled-boot.ts) wait for a different selected Session and its replacement editable composer before interacting. A matching composer can still belong to the preceding Session while creation is pending.
