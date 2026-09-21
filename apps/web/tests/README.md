# apps/web browser e2e

English | [中文](README.zh.md)

These tests boot the real web composition in-process and drive it with a real Chromium over real HTTP. The lane's mechanics — modes, fixtures, goldens, and the deliberate composition divergences from `dsh web` — are documented in [`scaffold.ts`](scaffold.ts) and the [browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

## Completion observations

State-sensitive cases use Workspace, admission, attachment, and model-stream barriers to separate visible intermediate states from completed operations. Details close waits for frame transitions; archive verification assigns an explicit title to the seeded Session and follows that identity across reload. See the [CI fixture synchronization decision](../../../.agents/notes/implemented/testing/2026-09-08-ci-completion-observations.md).

## Scroll startup failure evidence

The live-tool case in [`chat-scroll-contract.e2e.ts`](chat-scroll-contract.e2e.ts) observes scalar geometry, fixed focus/state categories and input/scroll/resize ordering through its first post-Send bottom assertion. It retains the first 64 and latest 64 observations within the existing 128-record bound, so geometry polling cannot evict the entire early sequence. Failure emits `CHAT_SCROLL_INITIAL_BOTTOM` to test stderr within the existing 65,536-character limit; oversized or unavailable diagnostics report fixed categories, never raw errors. No conversation text, URLs, DOM writes, timers or readiness barriers are added. Observers are disposed before wheel input or failure cleanup; read, logging and disposal failures cannot replace the original assertion. Geometry reads can affect timing and omitted middle records limit attribution: this is evidence collection, not a cause correction or browser qualification. Inert callback tests verify retention and cleanup, not the cause of a historical failure.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate, because they read Host services directly: `ctx.connection`, the Host `SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does not make a file part of the Client program — the two faces merge Cordis `Context` under the same keys with different services, so one program cannot see both. Moving these files into the Client aggregate makes every Host-service access fail to compile.

## Do not import `@deepseek-ai/dsh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript project, and every project it references, into the **Host build graph**. That has bitten this lane once already: four Client consumer packages reference `api/remotes`' Client face, which cannot compile until Host tsdown has generated `@deepseek-ai/dsh-goal/remote`, so the Host build phase ended up waiting on an artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here instead, next to the commented-out import that names the source module. A drift then surfaces as a missed selector or a stale mirrored value — a loud failure, never a silent pass. `scaffold.ts` follows this rule for the welcome-notice namespace, acknowledgement field, version, and asserted Chinese copy.

The built-client harness is the exception. `assembled-boot.ts` imports `AppWebEntry`, the boot-manifest type, and `RemoteMock`; `assembled-remote.ts` imports the Client test runtime's default responses and `RemoteMock`. These packages are explicit project references for booting the real shell against a test-owned carrier. The chat scenarios mirror `conversationContextKey` in `support.ts` instead of importing its Client owner.

Nothing mechanically enforces this rule; keep it in review.
