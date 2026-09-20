# AGENTS.md - Desktop updates and releases

Read the [Desktop README](README.md) and [release-channel decision](../../.agents/notes/implemented/architecture/2026-09-15-fork-owned-windows-desktop-release-channel.md) before changing startup, managed updates, recovery, or release metadata.

## Retained update records

- Treat shipped handoffs, completion receipts, and installer results as persistent data. Inspect records written by released versions, including field variants within the same schema version; do not infer compatibility from `schemaVersion` alone.
- Version incompatible persisted-field changes explicitly. Read historical records through a validated, read-only adapter used only for reconciliation. Never make historical capabilities eligible for new installations or weaken the current launch parser.
- Add fixtures for released field variants and mixed histories: cancelled and completed old operations, successful pending updates, and an old completion followed by a current failed or interrupted installation. Reproduce the reported failure before the fix when practical.
- Assert that reconciliation preserves retained bytes and does not advance completion on invalid evidence. Keep installer failures independent from metadata compatibility errors; never delete history, reset the profile, or edit a failure into success to make startup pass.

## Publication preflight

- Before committing to a publication path, verify the expected publishing account, repository access, and explicit PR head/base through the integration that will perform the write. A successful `gh api user` in one process does not authenticate an app-native or MCP integration.
- If an integration cannot select the required account or refs, use another permitted, supported integration with those controls. Do not repeatedly retry the unchanged failing integration, silently change the publishing account, or publish an automatically generated branch with the wrong identity prefix.
- Check required shell tools and dependency materialization early. Diagnose missing dependencies separately from source failures; do not alter product code or bypass hooks to conceal an environment failure. Record any explicitly authorized hook exception.

## Release acceptance and recovery

- Require both retained-history regressions and packaged clean-install acceptance. A clean-profile startup does not establish upgrade compatibility.
- Advance the reviewed release version and sequence. Publish only through the standard workflow pinned to the exact merged source SHA. A successful rehearsal or uploaded installer is not a published Release; verify publication, immutable assets, checksums, and remote managed-update discovery before reporting completion.
- For a faulty release, inspect adjacent versions and actual updater selection before proposing withdrawal. A prerelease flag is not an exclusion rule for managed discovery. Obtain explicit authorization before deleting Release objects, retain Git tags and source history unless separately authorized, and verify the affected releases disappear from discovery.
- Do not start or restart the operator's installed Desktop without permission. When the operator requires manual startup, use isolated tests and hosted acceptance, and report local installation/startup verification as pending.
