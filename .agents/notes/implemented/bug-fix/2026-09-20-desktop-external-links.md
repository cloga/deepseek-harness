# Agent Note: Contain Desktop external-link failures

Status: implemented

English | [中文](2026-09-20-desktop-external-links.zh.md)

## Problem

Official `0.1.6-alpha.2` already hands external HTTP and HTTPS links to the system browser and permits same-origin navigation to the owned Host HTTP document. The retained gap is malformed destination handling and containment of synchronous opener failures or asynchronous rejection, not absence of external-link support. Failure diagnostics must not expose URLs that can contain authorization data or replace the owned application document.

## Decision

[Window navigation](../../../../apps/desktop/src/window-navigation.ts) preserves the official navigation policy for owned application windows. Same-window `dsh-app:` navigation and navigation to the current owned Host HTTP origin stay internal; external HTTP and HTTPS destinations are parsed and handed off canonically while Electron popup creation remains denied. Malformed destinations and other external URI schemes are blocked. No shell command or new renderer IPC is introduced.

Native fatal recovery remains with the alpha2 main-process owner. The shared PluginManager, preload-owned caption menu and existing context menus retain their owners; this hardening does not reintroduce a plugin window, startup HTML or recovery-URL action path. The Web client's optional iframe preview and file-link routing are unchanged.

Browser-opening rejection and synchronous failure share a redacted callback. The owning window displays localized advice only while alive. Reporting failure is also contained without logging either raw error or destination. An OS handoff is not proof that the page loaded or authorization succeeded.

## Alternatives considered

**Change individual anchors to `_self`.** Anchor changes do not contain malformed URLs or opener failures and couple provider UI to shell-specific behavior.

**Allow Electron popups or navigate the product window away.** Both broaden the renderer's capabilities and can replace or detach the owned application UI.

**Replace the official opening policy as though it were absent.** Alpha2 already provides the opening and same-origin rules. Retain only the missing failure handling rather than restoring the older shell's plugin-window or recovery routing.

## Consequences

The hardening preserves both official opening paths, internal Host navigation, the preload protocol and sandbox settings. Unsupported URI schemes remain unavailable rather than launching arbitrary registered applications. Focused tests cover malformed destinations, synchronous/asynchronous opener failures, window lifetime and redacted reporting; main-entry coverage retains native fatal recovery and menu ownership. The mandatory CI development-Electron fixture uses private owned protocol/HTTP documents and an injected OS opener to observe real renderer dispatch. It does not open the system browser or establish OAuth, installed-upgrade or complete process-tree quiescence. That fixture is additive to the candidate's existing real installed-upgrade and v2 qualification lanes; synthetic or peer results cannot qualify the integrated alpha2 source.
