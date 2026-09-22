# Agent Note: Host-owned task-aware Auto model routing

Status: proposed

English | [中文](2026-09-21-task-aware-auto-routing.zh.md)

## Problem

A fixed conversation model makes callers choose cost and reasoning capacity before the task is understood. Replacing that choice with three fixed model aliases does not solve task-aware routing. Switching on every tool step can instead lose a reusable history prefix, inherit an incompatible reasoning effort, and make the interface report a requested model rather than the route actually used.

Child delegation already has route defaults, explicit user-authorized selection, and cache-sensitive fork behavior. A second independent Auto selector would create competing precedence rules. Learning preferences from a few apparently successful answers would introduce another problem: cheap, easy tasks and difficult, failed tasks are not comparable evidence of model quality.

## Proposal

Issue #113 proposes Host-owned Auto modes `efficiency`, `balanced`, and `intelligence`, with explicit manual override, task-scoped route affinity, truthful model-and-reason presentation, and coordinated child routing. The foundation contains an asynchronous selection hook, deterministic candidate policy, bounded audited classifier, configuration parsers, and initial routing-state types. These pieces do not establish a shipped end-to-end Auto feature. Recovery, independent review, and personalization below remain design requirements, not implemented capabilities.

A Host owner should resolve task routing before prompt assembly captures provider/model variables. The existing selection helper should apply that same resolved route to the request and route-change notice. The browser should submit intent and render committed facts; it must not choose a model independently. The LLM runtime should retain exact-route validation and registration-bound preparation.

### Durable intent and actual use

A concrete `model/selection` remains manual intent. An explicit `model/auto-selection` should capture the selected mode and credential-free candidate/classifier policy, so a later settings edit cannot silently change an active task. Legacy Sessions without Auto intent should remain manual. The synchronous selection query must remain side-effect-free: it can expose the configured or pinned concrete route, but cannot predict an unresolved classification.

Classification produces a proposal, not proof of use. An actual conversation dispatch should bind the task id, intent revision, concrete provider/model/effort, and explanation to the resolved request. Pending manual changes must remain pending if an older classifier finishes later. A new task selecting the same route still needs a decision record even when no new request header is necessary. Failed admission must not publish a fictitious actual route.

New ordinary event types can preserve existing event payloads; changing an existing payload or Session envelope still requires the repository's persistence review. Read-only projections, cold restore, fork seed ownership, request reconstruction, and unknown-event handling must agree. Model-visible classifier input must be reconstructable from the exact request audit, not from a later prompt template.

### Task-aware selection and cache affinity

The classifier should inspect only byte-bounded task text and the prior task description. Its closed response describes continuity, complexity, confidence, and a reason code; it never chooses a provider or model id. The Host should select only eligible curated provider/model/effort candidates using configured quality floors and relative cost weights. Every mode must remain task-aware: a difficult task can require a stronger route even in `efficiency`, while uncertain evidence cannot justify downgrading an active strong route.

Tool continuations, transport retries, injected context, and background completion notices should not independently trigger classification or route churn. A recognized task should retain provider, model, and effort. Confidently new work, explicit user selection, or separately authorized recovery can create a route boundary. A turn boundary, compaction event, or request-series boundary alone is not proof of a new task. Preserving prefix eligibility is not a promise that a provider retains or reuses KV Cache.

The loop-free hook resolves claimed input before downstream pre-step rewriting. Integration must either document this classification input precisely or add an explicit admission mechanism for classifying rewritten input. It must not quietly claim to classify accepted text that the classifier never saw.

### One child route-resolution chain

The deterministic parent-model-to-child-model work in PR #95 is an integration dependency, not a second selector and not evidence that its behavior is already present on master. The unified resolver must preserve explicit request/configuration and provider-owned default precedence, apply an eligible deterministic parent rule, use task-aware Auto only where no higher-priority rule decides, and retain ordinary inheritance as the fallback. The winning source must remain inspectable after the concrete route is resolved.

No branch may bypass the existing exact-route authorization, adapter effort validation, provider capability declaration, cancellation, or provider-generation checks. A denied explicit choice must fail, not become permission to select another route. Registered or advertised models are not implicitly authorized. Native external providers without child `agentOptions` support must not be labeled Host-routed.

Fresh eligible spawn children may receive a separately classified delegated task. Fork children retain the inherited concrete route to protect the copied prefix. Resumed children retain their recorded concrete selection rather than being reclassified from the parent's current settings. Existing children are not retroactively enrolled in Auto. Child-owned task ids and decisions must not accidentally adopt a parent task record from an inherited seed.

### Auditable auxiliary calls and overhead

Each dispatched classifier call must record the exact effective configuration, system text, owned messages, and bounded task metadata before streaming. Its settlement should retain the bounded compact stream prefix, a closed outcome, and any observed usage. Oversized rejected chunks and arbitrary provider error details must not enter the retained result. Cancellation must settle audit state before propagating, while a timeout should become an explicit conservative-selection input. Missing usage remains unknown, not zero cost.

Classifier, review, and recovery calls add latency and may incur API charges. Their usage must remain separately attributable without changing the conversation's context-pressure numerator. Keyless replay must reproduce auxiliary calls in their actual order, including rejected and truncated outcomes; it must not consume the next conversation response or silently call a live classifier. Dollar savings require actual pricing evidence and comparable measurements, not relative policy weights.

### Bounded recovery and independent review

The proposed recovery owner should use explicit attempt, elapsed-time, token, and output limits. A failure should retain the original evidence, identify the failed route and policy version, and distinguish provider unavailability from inadequate task results. Recovery must preserve manual choices and hard authorization constraints. Any permitted same-task route escalation must be an explicit logged exception to cache affinity, with its additional work and terminal refusal visible.

Independent evaluation should use fresh read-only reviewers on configured distinct model routes. Each reviewer should receive the same bounded immutable task, acceptance criteria, and candidate result, not the producing agent's private reasoning or another reviewer's verdict. Review tools must not modify files, permissions, policies, or the candidate being assessed. Reviewer disagreement, unavailable routes, malformed verdicts, and exhausted budgets should yield a bounded unresolved outcome rather than an unbounded voting loop or an invented consensus.

These reviewers are proposed design-stage and recovery mechanisms. Running multiple model names is not proof of provider independence or correctness, and a favorable review cannot replace deterministic tests or user acceptance.

### Evidence-based local personalization

Personalization must use structured local outcome records, not silently rewrite prompts or treat every completed response as success. A record should identify the task class, mode, policy version, actual route and effort, context/cache conditions, execution and review outcomes, observed usage and latency, explicit user corrections when supplied, and measurement source. Missing or incomparable outcomes must remain unknown. Storage needs explicit retention and export controls; policy learning must not require copying unrestricted transcripts or credentials.

A candidate policy should require sufficient comparable evidence under configured sample and uncertainty thresholds. Evaluation must account for task difficulty, route availability, provider/model changes, and unequal cache conditions; it must not compare easy cheap requests with difficult expensive requests as if they were interchangeable. Hard authorization, manual precedence, fork/resume rules, capability limits, and maximum budgets remain protected constraints, never optimization targets.

The adaptation lifecycle should record an immutable candidate version, its baseline and evidence window, bounded shadow evaluation, acceptance or rejection reasons, and an explicit promotion. Shadow evaluation must not change production routing. Promotion may affect only newly admitted tasks through a recorded version-adoption decision; it must not mutate captured active-task policy or a fixed child. Rollback selects a previous approved version for future tasks and preserves the historical decisions and evidence. Sparse evidence, regressions, or disagreement retain the last approved baseline.

### Relationship to existing decisions

The supersession check retains [model-visible switch notices](../../implemented/feature/2026-09-07-model-switch-notice.md), [user-authorized subagent routes](../../implemented/feature/2026-08-24-user-authorized-subagent-model-routes.md), and [model-selected subagent routes](../../implemented/feature/2026-08-18-model-selected-subagent-routes.md). Their notice semantics, security decisions, and fork restrictions still constrain this proposal. This note complements rather than replaces them; no implemented triplet qualifies for archival.

## Alternatives considered

**Three static model aliases.** They expose preferences but do not adjust to task requirements and would overstate the meaning of Auto.

**An independent child Auto selector.** Competing with the explicit/default/parent-rule resolver makes precedence and permission enforcement ambiguous. Auto belongs inside the existing resolution chain.

**Classify or downgrade after every model call.** Repeated auxiliary calls increase overhead and can invalidate a useful prefix during one coherent task. Affinity with explicit exceptions is preferable.

**Let the classifier return arbitrary routes.** Task text and model output are untrusted inputs, while candidate eligibility and reasoning-effort support are Host responsibilities.

**Learn immediately from answer completion or reviewer approval.** Completion is not an observed successful outcome, and reviewer votes are neither independent ground truth nor comparable cost evidence. Versioned evaluation and controlled promotion are required.

## Acceptance criteria

- Real composed Sessions demonstrate task-dependent choices within each mode, manual override, truthful pending-versus-actual presentation, and stable provider/model/effort across a task's tool loop.
- Cancellation, failed assembly, rejected input, concurrent manual selection, unchanged-route new tasks, unavailable candidates, and provider-generation changes preserve authoritative intent and audit facts.
- Parent-rule and Auto integration uses one resolver; direct service callers cannot evade route authorization, and fork, resume, explicit child overrides, and unsupported transports retain their stated behavior.
- Durable restore and keyless parent/child snapshots include classifier request/result ordering, actual-route decisions, failures, and separately attributable auxiliary usage without changing conversation context pressure.
- Bounded recovery and fresh read-only multi-model reviewers exercise disagreement, malformed output, exhausted budgets, cancellation, and terminal refusal without changing protected rules.
- Personalization tests reject sparse or incomparable evidence, pin candidate and baseline versions, run shadow evaluation without production effects, promote only at new-task admission, and demonstrate rollback without rewriting history.
- Documentation, persistence acknowledgements, generated contracts, focused tests, and real-composition evidence match the exact implemented scope before this note moves to `implemented/`.

## Risks

Classification and review can cost more than the route choice saves, leak task content to another configured provider, or misread malicious instructions despite framing. Explicit budgets, authorized routes, exact audit, and conservative failure handling reduce these risks but do not establish model correctness. Provider caching and internal model aliases remain outside the Host's guarantees.

Recovery can mask a genuine capability or permission failure if precedence is weakened. Personalization can amplify biased or stale feedback, overfit small samples, or introduce undocumented behavior changes. The proposal accepts slower promotion and fewer automatic switches in exchange for inspectable evidence, protected constraints, and rollback. The current foundation is not completion of these requirements.
