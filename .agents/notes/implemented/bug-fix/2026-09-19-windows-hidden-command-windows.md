# Agent Note: Hide initial Windows command windows

Status: implemented

English | [中文](2026-09-19-windows-hidden-command-windows.zh.md)

## Problem

The ordinary Windows Job path created its private runner and native target without startup visibility flags. PowerShell commands launched from a windowless Electron Host could therefore open console windows and interrupt typing. The fallback path already requested hidden windows, so its behavior did not qualify the native Job path.

## Decision

The [Windows runner launcher](../../../../packages/subprocess/subprocess-local/src/windows-job.ts) sets `windowsHide: true`. The [shared Win32 process primitives](../../../../packages/subprocess/win32-process/src/process.ts) supply `STARTF_USESHOWWINDOW` and `SW_HIDE` alongside `STARTF_USESTDHANDLES` for ordinary and restricted-token targets. The existing `STARTUPINFOW` layout already includes the visibility field; its typed input now exposes that field without changing the ABI layout. This follows the official `dsh-v0.1.6-alpha.2` startup behavior without upgrading the Core or dependency graph.

Process creation flags, console inheritance, standard and control handles, suspended creation, Job assignment, resume ordering, cancellation, and handle cleanup remain unchanged. PTY terminal sessions retain their separate launch path. The setting controls initial visibility, not a program that explicitly opens a later window.

## Alternatives considered

**Use `CREATE_NO_WINDOW`.** Removing console allocation can break restricted-token DLL initialization. Hidden startup windows preserve the console semantics required by the existing ordinary and sandbox paths.

**Change Windows Terminal defaults or terminate every PowerShell process.** Those operations affect unrelated user work and do not repair the process launcher.

**Upgrade the whole Core.** The visibility correction is independent of the larger Desktop and plugin-management changes. A focused backport avoids that unrelated compatibility work.

## Consequences

Background commands request hidden initial windows while retaining their original output, exit, and process-ownership behavior. Binding tests assert both startup visibility and unchanged creation flags; runner tests pin the Node launch option. The release workflow requires native Job and restricted-token regression suites before packaging. Packaged validation observes real target startup information, streams, and owned process cleanup before release assets are finalized, rather than treating mocked options as runtime acceptance.

Console visibility observations have limits: Windows Terminal may expose a message-only console HWND, and a console surface can belong to another host process. A hidden or absent target HWND alone does not establish desktop-wide visibility or focus behavior. Interactive focus acceptance remains distinct from startup-flag and lifecycle verification; installing the release into a user's active Desktop requires separate consent.
