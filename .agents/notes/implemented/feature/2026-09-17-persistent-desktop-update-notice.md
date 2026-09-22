# Agent Note: Persistent Desktop update notice

Status: implemented

English | [中文](2026-09-17-persistent-desktop-update-notice.zh.md)

## Problem

A startup-only check misses releases published while Desktop remains open. A menu entry is easy to overlook, while automatically opening an installation dialog interrupts active work. Availability needs a visible place independent of the selected Session without granting the Web renderer package-management authority.

## Decision

The [official-first migration proposal](../../proposed/architecture/2026-09-18-official-first-desktop-safety.md) partially supersedes this decision. The fork's protocol-2 strip, layout adapter, and separate notification polling are retired in favor of the official settings `DesktopUpdateIndicator` and collapsed badge. This note retains the noninterrupting-discovery and shell-authority rationale; it does not qualify the WIP safety migration or present the old strip as supported UI.

Electron owns update discovery and installation. The official protocol-1 bridge exposes `status`, `open`, and removable subscriptions. Renderers cannot select update URLs, paths, versions, or installer arguments, and opening update UI does not authorize installation. Plugin management belongs to the shared Web PluginManager, not update IPC. The [Desktop README](../../../../apps/desktop/README.md) owns the official presentation, polling, and confirmation behavior.

The retained optional `reportImpact` safety extension reports only `hasDraft`, `attachmentCount`, and `submitting`. It carries no draft text, attachment content, executable selection, or installation authority. Its consumer migration must cover every mounted Conversation seat and detached send; declaration of the extension alone does not establish end-to-end protection.

Managed update checks classify known network failures at the existing release-list, tag-verification and manifest-download boundaries, including response-body failures. Bounded cause inspection supplies localized stage, reason and recovery advice only in the folded `technicalDetails`; the official safe main summary and protocol-1 presentation remain unchanged. No raw network messages or URLs are displayed, and the adaptation adds no renderer authority or replacement update UI. Unknown fetch failures remain generic rather than asserting that the network is unreachable; non-network validation errors retain their existing diagnostics. Certificate advice retains verification. Diagnostic wrappers retain standard `AbortError` and `TimeoutError` names so the build-only sanitizer preserves cancellation classification without exposing original messages. This is a diagnostic change only: update sources, request options, retry behavior and installation authority remain unchanged.

## Alternatives considered

**Menu-only discovery** keeps the UI smaller but makes availability difficult to discover during long-running sessions. The official account-row indicator and collapsed badge now provide that visibility without a second strip.

**Automatic installation dialogs** are conspicuous but interrupt the user's current task. Background discovery must not authorize download, installation, or restart; official user-initiated preparation and confirmation retain their own sequencing.

**Renderer-owned polling or downloads** duplicate the trusted updater and would expose network/package operations to application content. Electron remains the sole updater owner.

## Consequences

The retired strip occupied center-panel height and could reflow content; the official presentation removes that duplicate layout cost. Availability remains update state, not evidence that installation completed. Keeping the scalar safety extension preserves an input-loss concern without retaining the old presentation protocol.

The old adapter subscribed before reading its initial snapshot, preferred newer events, and disposed listeners while suppressing late completions; its compiled-client smoke covered focus, geometry, Later retention, and reload. Those observations belong to the retired implementation, not qualification of the official replacement. The migration requires current indicator/badge, subscription-disposal, stale-report, mounted-input, and detached-send coverage plus separate packaged update acceptance. Locale and string tests validate diagnostic classification and copy, not real folded-details UI behavior. No prior fixture proves a real release download or authorizes restarting installed Desktop.
