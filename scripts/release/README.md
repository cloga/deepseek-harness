# Release scripts

English | [中文](README.zh.md)

This reference owns the controlled Core/Web GitHub-artifact path in [release.yml](../../.github/workflows/release.yml). [families.ts](families.ts) owns package membership, versions, payload policy and publish order; the existing npm publisher remains separate.

## Scope and prerequisites

The optional writer admits only `cloga/deepseek-harness`, PR 80 targeting `review/issue-72-official-base`, and version `0.1.6-alpha.5`. It requires an already-approved, existing `dsh-v<version>` tag. It never invokes npm publication, tag/ref writes, a build, installation, or package lifecycle under the write token. A future version requires a reviewed source change, not a different unchecked input.

The original dsh-family tarballs are Core/Web package artifacts, not a Desktop release, npm publication, or offline installer. Packed-install validation also uses vendored framework and Landlock entry tarballs that this artifact set does not include. Those companions, optional native platform packages, and other registry dependencies remain an external installation closure.

Publication refuses unless the [ruleset API](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset) establishes active repository-owned protection for this exact tag: its sole include is `refs/tags/dsh-v<version>`, with no exclusions, unknown applicability conditions or update exception, and explicit `creation`, `update` and `deletion` prohibitions. `current_user_can_bypass` must explicitly be `never` for the publishing principal; missing, unknown or bypass-capable values refuse publication. The helper does not require the administration-only global bypass-actor list: another actor's bypass does not authorize the publisher to recreate a deleted tag. If the workflow token cannot read the required principal-specific evidence, publication remains unavailable; the helper neither requests administration permission nor accepts a protection override.

GitHub's create-release API can implicitly create a missing tag and offers no atomic existing-tag-only precondition. The helper rechecks protection and the original tag object type/SHA, not just its peeled commit, before creation, after draft creation, before finalization and after readback. The workflow mutex does not lock human writers; these reads cannot exclude an administrator concurrently weakening protection or detect deletion followed by restoration of the identical ref object. Operators must separately establish protection and prohibit concurrent rule changes before authorizing publication. No protection or immutable-release setting is claimed without readback.

## Operator inputs

Use the existing workflow's manual event on the exact approved tag, with these inputs. Availability of `workflow_dispatch` on the default branch does not establish that dispatch accepts the new inputs at the selected ref: qualify input handling with publication disabled before publication authorization. This source change neither edits the default branch nor dispatches anything.

| Input | Meaning |
| --- | --- |
| `publish_github_artifacts` | Boolean, default `false`; only explicit `true` enables publication. |
| `version` | Exact approved version above; tag and every dsh manifest must agree. |
| `reviewed_head` | Full final reviewed PR head SHA, checked against GitHub PR/review facts. |
| `merged_commit` | Full merged PR SHA, equal to the peeled tag and Actions checkout SHA. |
| `ci_run_id` | Successful PR-only `ci.yml` run for that final head. |
| `policy_run_id` | Successful `issue-policy.yml` PR run for that final head. |

Inputs select GitHub records; they do not assert approval or success. GitHub may clear a run's `pull_requests` array after merge, so an empty array is accepted only with the independently verified merged PR, exact final head, successful workflow identity and actual tested checkout trees. A nonempty array must contain the governing PR with its exact head and base; missing or malformed arrays are refused. The writer reads classic protection and the PR review decision through a read-only GraphQL query, enforced rulesets through REST, and actual reviews/checks/statuses. It enforces the actual approval count, including zero when none is required, without inventing an external-review requirement. Required checks preserve classic/ruleset app bindings; current results on the head and tested commits, including same-named legacy statuses, cannot contradict success. Required checks and policy must succeed; optional skipped jobs are not treated as failures or as test evidence.

## Source and artifact verification

Actions `head_sha` is not the tested checkout SHA for PR workflows. The writer fetches successful CI job logs, restricts parsing to the known checkout step and its timestamps, and reads checkout's `git log -1 --format=%H` result. Each tested commit must be the PR head or contain that head as a parent; both its complete Git tree and the reviewed head's tree must equal the tag's tree. Missing, expired, ambiguous or unfamiliar checkout evidence refuses publication; there is no operator-supplied tree override and no CI modification to manufacture evidence.

Both fresh dependency-layout and pack jobs must succeed in the publication run. After the existing official build, pack and packed-install commands, `github-artifacts-prepare.ts` uses the official family to validate exact membership, canonical order, root, member and packed versions, filenames, safe archive paths, regular-file types and payload policy. It then creates `release-manifest.json` and `SHA256SUMS` without repacking. Flat artifact files cannot be links, duplicate names, missing members or extras.

The write job downloads only the immutable artifact ID emitted by that same run's pack job. Plain Node runs `github-artifacts.ts publish <directory> <journal>` with no dependency installation. It verifies the ID's source/run facts, the seal, every original hash and the exact file inventory again. The only write-scoped permission is job-local `contents: write`; Actions, checks, PRs and statuses are read-only. PR rehearsals retain per-ref cancellation; publication workflow runs are isolated and non-cancelling, and their write jobs serialize separately.

## Failure and recovery

The writer checks tag identity and absence of any release/draft immediately before its first mutation. It creates a draft prerelease, uploads originals plus order/hash/source-run metadata serially at no more than one mutation per second, then verifies exact remote names, sizes, SHA-256 digests and downloaded bytes before setting `draft: false`, `prerelease: true`, `make_latest: false`. It requires a public repository and repeats asset and tag readback after finalization, then verifies every asset, including the checksum file, through unauthenticated official-host public download URLs. Only public-visibility 404 reads receive retries, at most three total attempts; failure reports publication verification incomplete without repeating a mutation. Immutable-release status is reported only from the actual release readback.

HTTP failures, conflicts, changed tags or assets, and uncertain write outcomes terminate without POST retries, replacement, deletion or automatic resume. Authenticated requests never follow redirects; allowlisted download redirects carry no authorization. The job preserves a credential-free write-intent journal as an Actions artifact even on failure. A failed upload leaves the draft; a finalization timeout may already have published and must not be described as a retained draft without readback.

Rerunning the workflow attempt is refused. A new dispatch also refuses when a previous writer for the same source started, even if no release is yet visible. There is no recovery flag: an operator must reconcile the exact previous run, journal, tag, release and asset bytes before separately authorizing recovery outside this automatic writer. Never rerun a POST to discover whether it succeeded.

## Validation limits

`github-artifacts.spec.ts` exercises real admission/publication logic with fake HTTP, private temporary files, genuine small gzip tarballs and the plain-Node guard entry. Workflow regressions preserve rehearsal routing and enforce the writer's isolation. These tests do not establish live API permissions, dispatch input behavior, retained CI logs, complete builds, packaged installation, tag protection, publication, or runtime acceptance. Those remain prerequisites or later authorized operations, not claims supplied by a green unit test.
