# Agent Note: Cordis preset skills use the bundled root

Status: implemented

English | [中文](2026-09-18-cordis-bundled-skill-root.zh.md)

## Problem

The `cordis` preset classified its deployment-owned skills as a custom filesystem root. In the affected Electron ASAR runtime, filesystem metadata returned numeric fields despite a bigint request, so the local provider's bigint mode mask threw. One failed root aborted the filesystem skill provider's discovery, hiding user skills together with the preset's skills.

## Decision

The [shipped preset](../../../../packages/preset/agent-presets/presets/cordis/agent.cordis.yml) registers its adjacent directory through the existing `bundledSkillDir` option. The Loader resolves the directory against the preset's `baseUrl`; the skill provider uses its host reader for that root. Project, user, and custom roots retain their filesystem-service checks. Bundled rank places the deployment's skills below user overrides.

## Alternatives considered

**Normalize every Electron filesystem stat.** A complete local-filesystem compatibility change must preserve version freshness as well as accept numeric mode fields. That broader repair is not required to classify the preset's own assets correctly and is outside this change.

**Bypass the filesystem service for custom roots.** Custom roots belong to the configured execution filesystem. Treating all of them as trusted host assets would change access behavior for unrelated skills.

**Copy or edit the installed preset.** A local copy drifts from application updates, while editing the shipped installation is overwritten by upgrades. Neither fixes the application source.

## Consequences

Packaged preset skills no longer depend on local-filesystem support for ASAR metadata. The change also removes the former custom-root precedence over user skills. It does not make general filesystem tools ASAR-compatible or alter the provider's handling of failures in other roots.

Verification covers the actual shipped YAML row loaded through the Loader, preset-relative path resolution, user and bundled skill loading when the filesystem backend rejects the shipped directory, duplicate-name precedence, and continued filesystem enforcement for custom roots. The release ASAR check also runs the [packaged skill canary](../../../../apps/desktop/tests/fixtures/packaged-skills-smoke.mjs) against the supplied application's actual preset and runtime, with a private home and synthetic user skills. It requires complete discovery and four successful skill tool calls before release finalization.
