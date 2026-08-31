# Agent Note: Async persistence quiescence

Status: implemented

English | [中文](2026-08-30-async-persistence-quiescence.zh.md)

## Problem

Durable storage and recovery work can remain pending after the synchronous event that starts it. Tests that wait a fixed interval can inspect the old durable record or miss a delayed warning under coverage load. Agent Teams recovery was also queued outside the runtime's tracked operations, so service disposal could release a persistence context while recovery still used it.

## Decision

Projection-cache tests synchronize on the operation they own: direct and threshold-triggered writes await the exact write promise, while tests without an operation handle wait for the exact stored row or warning they need to observe. They do not infer write completion from elapsed wall-clock time.

Agent Teams registers each scheduled recovery promise before its deferred callback can run. Disposal closes admission, settles those recovery promises, then settles creation and mailbox operations before releasing live children. Scheduling after the cutoff creates no operation.

The lifecycle test holds one recovery open and proves disposal remains pending until that recovery settles. Persistence recovery tests continue to use their existing assertions and timeout; quiescent disposal removes the cross-instance overlap rather than extending the budget.

## Alternatives considered

**Increase sleeps or test timeouts.** A larger delay still guesses at filesystem and coverage-runner scheduling. It hides missing ownership and can fail again under heavier load.

**Make session event listeners await checkpoint writes.** The projection cache deliberately uses fail-soft write-behind. Changing event delivery to await optional derived-state durability would add latency and alter the runtime API to fix a test-observation problem.

**Rely on nested creation and mailbox tracking.** Recovery can be queued before either nested operation exists. Disposal must own the top-level recovery promise to close that gap.

## Consequences

Coverage tests await owned operations before reading durable state and otherwise synchronize on the exact observable result without weakening assertions. Team disposal may wait up to the configured disposal timeout for recovery, and no recovery can outlive the service's persistence dependencies.
