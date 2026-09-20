# Agent Note: Desktop plugin slash command

Status: implemented

English | [中文](2026-09-20-desktop-plugin-slash-command.zh.md)

## Problem

Desktop exclusively owns `$DSH_HOME/profiles/desktop`. Its plugin window can invoke the verified transaction, but a user working in a Session cannot list or prepare a plugin change without switching to that window. The ordinary CLI intentionally rejects the reserved profile and cannot observe the live Electron Host, renderer draft, transaction lock, ownership receipts, or native interruption confirmation.

## Decision

The packaged Desktop Host registers one built-in `/desktop-plugin` command. It supports `list`; `install npm <spec>`; `install github <owner/repo[#ref]>`; `install release <verified-release-json>`; `remove`; exact-version `update`; `enable`; `disable`; and `disable-all`. Slash installation excludes local paths and arbitrary URLs because a Session working directory is not a stable Electron package-resolution base. The plugin window remains the supported path for those sources.

The command never edits the profile or invokes pnpm. It sends a closed, bounded operation over the existing Node child IPC channel to the exact active `DesktopHostProcess`. Electron validates that wire message, re-runs the authoritative source parser, and routes the operation through `DesktopProjectManager`. No preload, loopback endpoint, filesystem capability, raw package-manager arguments, or CLI exception is added.

### Self-restart settlement

An approved plugin transaction stops the Host that is executing the command. Electron therefore begins preparation while that Host remains active. When staging and the temporary Host health check reach `beforeChange`, Electron returns only a typed `prepared` response and waits for the matching `command/done` event. The Desktop Host observes that durable lifecycle event and sends a request-id plus command-id settlement acknowledgement. Electron then reads fresh Host and renderer impact, shows the existing default-Cancel native confirmation, and only an approved result may stop the Host. Cancellation, disconnect, stale IDs, settlement timeout, or unavailable impact leaves the active Host/profile unchanged.

List responses contain only package name, version, and enabled state. Mutation errors cross IPC as a small error-code allowlist; arbitrary manager, subprocess, network, path, package, or raw-input text never enters the command transcript. Internal startup diagnostics retain their existing product path after interruption.

## Alternatives considered

**Allow `dsh plugin --profile desktop`.** This bypasses the running Electron owner and cannot preserve impact confirmation, transaction exclusion, receipts, staged health checks, or rollback.

**Expose mutations through the application preload.** Application documents and Client plugins are not trusted to gain Desktop package mutation authority. The shell-only boundary remains unchanged.

**Add a loopback control server.** This adds authentication, lifecycle, and port ownership that the existing exact-child IPC channel already provides.

**Stop immediately after returning `prepared`.** A timing delay cannot establish that `command/done` reached the Session log. The explicit settlement acknowledgement binds the restart to the matching lifecycle record.

## Consequences

The bridge adds protocol version 4 and a direct Desktop Host dependency on the commands registry. Every mutation still incurs acquisition, staging, health checks, impact review, native confirmation, Host restart, and rollback. The command reports preparation, not installation success; final activation remains visible through Desktop state and inventory after restart.

## Required verification

Grammar tests cover npm names, scoped specs, dist-tags, comparator and hyphen ranges, GitHub refs, verified JSON syntax, exact update versions, input bounds, local/protocol/credential rejection, and safe output. Electron startup tests cover operation mapping, current-child and monotonic request identity, pre-stop error redaction, command settlement before confirmation, cancellation, timeout, busy states, and stale requests. Host-process tests carry real child IPC request/response/settled messages. Packaged rehearsal must prove command registration, a paired `command/run`/`command/done` record before restart, native default-Cancel behavior, and final inventory through the same transaction used by the plugin window.

Recorded-session snapshot exemption: the command is registered only by the private Desktop Host and requires its exact Electron parent IPC owner. The snapshot harness must start through the public CLI and may not add a hidden Desktop driver; it cannot exercise this boundary without violating `snapshots/AGENTS.md`. The command sends no model request and adds no model-visible input. Grammar, real child IPC, Session lifecycle, Electron startup, and packaged Desktop acceptance are the owning verification layers instead.
