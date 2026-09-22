# Agent Note: Desktop plugin slash command

Status: implemented

English | [中文](2026-09-20-desktop-plugin-slash-command.zh.md)

## Problem

Desktop exclusively owns `$DSH_HOME/profiles/desktop`. The shared Plugins page can prepare a verified transaction, but a user working in a Session also needs an in-conversation entry point. The ordinary CLI intentionally rejects the reserved profile and cannot observe the live Electron Host, renderer draft, transaction lock, ownership receipts or native interruption confirmation.

## Decision

The packaged Desktop Host registers one built-in `/desktop-plugin` command. It supports `list`; `install npm <spec>`; `install github <owner/repo[#ref]>`; `install release <verified-release-json>`; `remove`; exact-version `update`; `enable`; `disable`; and `disable-all`. Slash installation excludes local paths and arbitrary URLs because a Session working directory is not a stable Electron package-resolution base. Supported non-command sources remain on the shared Plugins page. Registry updates require an existing registry-installed target; source-installed packages are not silently converted to registry packages.

The command handler never edits the profile or invokes pnpm. A closed, bounded operation travels over Node child IPC from the exact active Desktop Host. Electron validates it, repeats authoritative source parsing and uses the existing fork launcher-owned profile staging/activation owner on alpha2. The Web-backed `runProfile`, ready URL/injections, update-task control and shutdown protocol remain intact; no framed transport, standalone plugin window, preload mutation API, additional loopback server, arbitrary package-manager arguments or CLI exception is introduced.

Selection-only changes preserve package bytes, dependency resolutions, source locks, receipts, provisioning and ownership. They change only candidate bundle selection, not installation. Disable-all prepares one canonical nonempty target set under the profile lease and uses one candidate and one confirmation; an empty set fails without inventing a package name. Registry eligibility and the preserved prior selection are checked under that same lease, not by a separate precheck.

Ordinary install/remove staging retains its legacy five-field result. Pending/status/list queries additionally expose a versioned selection record with every actual target; they do not grant activation authority. The shared record definitions belong to the [boot subsystem](../../../../docs/subsystems/boot.md). Host and Client must be built and qualified together; an older client is not promised support for the new selection variant.

### Self-restart settlement

An approved transaction stops the Host executing the command. Preparation therefore runs while that Host remains active: the existing private candidate reconstructs the retained graph from its frozen lock, then resolves any approved installation/update target separately. Both operations use production dependencies with package scripts and pnpmfile ignored; patch expressions remain unevaluated. Preparation may use the network, but it does not execute the candidate Host. Electron returns only a typed `prepared` response. The Host observes matching `command/done`, awaits successful `sessions.flush(session)` and only then sends the request-id/command-id acknowledgement. An unavailable observer, failed flush or outgoing send failure cannot grant settlement.

Command origin and normalized intent are bound in the versioned private preparation journal to the Electron-minted Host generation, request, command and transaction. Every pre-journal activation path checks the matching live authority before and after command-specific native confirmation. Ordinary Web review cannot activate a command preparation or borrow another command's readiness. An orphan preparation after restart remains readable and discardable, not automatically activatable. Existing recovery of an already admitted activation keeps its journal, native confirmation, admission, health and rollback checks.

Native command confirmation defaults to Cancel. Only approval followed by the existing input, lifecycle and admission checks may stop the Host and execute the candidate for final health verification. Before admission to an activation journal, Cancel, disconnect, stale identity, settlement timeout or failed flush leaves the active profile unchanged and requests discard of only the command-owned candidate after preparation quiesces. Failed cleanup retains owned data and cannot report success. Once admitted, activation and journal recovery own the remaining lifecycle; an intentional old-Host disconnect is not cancellation. Ordinary Web Later retains its own preparation. Native cancellation does not append a second command completion. Uncertain unlock or cleanup retains its safety gate rather than reporting success.

List responses contain only package name, installed version and selected enablement. Errors cross IPC through a small fixed-code allowlist instead of arbitrary manager, subprocess, network, path, package or input diagnostics. The user's input retains normal `command/run` logging. Internal startup diagnostics retain their existing product path after interruption.

GitHub transport failures retain the HTTP status, a fixed request category and bounded numeric rate-limit or retry headers. They omit URLs, response bodies, request IDs, cookies and arbitrary header values. Denials are not retried automatically; status403 alone does not establish rate limiting, and acceptance injects no credential into the application.

## Alternatives considered

**Allow `dsh plugin --profile desktop`.** This bypasses the running Electron owner and cannot preserve confirmation, transaction exclusion, receipts, health checks or rollback.

**Expose mutations through the preload.** Application documents and Client plugins must not gain raw Desktop package mutation authority.

**Add a loopback control server.** It duplicates authentication, lifecycle and port ownership already provided by the exact-child IPC channel.

**Stop immediately after returning `prepared`.** A delay or event observation cannot establish that command completion reached durable Session storage.

**Reuse installation for bundle selection.** Installation may reacquire artifacts and replace ownership evidence; it is not a faithful enable/disable operation.

**Keep command origin only in memory.** A recovered preparation could otherwise bypass command settlement or native consent through ordinary Web review.

## Consequences

The Host directly depends on the commands registry, and its command contribution is effect-owned and installed before readiness is advertised. Command messages coexist with the alpha2 IPC lifecycle; the existing metadata version does not imply compatibility with the retired framed protocol. A command reports preparation, not completed installation or healthy activation. Selection earns no new verified-release receipt, and newly enabled targets require actual health checks. The generated pending-query codecs and UI describe the same-source public union; strict business parsing remains distinct from codec normalization.

## Required verification

Grammar tests cover supported sources, exact update inputs, bounds and safe output. Actual registry/Session lifecycle and child IPC tests verify one completion, successful flush before acknowledgement, send failures, disposal, cancellation, timeout, busy states and stale requests. Transaction tests preserve legacy journals and reject hybrid pending records, forged origin, base/target drift, rehashed semantic tampering and ordinary-Web activation of command orphans. Selection tests verify atomic targets, unchanged artifact/ownership evidence and no new receipt; registry eligibility is tested under lease. Main tests cover real inventory parsing/leases, authority, native dialog configuration, health targets and bounded window restoration after certain admission failure.

The [independent packaged command fixture](../../../../apps/desktop/tests/fixtures/desktop-plugin-command-smoke.ts) creates a synthetic Session and exercises discovery, list, invalid Release rejection and native Cancel through supported RPCs. The shell creates its fresh profile; the fixture waits for actual Client readiness and binds its source/tree/run/attempt, plan/lock and packaged-artifact identities. Cancellation checks actual alpha2 preparation/discard records and unchanged active metadata/artifact bytes, not fabricated legacy audit files. PREPARED comparison preserves parsed identity/fields; it is not a claim of raw journal-byte equality.

The application enters a nonbreakaway Windows Job before resuming. Cleanup requires root exit, zero active Job processes and closure of owned connections/handles before final success is written. Unknown spawn ownership or abnormal helper completion retains the private home. Original failures, including undefined, survive diagnostics or cleanup errors. Window discovery uses bounded Win32 enumeration and exact process, root-owner, HWND, title and control identity; visibility or enumeration order is not identity. Standard UIA providers are registered before control access. Only the revalidated owned Cancel control is invoked; helper evidence does not claim keyboard-default focus verification. Pure provider/validator/ledger tests are not actual native acceptance or full-owner fault injection.

The independent command phase is a mandatory release-workflow check, separate from the combined Copilot/native-composer suite and its closed proof format. Its internal artifact is not a seventh public release asset or evidence that the existing aggregate parser consumes it. Whole-release qualification still requires the actual hosted native run, complete cleanup and all remaining installer/publisher checks.

Recorded-session snapshot exemption: the command belongs to the private Desktop Host and its exact Electron parent. The public-CLI snapshot harness cannot add a hidden Desktop driver without violating `snapshots/AGENTS.md`. The command sends no model request and adds no model-visible input. Grammar, real child IPC, Session lifecycle, source-component and packaged Desktop acceptance own this verification instead.
