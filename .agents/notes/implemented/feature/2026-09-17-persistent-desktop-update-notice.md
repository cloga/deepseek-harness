# Agent Note: Persistent Desktop update notice

Status: implemented

English | [中文](2026-09-17-persistent-desktop-update-notice.zh.md)

## Problem

A startup-only check misses releases published while Desktop remains open. A menu entry is easy to overlook, while automatically opening an installation dialog interrupts active work. Availability needs a visible place independent of the selected Session without granting the Web renderer package-management authority.

## Decision

Electron owns release discovery and its process-local notification snapshot. It checks ten seconds after successful startup and every six hours, coalesces overlapping checks, skips confirmation/installation/quit, and clears scheduled work on quit. Background checks never prompt, download, install, or restart. A previously verified available version remains visible during a transient refresh failure.

The application preload exposes only update status, removable subscriptions, an explicit review request, and the existing unsaved-input impact report. Review enters the existing native confirmation and repeated active-work check. Renderers cannot choose update URLs, paths, versions, or installer arguments. Plugin management remains shell-only.

The layout plugin renders a non-modal strip above the main panel, not an overlay. It survives Session and panel navigation and occupies no space when no update is available. An apply-owned adapter subscribes before obtaining the initial snapshot; an event received in the meantime wins over the delayed snapshot. Its stable observable enters the root registration's inject `hooks` compartment, and the framework-bound hook supplies plain notice props alongside an explicit review callback. The layout fiber owns subscription cleanup and suppresses late snapshot, event, and review completion after disposal; component remounts neither resubscribe nor reset an outstanding review. Plain Web and older report-only Desktop bridges render no strip.

## Alternatives considered

**Menu-only discovery** keeps the UI smaller but makes availability difficult to discover during long-running sessions.

**Automatic installation dialogs** are conspicuous but interrupt the user's current task. Automatic checks therefore publish status; only a deliberate review action opens confirmation.

**Renderer-owned polling or downloads** duplicate the trusted updater and would expose network/package operations to application content. Electron remains the sole updater owner.

## Consequences

The strip uses a small part of the center panel and can reflow content when it appears. It does not steal focus or cover the composer. Availability is process-local; after restarting, Desktop checks again rather than treating persisted notification data as a verified release. Background network errors do not produce modal dialogs.

Focused tests cover bridge restrictions, timer disposal, non-overlap, explicit consent, stale snapshots, and listener cleanup. The Desktop smoke also runs the real compiled client composition with only the Electron bridge simulated, checking notice geometry, focus, Later retention, and reload recovery. This fixture does not prove a real release download or authorize a restart of installed Desktop.
