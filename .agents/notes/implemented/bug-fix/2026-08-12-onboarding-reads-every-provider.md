# Agent Note: First-run readiness reads every provider, and the setup card closes

Status: implemented

English | [中文](2026-08-12-onboarding-reads-every-provider.zh.md)

## Problem

The first-run step and the Models page both asked one question — is `deepseek-official`'s credential stored? — of a join that describes every provider. Two defects followed from that single reading.

A user who configured some other provider (a pi-ai gateway, a self-hosted route) and never wanted the official DeepSeek endpoint was taken over by the full-screen credential prompt on every blank session, with a working model already selected in the composer behind it. Nothing they could do short of storing a DeepSeek key would end it, because the step's readiness projection never looked at the row they had configured.

On the Models page the same reading opened the DeepSeek setup card over them on every visit, and that card could not be closed: it was rendered from row data with no local state a Cancel could flip, so its Cancel button did nothing visible. Worse, it shared the row-editor/add/declare close handler, which unconditionally clears all three of those states — so cancelling the card that owned none of them discarded the add card's draft while staying open itself.

## Decision

One predicate answers what both surfaces actually need. `providerUsable(row)` is true when the route is registered with the adapter registry (`entry.active`), a configurable route's profile resolves in its owning namespace, and whatever credential that profile names is stored. A configured profile naming no reference authenticates through the provider's own path. A live route with no settings address also needs no profile from this join, so neither owes this page a key. Requiring a resolved profile prevents a directory-only or cross-generation row from being mistaken for a usable custom provider.

`onboardingReadiness` (renamed from `deepSeekReadiness`, which no longer describes what it reads) returns `provider-ready` as soon as any joined row is usable. Only a user with none of those reaches the route this onboarding registrant can repair. The registrant passes its provider id; the matching directory row supplies the settings namespace and path, so readiness does not repeat provider or model-family names. A missing or unresolved target profile is adapter-absent because the credential-only prompt cannot create it.

`needsSetup(row, anyUsable)` takes the same fact, so the setup card is the first-run posture alone. With another provider reachable, the optional route is an ordinary unmarked row, one Edit click from the same card. A red missing-credential dot appears only while no configured provider is usable; this keeps a missing optional key from presenting the whole product as broken.

Each card kind now owns its own close handler. `closeSetup` records the provider in a component-local `dismissedSetup` set and touches nothing else; `closeEditor` keeps clearing the three states its cards own. Both route the post-save reload through one `announceSaved` helper. Dismissal is viewing state, like the open editor and the add card: a reload restores the first-run posture for a user still in it.

## Alternatives considered

- **Deriving readiness from the model catalog (`llm.models`) instead of the join.** It answers "can the user talk to something" most directly, but it costs a per-provider listing round trip on a surface that already holds the join, and a provider whose listing fails transiently would re-open onboarding.
- **Requiring `row.configured` for every route.** It would exclude routes mounted without a configurable-provider declaration. The predicate requires a resolved profile only when the directory gives the route a settings address; address-free live routes remain usable from registration alone.
- **Only adding the dismissal, leaving the card auto-opening.** It fixes the Cancel button and nothing else: a user with a working provider would still be handed the DeepSeek form on every visit to Models, which is the same misreading in a quieter form.
- **Persisting the dismissal to settings.** A durable "do not ask about DeepSeek" flag is a second fact about first-run state that can disagree with the join. The credential itself already ends the posture permanently, and every other card on this page is session-local.

## Consequences

Onboarding ends for reasons the target route knows nothing about, while the target lookup follows the registrant id and directory metadata instead of fixed provider or namespace names. The Models page still exposes confirmed configured credentials per row, but it reserves red for a missing credential that leaves the user without any usable provider.

## Testing

Package tests pin configured custom providers, address-free live routes, directory-only rows, named credential misses, and every onboarding diagnostic. Component tests cover the first-run posture, the unmarked optional row, and the cancel that collapses the setup card while the add card keeps its draft. The `onboarding-usable-provider` web e2e lane configures another provider through the real wire, reloads without takeover, and confirms that the still-keyless optional route has no red error icon.
