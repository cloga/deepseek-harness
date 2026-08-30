# Agent Note: Portable pull-request runners in repository forks

Status: implemented

English | [中文](2026-08-30-fork-portable-pull-request-runners.zh.md)

## Problem

The pull-request workflow selected repository-restricted larger-runner labels for its primary Linux jobs, native Windows jobs, aggregate verdict, and preview. A GitHub fork copies those labels as strings but does not inherit the upstream repository's runner access or Cloudflare secrets. Standard-hosted matrix jobs completed while every primary job remained queued without a runner, so the fork could never produce `all checks passed`.

## Decision

Pull-request runner selection checks `github.repository`. `deepseek-harness/deepseek-harness` retains its measured larger-runner and self-hosted failover choices. A repository fork runs primary Linux jobs and the aggregate on `ubuntu-latest`, and native Windows jobs on `windows-2025`. Fork jobs also lower outer gate, snapshot, browser, lint, and package-validation concurrency to the standard runners' capacity. Coverage runs one Vitest process with one worker because concurrent full-suite processes starve real-shell and lifecycle probes on hosted runners. Retaining 16-core fan-out causes bounded lifecycle and persistence tests to time out or contend on filesystem publication. The Cloudflare preview is an upstream-only job because a fork cannot publish to the upstream deployment project.

The workflow preserves every required job and command in forks; only runner capacity changes. Forks therefore execute the complete required evidence instead of skipping checks or depending on repository-external runner configuration.

This decision partially supersedes the no-automatic-fallback clause in [the portable pull-request CI decision](../process/2026-07-23-portable-required-pull-request-ci.md) and the organization-runner-only clause in [the native Windows pull-request CI decision](../process/2026-08-08-native-windows-pull-request-ci.md). Those notes continue to own the upstream runner topology, measured concurrency, required aggregate, and dual Wine/native coverage.

## Alternatives considered

**Leave fork jobs queued and rely on local checks.** Rejected because branch protection consumes GitHub check results, and local evidence cannot create the missing required aggregate.

**Skip primary jobs in forks.** Rejected because a green aggregate would then omit required static, coverage, snapshot, build, and native-process evidence.

**Configure the fork with identically named custom runners.** Rejected because correctness in a GitHub fork must not require duplicating private runner or deployment infrastructure.

## Consequences

Fork pull requests can complete required CI on portable GitHub-hosted capacity, with slower execution than the upstream larger-runner path. Upstream pull requests retain their existing performance, measured concurrency, and failover behavior. Workflow tests pin both branches of each runner selector, the fork concurrency bounds, and the upstream-only preview condition.
