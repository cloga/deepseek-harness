# Agent Note: Titled blank Sessions remain navigable

Status: implemented

English | [中文](2026-09-15-titled-blank-session-navigation.zh.md)

## Problem

A top-level Session may receive a durable title before its first turn when a user or an integration provisions it for later work. The Workspace browser treated every non-current blank Session as a disposable New Session placeholder, hiding the row and replacing its durable title with the localized placeholder. Users could not navigate to the prepared Session without first adding an unrelated model turn.

## Decision

The Workspace browser treats `SessionSummary.title !== undefined` as the explicit intent to retain a blank root as a navigation target. Grouped and flat views display its durable title, and metadata search can match that title or its Workspace. Untitled blank Sessions remain visible only while selected and keep the localized New Session label. New Session creation reuses only those untitled blanks, never a titled Session reserved for later work. Existing subagent and archive exclusions still apply.

An explicitly titled blank row counts toward the five ordinary rows in a folded Workspace. Only the selected untitled New Session remains outside that quota. Content-search results never attach snippets to blank Sessions because their logs contain no completed conversation to search.

## Alternatives considered

**Start a synthetic turn.** This makes the Session non-blank but adds irrelevant history, may invoke a model, and changes data to repair navigation.

**Show every blank Session.** This exposes abandoned provisional rows and weakens New Session reuse semantics.

**Depend on a Schedule projection.** Prepared Sessions can come from integrations other than the built-in Schedule capability, and an external scheduler need not write the Schedule event vocabulary. The durable title is the package-owned intent signal already available in every list row.

## Consequences

Prepared titled Sessions remain discoverable without waking an Agent or appending an event. The tree, renderer, folded-row accounting, and metadata search share the distinction between an untitled provisional blank and an explicitly titled blank root. Unit and rendered browser-component tests cover named visibility, localized provisional rows, folding, search, archive exclusion, and subagent exclusion.
