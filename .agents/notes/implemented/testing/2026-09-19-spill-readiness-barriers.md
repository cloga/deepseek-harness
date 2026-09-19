# Agent Note: Synchronize slow-spill tests on readiness

Status: implemented

English | [中文](2026-09-19-spill-readiness-barriers.zh.md)

## Problem

A subprocess-backed spill regression must establish that a later tool dispatch starts while the preceding oversized result is still waiting for its spill backend. A polling helper's implicit one-second deadline also includes process initialization, so a contended Windows coverage worker can fail before the behavior under test becomes observable.

## Decision

The [slow-spill regressions](../../../../packages/spill/spill-policy/tests/spill-policy.spec.ts) wait for owned backend-entry and dispatch-start signals. The result-delivery case keeps its backend blocked until the later dispatch is observed; assertions also require that no oversized save or settlement has completed. The bounded-backlog case observes the second and third save-entry milestones, retains its third-dispatch exclusion assertion, and preallocates release gates so a late save cannot strand cleanup. Releasing the backend permits the original result and settlement assertions. Failure and timeout cleanup release the owned gates and drain the execution.

The case uses its existing test/lane deadline rather than an additional polling deadline. Production spill behavior, process launch behavior, concurrency limits, and coverage requirements are unchanged.

## Alternatives considered

**Increase an arbitrary polling timeout.** A longer clock allowance still confuses process startup with dispatch ordering and can fail under a different level of contention.

**Skip the regression or serialize coverage.** Neither preserves evidence that result delivery is independent of delayed log shaping.

**Change production spill ordering.** The failure does not establish a production ordering defect; the regression retains the existing ordering requirement.

## Consequences

The test depends on actual progress events, not a scheduler upper bound. A runtime that waits for spill completion before delivering the program value cannot satisfy the later-dispatch observation while the gate is held. Cleanup owns the asynchronous work even when an observation fails. This is test synchronization evidence, not an end-user latency benchmark. The retained instantaneous third-start absence assertion is not an independent mutation-sensitive proof of the backlog-cap algorithm.
