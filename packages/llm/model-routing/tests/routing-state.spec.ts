import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseRoutingPolicy } from '../src/policy.ts'
import { parseRoutingClassifierConfig } from '../src/classifier.ts'
import { applyModelRoutingState, initialModelRoutingState } from '../src/routing-state.ts'
import type { AutoSelection, RoutingTaskDecision, RoutingTaskId } from '../src/routing-state.ts'
import type { RoutingCallId } from '../src/types.ts'
import { modelRoutingProjection, modelRoutingView } from '../src/projection.ts'

function autoSelection(): AutoSelection {
  const floors = { routine: 1, standard: 2, complex: 3 }
  return {
    mode: 'balanced',
    policy: parseRoutingPolicy({
      candidates: [{ id: 'safe', selection: { provider: 'p', model: 'm' }, quality: 3, relativeCost: 1 }],
      qualityFloors: { efficiency: floors, balanced: floors, intelligence: floors },
      minConfidence: 0.8,
      conservativeCandidateId: 'safe',
    }),
    classifier: parseRoutingClassifierConfig({
      selection: { provider: 'p', model: 'small' },
      maxInputBytes: 20000, maxOutputTokens: 300, maxOutputBytes: 10000, timeoutMs: 1000,
    }),
  }
}

function selectedSession() {
  const session = Session.create(SessionId('routing-state'))
  const enabled = session.append('model/auto-selection', autoSelection())
  const state = applyModelRoutingState(initialModelRoutingState(), enabled)
  const decision: RoutingTaskDecision = {
    taskId: brandString<RoutingTaskId>('task'), intentSeq: enabled.seq,
    selection: { provider: 'p', model: 'm' }, candidateId: 'safe', reason: 'quality-floor',
    taskText: 'Private task input',
  }
  return { session, state, decision }
}

describe('durable Auto routing state', () => {
  it('keeps legacy sessions manual and preserves state for unrelated records', () => {
    const session = Session.create(SessionId('legacy'))
    const initial = initialModelRoutingState()
    const header = session.append('request/header', { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' })
    expect(applyModelRoutingState(initial, header)).toBe(initial)
    expect(modelRoutingView(initial)).toEqual({ mode: 'manual', lastDecision: null })
  })

  it('binds actual decisions only to the captured intent and crops task text from transport', () => {
    const { session, state, decision } = selectedSession()
    const bound = applyModelRoutingState(state, session.append('model/routing-decision', decision))
    expect(bound.activeTask).toEqual(decision)
    expect(modelRoutingProjection.stateSchema.parse(bound)).toEqual(bound)
    const view = modelRoutingView(bound)
    expect(view.mode).toBe('balanced')
    expect(view.lastDecision?.selection).toEqual(decision.selection)
    expect(view.lastDecision).not.toHaveProperty('taskText')
    expect(view).not.toHaveProperty('policy')
    expect(JSON.stringify(view)).not.toContain('Private task input')
  })

  it('preserves the classifier audit identity without transporting its private input', () => {
    const { session, state, decision } = selectedSession()
    const classifierCallId = brandString<RoutingCallId>('audited-classifier-call')
    const bound = applyModelRoutingState(state, session.append('model/routing-decision', { ...decision, classifierCallId }))
    const view = modelRoutingView(bound)
    expect(view.lastDecision?.classifierCallId).toBe(classifierCallId)
    expect(view.lastDecision?.selection).not.toBe(bound.activeTask?.selection)
    expect(view.lastDecision).not.toHaveProperty('taskText')
    expect(modelRoutingProjection.wire.viewSchema.parse(view)).toEqual(view)
  })

  it('does not let an earlier in-flight decision overwrite a newer manual choice', () => {
    const { session, state, decision } = selectedSession()
    const manual = applyModelRoutingState(state, session.append('model/selection', { provider: 'manual', model: 'chosen' }))
    const after = applyModelRoutingState(manual, session.append('model/routing-decision', decision))
    expect(after).toBe(manual)
    expect(after).toEqual(initialModelRoutingState())
  })

  it('does not let an earlier decision consume a newer Auto revision', () => {
    const { session, state, decision } = selectedSession()
    const newer = applyModelRoutingState(state, session.append('model/auto-selection', { ...autoSelection(), mode: 'intelligence' }))
    expect(applyModelRoutingState(newer, session.append('model/routing-decision', decision))).toBe(newer)
    expect(modelRoutingView(newer)).toEqual({ mode: 'intelligence', lastDecision: null })
  })

  it('clears inherited task policy at a fork marker but preserves ordinary resume', () => {
    const { session, state, decision } = selectedSession()
    const bound = applyModelRoutingState(state, session.append('model/routing-decision', decision))
    expect(applyModelRoutingState(bound, session.append('session/end-seed', {}))).toBe(bound)
    expect(applyModelRoutingState(bound, session.append('session/end-seed', { inherited: true }))).toEqual(initialModelRoutingState())
  })

  it('rejects malformed cached policy and classifier settings', () => {
    const { state } = selectedSession()
    if (state.intent.kind !== 'auto') throw new Error('Auto state absent')
    const badPolicy = {
      ...state,
      intent: { ...state.intent, selection: {
        ...state.intent.selection, policy: { ...state.intent.selection.policy, minConfidence: 2 },
      } },
    }
    const badClassifier = {
      ...state,
      intent: { ...state.intent, selection: {
        ...state.intent.selection, classifier: { ...state.intent.selection.classifier, timeoutMs: 0 },
      } },
    }
    expect(() => modelRoutingProjection.stateSchema.parse(badPolicy)).toThrow()
    expect(() => modelRoutingProjection.stateSchema.parse(badClassifier)).toThrow()
  })
})
