# Agent Note: Open Desktop web links through the system browser

Status: implemented

English | [中文](2026-09-20-desktop-external-links.zh.md)

## Problem

The alpha1 maintenance shell rejected web links on both opening paths. Official alpha2 already dispatches HTTP(S) externally, denies popups, shares window creation, and permits same-origin HTTP navigation in the owned window. Its remaining gaps are unguarded URL parsing, original rather than canonical dispatch, uncontained OS-opening failure and missing redacted localized advice. This adaptation preserves that partial official parity rather than installing a second navigation policy or restoring alpha1 recovery plumbing.

## Decision

[Window navigation](../../../../apps/desktop/src/window-navigation.ts) is the single extraction of alpha2's existing two handlers plus the missing guarantees. Both paths parse destinations safely and dispatch canonical HTTP(S) URLs. Every popup is denied; HTTP(S) popup requests go to the OS even when same-origin. Same-window navigation retains exactly internal `dsh-app:` and the official destination-HTTP/same-parsed-origin predicate; HTTPS is not granted that exception. The helper reads only its owned WebContents current URL, not a configurable origin allowlist. Malformed destinations, malformed current URLs and failed current-URL reads fail closed without throwing or opening an external destination.

Legacy `dsh-recovery:` URLs are blocked without an action on either path. The unused recovery callback is retired; alpha2's existing `DesktopFatalRecovery`, context menus, primary titlebar, sandbox settings and update ownership remain unchanged. No renderer IPC, arbitrary protocol opening, shell command or Host credential is introduced.

Synchronous and rejected OS-open failures share a redacted callback. The originating window displays `currentDesktopLocale()` advice only while alive, including the selected Windows document language. Reporter failure logs only a fixed message, never a destination or raw error. Retire this fork-specific helper when an exact official target supplies equivalent safe canonical parsing/dispatch, contained failures, localized redacted reporting and the same popup, same-origin and window-lifetime guarantees; migrate the tests rather than keep a parallel wrapper.

## Alternatives considered

**Change individual anchors to `_self`.** This couples provider UI to shell behavior and cannot cover programmatic opens or safely report OS failures.

**Allow Electron popups or arbitrary same-origin schemes.** That broadens the official navigation contract. Only the existing same-window HTTP predicate is retained; popups never use it.

**Restore alpha1 recovery or replace the maintained shell.** Neither is needed to close the identified alpha2 gaps. Native fatal recovery remains its existing owner.

## Consequences

Pure and mocked-main tests retain the original alpha2 suites and check canonical dispatch, denied popups, same-origin HTTP versus HTTPS/cross-origin behavior, malformed/current-unavailable input, blocked legacy recovery, per-window operations and redacted localized failures. Approved CI alone prepares the lock-matched development Electron after frozen installation and runs the isolated renderer fixture. Its OS opener is a spy; an owned ephemeral loopback server exercises actual same-origin HTTP navigation and is closed during teardown. Other requests and permissions remain blocked, with the original fixture/process deadlines unchanged. This is not installed-product qualification, a real default-browser page-load claim or proof of OAuth success; the stronger separate hosted installer lane remains required.
