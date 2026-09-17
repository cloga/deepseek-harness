# Agent Note: Remove inherited Git configuration as a group

Status: implemented

English | [中文](2026-09-17-ambient-git-configuration-groups.zh.md)

## Problem

Git's temporary environment configuration combines a count with indexed key/value pairs. Filtering credential-shaped variable names removes `GIT_CONFIG_KEY_n` while leaving the count and values. A child then receives an invalid group and Git rejects it before running the requested command. The retained values can also carry temporary authentication settings without a credential-shaped variable name.

## Decision

The shared `scrubbedParentEnv` helper rejects ambient `GIT_CONFIG_COUNT`, numeric `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n`, and the legacy `GIT_CONFIG_PARAMETERS` form by name. It examines names before reading retained values. Independent `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, and `GIT_CONFIG_NOSYSTEM` settings remain available.

This rule applies only to inherited environment entries. Caller-owned explicit overrides are merged afterwards, preserving complete intentional Git configuration, deliberately forwarded credentials, Windows case-insensitive replacement, and deletion tombstones. The exported sensitive-name expression remains unchanged; providers with separate remote-environment policies are not silently rewritten.

The local provider uses the helper for its ordinary and terminal launch environments. Pure service/environment tests run in the normal Windows test inventory. The existing egress suite retains its separate Windows exclusion because its proxy tests assume POSIX case-sensitive environment variables and process behavior.

## Alternatives considered

**Keep Git's key descriptors to avoid breaking the group.** This also retains ambient configuration that can carry authentication values into unrelated child processes.

**Remove every `GIT_CONFIG_*` setting.** This unnecessarily discards independent configuration-file and system-configuration choices. The temporary group has an exact set of names.

**Filter the final merged environment.** This would remove explicitly authorized per-process configuration and credentials instead of limiting ambient inheritance.

## Consequences

Children do not inherit partial temporary Git groups, including zero-count, sparse, or orphaned entries. Synthetic tests verify all rejected names without reading their values and preserve explicit overrides on both platform cases. An isolated real Git configuration query rejects the damaged group with exit 128 and succeeds with exit 0 after the shared scrub, without reading user configuration or accessing the network. This is not a network, proxy, TLS, credential-acquisition, or installed Git-path change. Callers still choose executables and supply any credential they intentionally authorize.
