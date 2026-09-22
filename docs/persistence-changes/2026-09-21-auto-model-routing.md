---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-21-auto-model-routing

English | [中文](2026-09-21-auto-model-routing.zh.md)

## Summary

Adds explicit Auto intent, classifier request/result audits, confirmed conversation routing decisions, separate child delegation preferences, and resolved native child selections.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-auto-model-routing
baseline: false
changes:
  - root: "event:model/auto-selection"
    previous: null
    after: "dfbe37452791c72e41816096643f1d0fe7cdfcb416b9dac8c740789aacf6d220"
    decision: same-version
  - root: "event:model/delegation-auto"
    previous: null
    after: "461046735139728f1163b3f602502c2a1c708cc258bd5bf799bf4523dc53bf2e"
    decision: same-version
  - root: "event:model/routing-decision"
    previous: null
    after: "a33ebc4f7d89c44c1d5d8a126ea879d60d8aec21542f071a3e171e3d592f9eec"
    decision: same-version
  - root: "event:model/routing-request"
    previous: null
    after: "552783b494452ece9ff0b444318d0e65f26566357784859435e1f5509dd8bcc7"
    decision: same-version
  - root: "event:model/routing-result"
    previous: null
    after: "448e11a7f21a52ee38d0df164f0ebb66c0cb92d2155cf7bc7f70c86467d9850e"
    decision: same-version
  - root: "event:subagent/model-selection"
    previous: null
    after: "9d7a8cfe9d981c8fae6424d3d6e6bf66a5eeb20dc553565818c9d6954e774c8c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

These are ordinary additive log-only events. Existing version-3 headers, envelopes, message surfaces, manual selections, and captured child-model permission records are unchanged. Sessions without Auto records retain manual or inherited routing. Auto intent and delegation preferences are required on read: an older build that does not know these event types refuses the log rather than silently resuming with different routing. The installed current reader uses the regenerated known-event vocabulary; released codecs and historical generations are not modified. Projection cache revisions change independently where fold behavior changes.

<a id="verification"></a>
## Verification

The focused routing runtime suite passed 54 tests covering manual and asynchronous selection, captured delegation, isolation, cancellation and teardown. A real Loader plus shipping AgentLoop test verifies prompt/model/effort/decision agreement. The replay suites passed 175 tests, including file-backed classifier replay through current-format readers and explicit refusal of malformed or unreconstructable audits. API tests passed 28 cases; native child selection and persistent lifecycle tests separately cover authorization, descriptor consistency and unchanged resume. Full product qualification remains a separate required step.

<a id="dev-note"></a>
## Dev Note

None.
