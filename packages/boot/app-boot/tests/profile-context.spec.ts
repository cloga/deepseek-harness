import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readProfilePatches, resolveTelemetryPatch, type ProfileContext } from '../src/profile-context.ts'
import type { Profile } from '../src/profile.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it.each(['0', 'false', 'disabled'])('treats any nonempty inherited telemetry opt-out %s as disabled', value => {
  expect(resolveTelemetryPatch(value, true)).toEqual({ id: 'session-telemetry-otel', disabled: true })
  expect(resolveTelemetryPatch(value, false)).toBeUndefined()
})

it('does not create a telemetry patch for an absent or empty opt-out', () => {
  expect(resolveTelemetryPatch(undefined, true)).toBeUndefined()
  expect(resolveTelemetryPatch('', true)).toBeUndefined()
})

it('copies launch overlays before applying the telemetry hard-disable to a loaded profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-context-'))
  roots.push(home)
  const dir = join(home, 'profiles', 'test')
  const telemetry = { insert: [{ id: 'session-telemetry-otel', name: 'telemetry' }] }
  const profile: Profile = {
    name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), patchReload: 'live',
    layers: [{ packageName: 'fixture', packageDir: home, patchPath: join(home, 'layer.yml'), patches: [telemetry] }],
    patches: [{ id: 'session-telemetry-otel', disabled: false }],
  }
  const context: ProfileContext = {
    name: 'test', dir, patchPath: profile.patchPath, installAnchor: join(home, 'runtime', 'package.json'),
    cwd: home, home, startedBundles: ['fixture'], overlays: [{ id: 'session-telemetry-otel', disabled: false }],
    telemetryDisabledEnv: 'false',
  }
  const patches = readProfilePatches('test', context, profile)
  expect(patches).toHaveLength(4)
  expect(patches.at(-1)).toEqual({ id: 'session-telemetry-otel', disabled: true })
  patches[2]!.disabled = true
  expect(context.overlays[0]?.disabled).toBe(false)
  expect(profile.patches[0]?.disabled).toBe(false)
  expect(readProfilePatches('test', { ...context, telemetryDisabledEnv: undefined }, profile).at(-1))
    .toEqual({ id: 'session-telemetry-otel', disabled: false })
})
