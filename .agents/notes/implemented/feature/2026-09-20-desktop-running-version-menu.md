# Agent Note: Running Desktop version in the native menu

Status: implemented

English | [中文](2026-09-20-desktop-running-version-menu.zh.md)

## Problem

The bundled Core version does not identify the running fork Desktop installer. An available update identifies a different release, and looking up either value in the Web interface depends on Host startup. Users need an unambiguous running Desktop version without changing the application or accessing the network.

## Decision

The first native Application menu entry displays the complete `app.getVersion()` value, including prerelease and fork suffixes, in localized About Desktop copy. Selecting it calls Electron's native `app.showAboutPanel()`. The panel's application name identifies Desktop and its application version uses the same running value. This shell-owned information remains available independently of Host readiness, recovery content, and update discovery; it adds no renderer IPC or package-management action.

The [persistent update notice](2026-09-17-persistent-desktop-update-notice.md) continues to identify an available replacement, not the running application. Its discovery, consent, and installation behavior are unchanged.

## Alternatives considered

**Core package metadata or an update candidate** can report a different version from the running Desktop binary. Electron's application version owns the displayed identity instead.

**A Web-only Settings entry** depends on a healthy Host and renderer. The native menu remains useful during startup or recovery without another IPC interface.

## Consequences

The menu adds one localized entry and the native About panel remains platform-owned. Reading the version does not check for updates, download artifacts, modify settings, or restart the Host. Version display is not evidence of successful managed-update completion or plugin qualification.

Owner-local Desktop tests cover locale copy, full-version preservation, native About options and dispatch, and existing menu actions. The packaged acceptance observes the actual Electron menu and running version before waiting for Host readiness, on both initial startup and restart. It temporarily intercepts `showAboutPanel` only while invoking the real menu callback and restores it even when that callback throws. Receipts distinguish this callback-dispatch check from native modal rendering, which is not automated. This shell behavior has no recorded Session round trip; its expected observations belong beside Desktop tests rather than in the CLI Session snapshots. Acceptance uses only a disposable packaged application and profile, never the operator's live installation.
