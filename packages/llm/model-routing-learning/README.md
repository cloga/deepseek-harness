---
description: "Local-only adaptive routing evidence, profile-owned storage and bounded task-work accounting."
kind: "package-library"
---

# @deepseek-ai/dsh-model-routing-learning

English | [中文](README.zh.md)

## Summary

Use this library to retain closed local routing evidence under explicit profile ownership and evaluate measured task work without inventing missing costs or success labels. The storage entry point is `openLearningStore(ctx, config)`. Revision and epoch checks protect queued updates; a lifetime ownership lock excludes competing processes. These foundations do not mount a plugin, collect user history, expose a browser API or activate a learned strategy by themselves.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Import [the module entry](src/index.ts) from a Host owner that already has the [storage-domain](../../storage/storage-domain/README.md) capability. Supply a deployment-owned `profileKey`, absolute `ownershipLockPath`, acquisition wait budget and explicit ledger limits. Every process using the same profile/domain must use the same ownership path. No environment variable or current directory is treated as profile authority.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { openLearningStore } from '@deepseek-ai/dsh-model-routing-learning'
import type { LearningStoreConfig } from '@deepseek-ai/dsh-model-routing-learning/types'

declare const ctx: Pick<Context, 'storageDomain'>
declare const config: LearningStoreConfig

const opened = await openLearningStore(ctx, config)
if (opened.available) {
  try {
    const snapshot = opened.store.read()
    // Use snapshot.revision and snapshot.epoch for an owned transaction.
  } finally {
    await opened.store.close()
  }
}
```

An unavailable lease returns an explicit result; malformed durable data rejects rather than resetting history. Close stops write admission, drains the domain and releases ownership. Clearing advances the epoch so pre-clear asynchronous work cannot repopulate erased records with stale authority. No Session log, global setting or feedback-upload event is written.

`LearningController` accepts closed IDs and ledger stamps for evaluation, approval, rollback, disable and clear. It reconstructs evidence from server-owned sealed records and rechecks current configuration, cohort, context revision, eligibility, source revisions and expiry. A retained proposal is not sufficient when its supporting cohort changed; active overlays fail closed to the base policy until reevaluated. Versions are bounded overlays of the stable human base, not compounded self-edits. The browser must not supply observations or weights as authority.

`TaskWorkAccounting` is a bounded arithmetic/lifetime helper, not an automatic collector. Producer owners reserve operation leases before awaits, account for every actual attempt, and supply strictly normalized full-call token totals under a fixed explicit metric revision. Failed calls are not free. Missing usage, unknown routes, pending work, unsupported coverage or interrupted observation make work incomplete. Sealing does not supply a task-success verdict.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The single profile ledger stores bounded scopes, task facts, immutable proposals and immutable versions. Updates validate closed schemas and compare revision/epoch inside the durability-first storage queue. Active versions must retain their matching proposal. Proposal configuration and context revision stamps prevent content-equal configuration changes from silently reusing stale authority.

| Source | Responsibility |
|---|---|
| [Types](src/types.ts) | Closed local records without prompts, code or arbitrary diagnostics. |
| [Schema](src/schema.ts) | Identity, reference, count and byte constraints. |
| [Store](src/store.ts) | Lifetime exclusive lease and queued durable CAS operations. |
| [Work accounting](src/work-accounting.ts) | Complete-coverage requirement and bounded weighted-token arithmetic. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Routing policy](../model-routing/README.md) — strict candidate selection and the separate evidence evaluator.
- [LLM runtime](../llm/README.md) — actual adapter-attempt observations and their limits.
- [Storage-domain](../../storage/storage-domain/README.md) — durable-first transactions, not cross-process CAS.

<a id="model-experience"></a>
## Model Experience

None, as this library registers no prompt, tool, model call or model-visible Session event.

#### KV Cache effect

No direct effect: the library does not assemble or dispatch model requests. Consumers own any later route change and its cache consequences.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Not an installed learning product** — trusted producer attribution, local outcome APIs, scheduled evaluation and settings UI require a higher runtime owner.
- **Explicit deployment isolation** — a profile key and consistent ownership-lock location are required; stale locks are not silently stolen.
- **Incomplete evidence stays unknown** — ordinary turn completion, model self-report, manual model choice and silence are not verified success labels.
- **No savings guarantee** — work metrics are explicit comparison weights, not currency, and observational evidence does not prove causal quality or cost improvements.

<a id="dev-note"></a>
### Dev Note

Keep local outcomes separate from telemetry-authorizing feedback events. Do not weaken ownership, CAS, immutable evidence or completeness checks to make a policy proposal appear. The router remains a lower dependency: this package may consume routing, but routing must not import this higher evidence owner.
