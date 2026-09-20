# Agent Note: Open Desktop web links through the system browser

Status: implemented

English | [中文](2026-09-20-desktop-external-links.zh.md)

## Problem

Denying every popup and cancelling every external navigation protects the owned application document but leaves ordinary web links without a destination. Changing one provider's anchor target cannot repair a shell that rejects both opening paths. The maintained shell also owns recovery actions that must remain separate from ordinary external navigation.

## Decision

[Window navigation](../../../../apps/desktop/src/window-navigation.ts) owns one policy for the product and plugin windows. It follows the official Desktop behavior of handing HTTP and HTTPS destinations to the system browser while rejecting Electron popup creation. Both popup requests and same-window navigation parse the destination first and dispatch its canonical URL. Malformed input and other external schemes remain blocked; no shell command or new renderer IPC is introduced.

Internal `dsh-app:` navigation stays in the application. `dsh-recovery:` navigation is prevented and delegated only to the existing recovery owner, which retains document identity, action, permission, and in-flight checks. Popup recovery requests do not invoke recovery. This policy does not alter the Web client's optional iframe preview or its file-link routing.

Browser-opening rejection and synchronous failure share a redacted callback. The owning window displays existing-locale advice only while alive. Reporting failure is contained without logging either raw error or destination, because a requested URL can carry authorization data. An OS handoff is not proof that the page loaded or authorization succeeded.

## Alternatives considered

**Change individual anchors to `_self`.** That leaves other links and programmatic opens broken and couples provider UI to shell-specific behavior.

**Allow Electron popups or navigate the product window away.** Both broaden the renderer's capabilities and can replace or detach the owned application UI.

**Replace the maintained shell or upgrade Core.** External navigation is a shell-owned omission; fixing it does not require changing runtime, plugin, recovery, or update ownership.

## Consequences

The shared policy repairs both opening paths without changing the preload protocol or weakening sandbox settings. Unsupported URI schemes remain unavailable rather than launching arbitrary registered applications. Startup integration tests retain recovery behavior, and focused navigation tests cover rejection, malformed destinations, per-window operations, and redacted failure reporting. An isolated Electron renderer test establishes click dispatch with a substituted OS opener; it is not an installed-product or real default-browser acceptance claim.
