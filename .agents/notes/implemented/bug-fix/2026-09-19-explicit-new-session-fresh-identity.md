# Agent Note: Explicit New Session creates a fresh identity

Status: implemented

English | [中文](2026-09-19-explicit-new-session-fresh-identity.zh.md)

## Problem

A blank Session summary describes conversation content, not permission to resume that Session. Reusing a blank held by another process makes New Session repeatedly select the same unavailable identity. Selection can precede an asynchronous resume failure, so a synchronous selection result cannot establish that reuse is safe.

## Decision

`ui-workspace.startSession` creates a fresh Session through the Session Controller instead of searching existing blanks. Concurrent starts for the same Workspace share only the pending creation; settlement releases that attempt on success or failure. Each request retains the existing latest-navigation and owner-lifetime checks, so a late result cannot replace a newer navigation or reopen the UI after disposal. Suppressing selection does not cancel Host creation.

`openWorkspace` and `connectWorkspace` retain blank reuse for initial selection and composer Workspace switching. The [Workspace README](../../../../packages/client/ui-workspace/README.md) owns the consumer behavior. This decision partially supersedes the New Session reuse policy in [Session scope and provisioning](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md), not its scope or provisioning decisions. [Client ownership layers](../architecture/2026-08-20-client-session-conversation-ownership.md) still places this navigation policy in `ui-workspace`.

## Alternatives considered

**Keep New Session on the reuse path.** Blank status does not establish writer availability, so repeated clicks can return the same occupied identity instead of providing a new conversation.

**Remove blank reuse from all Workspace selection.** Initial selection and composer switching still need their ordinary reuse behavior; changing those operations broadens the fix beyond explicit creation.

## Consequences

New Session provides an independent identity without taking ownership from another process. Sequential creation can leave multiple blank Sessions in one Workspace; the sidebar still displays only the selected blank. Coalescing is local to one UI service and does not coordinate browser tabs or processes. Session locks, resume rules, and API error types remain unchanged; ordinary Workspace reuse can still select an unavailable Session.

## Verification

The [navigation tests](../../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) distinguish fresh creation from ordinary reuse and cover overlapping starts, settlement and retry, superseding navigation, and disposal. The [assembled Web regression](../../../../apps/web/tests/workspace-new-session-folding.e2e.ts) owns browser evidence for New Session beside an occupied blank and the unchanged provisional-row quota. Neither client-only evidence nor this navigation change establishes recovery of the occupied Session itself.

[Assembled input fixtures](../../../../apps/web/tests/assembled-boot.ts) wait for a different selected Session and its replacement editable composer before interacting. A matching composer can still belong to the preceding Session while creation is pending.
