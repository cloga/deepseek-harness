import { describe, expect, it } from 'vitest'
import {
  parseDesktopPackageCommandOrigin,
  parseDesktopPackageSelectionMutation,
  parseDesktopPackageSelectionRequest,
  parseDesktopRegistryUpdate,
} from '../src/profile-package-command.ts'

const generation = '12345678-90ab-cdef-1234-567890abcdef'
const origin = () => ({ kind: 'desktop-command', generation, requestId: 1, commandId: 'command-1' })
const request = () => ({ names: ['z-plugin', '@scope/plugin', 'a-plugin'], enabled: false })
const mutation = () => ({ kind: 'selection', packageNames: ['@scope/plugin', 'a-plugin', 'z-plugin'], enabled: true })

describe('shell-private command origin data', () => {
  it('snapshots exact origin fields without granting or checking live command authority', () => {
    const input = origin()
    const parsed = parseDesktopPackageCommandOrigin(input)
    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    input.generation = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    input.requestId = 2
    input.commandId = 'changed'
    expect(parsed).toEqual(origin())
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it.each([1, Number.MAX_SAFE_INTEGER])('accepts positive safe request ID %s', (requestId) => {
    expect(parseDesktopPackageCommandOrigin({ ...origin(), requestId }).requestId).toBe(requestId)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null, undefined])(
    'rejects invalid request ID %s', (requestId) => {
      expect(() => parseDesktopPackageCommandOrigin({ ...origin(), requestId })).toThrow('command origin')
    },
  )

  it.each(['', generation.toUpperCase(), `{${generation}}`, `${generation}\n`, 'not-a-generation', null, 12])(
    'rejects noncanonical generation %s', (value) => {
      expect(() => parseDesktopPackageCommandOrigin({ ...origin(), generation: value })).toThrow('command origin')
    },
  )

  it.each(['x', 'x'.repeat(256), '\n'])('preserves the exact admitted command ID without normalization', (commandId) => {
    expect(parseDesktopPackageCommandOrigin({ ...origin(), commandId }).commandId).toBe(commandId)
  })

  it.each(['', 'x'.repeat(257), null, 42, [], undefined])('rejects malformed command ID %s', (commandId) => {
    expect(() => parseDesktopPackageCommandOrigin({ ...origin(), commandId })).toThrow('command origin')
  })

  it.each([null, [], 'origin', {}, { ...origin(), kind: 'ordinary' }, { ...origin(), extra: true }])(
    'rejects malformed origin record %j', (value) => {
      expect(() => parseDesktopPackageCommandOrigin(value)).toThrow()
    },
  )
})

describe('selection request and stored mutation', () => {
  it('canonicalizes only the owned request snapshot, never the caller array', () => {
    const input = request()
    const parsed = parseDesktopPackageSelectionRequest(input)
    expect(parsed).toEqual({ names: ['@scope/plugin', 'a-plugin', 'z-plugin'], enabled: false })
    expect(input.names).toEqual(['z-plugin', '@scope/plugin', 'a-plugin'])
    expect(parsed.names).not.toBe(input.names)
    input.names[0] = 'changed'
    input.enabled = true
    expect(parsed).toEqual({ names: ['@scope/plugin', 'a-plugin', 'z-plugin'], enabled: false })
    expect(Object.isFrozen(parsed.names)).toBe(true)
  })

  it('admits all only as a disable request and never as a concrete stored target list', () => {
    expect(parseDesktopPackageSelectionRequest({ names: 'all', enabled: false })).toEqual({ names: 'all', enabled: false })
    expect(() => parseDesktopPackageSelectionRequest({ names: 'all', enabled: true })).toThrow('enable-all')
    expect(() => parseDesktopPackageSelectionMutation({ kind: 'selection', packageNames: 'all', enabled: false })).toThrow()
  })

  it('takes an independent concrete mutation snapshot and refuses stored order drift', () => {
    const input = mutation()
    const parsed = parseDesktopPackageSelectionMutation(input)
    expect(parsed).toEqual(input)
    expect(parsed.packageNames).not.toBe(input.packageNames)
    input.packageNames.reverse()
    input.enabled = false
    expect(parsed).toEqual(mutation())
    expect(Object.isFrozen(parsed.packageNames)).toBe(true)
    expect(() => parseDesktopPackageSelectionMutation(input)).toThrow('noncanonical')
  })

  it.each([1, 100])('admits exactly %s concrete targets', (count) => {
    const names = Array.from({ length: count }, (_, index) => `plugin-${String(index).padStart(3, '0')}`)
    expect(parseDesktopPackageSelectionRequest({ names, enabled: true }).names).toEqual(names)
    expect(parseDesktopPackageSelectionMutation({ kind: 'selection', packageNames: names, enabled: false }).packageNames).toEqual(names)
  })

  it.each([
    [], Array.from({ length: 101 }, (_, index) => `plugin-${index}`), ['same', 'same'],
    [''], ['Uppercase'], ['@scope'], ['@scope/name/extra'], ['../escape'], ['a\nb'], ['a\u0000b'],
    ['plugin@1.0.0'], ['https://host/package'], ['github:owner/repo'], ['file:./package'],
    ['x'.repeat(215)], [null], [12], [undefined], 'plugin', {}, null,
  ])('rejects invalid targets %j in request and mutation', (names) => {
    expect(() => parseDesktopPackageSelectionRequest({ names, enabled: false })).toThrow()
    expect(() => parseDesktopPackageSelectionMutation({ kind: 'selection', packageNames: names, enabled: true })).toThrow()
  })

  it('accepts the exact maintained package-name boundary', () => {
    const names = ['@scope/pkg._~-', 'x'.repeat(214)]
    expect(parseDesktopPackageSelectionRequest({ names, enabled: false }).names).toEqual(names)
    expect(parseDesktopPackageSelectionMutation({ kind: 'selection', packageNames: names, enabled: true }).packageNames).toEqual(names)
  })

  it.each([null, undefined, 0, 1, 'false', 'true', {}])('rejects nonboolean enablement %j', (enabled) => {
    expect(() => parseDesktopPackageSelectionRequest({ names: ['a'], enabled })).toThrow()
    expect(() => parseDesktopPackageSelectionMutation({ kind: 'selection', packageNames: ['a'], enabled })).toThrow()
  })

  it.each([null, [], {}, { names: ['a'], enabled: false, extra: true }, { packageNames: ['a'], enabled: false }])(
    'rejects malformed selection request %j', (value) => {
      expect(() => parseDesktopPackageSelectionRequest(value)).toThrow()
    },
  )

  it.each([null, [], {}, { ...mutation(), kind: 'install' }, { ...mutation(), extra: true }, { names: ['a'], enabled: false }])(
    'rejects malformed stored mutation %j', (value) => {
      expect(() => parseDesktopPackageSelectionMutation(value)).toThrow()
    },
  )

  it('rejects sparse, accessor and decorated arrays without reading accessor values', () => {
    let reads = 0
    const accessor = ['a']
    Object.defineProperty(accessor, '0', { get() { reads++; return 'a' } })
    const extra = Object.assign(['a'], { extra: true })
    const symbol = Object.assign(['a'], { [Symbol('extra')]: true })
    for (const names of [new Array(1), accessor, extra, symbol]) {
      expect(() => parseDesktopPackageSelectionRequest({ names, enabled: false })).toThrow()
      expect(() => parseDesktopPackageSelectionMutation({ kind: 'selection', packageNames: names, enabled: false })).toThrow()
    }
    expect(reads).toBe(0)
  })
})

describe('exact private record fields', () => {
  for (const [name, create, parse] of [
    ['origin', origin, parseDesktopPackageCommandOrigin],
    ['request', request, parseDesktopPackageSelectionRequest],
    ['mutation', mutation, parseDesktopPackageSelectionMutation],
  ] as const) {
    it(`rejects inherited, absent, symbolic, hidden and accessor ${name} fields`, () => {
      const value = create()
      const keys = Object.keys(value)
      const key = keys[0]!
      const missing = { ...value }
      Reflect.deleteProperty(missing, key)
      const hidden = { ...value }
      Object.defineProperty(hidden, key, { enumerable: false })
      let reads = 0
      const accessor = { ...value }
      Object.defineProperty(accessor, key, { get() { reads++; throw new Error('must not execute') } })
      const inherited: unknown = Object.create(value)
      for (const candidate of [inherited, missing, { ...value, [Symbol('extra')]: true }, hidden, accessor]) {
        expect(() => parse(candidate)).toThrow()
      }
      expect(reads).toBe(0)
    })
  }
})

describe('registry-only update grammar', () => {
  it.each(['0.0.0', '1.2.3', '1.2.3-alpha.2', '1.2.3-0', '10.20.30-rc.1',
    '1.2.3+build', '1.2.3-alpha.2+build.001', '1.2.3+Build-12', `1.2.3+${'a'.repeat(250)}`])('accepts canonical version %s', (version) => {
    expect(parseDesktopRegistryUpdate('@scope/plugin', version)).toEqual({ kind: 'registry-update', name: '@scope/plugin', version })
  })

  it.each(['', 'v1.2.3', 'V1.2.3', '=1.2.3', ' 1.2.3', '1.2.3\n', '^1.2.3', 'latest', '1.2', '01.2.3',
    'github:owner/repo', 'file:./plugin', 'https://host/package', '1.2.3+', '1.2.3++build', '1.2.3+build+extra',
    '1.2.3+build ', '1.2.3+build\n', '1.2.3+build number', '1.2.3-01+build', 'v1.2.3+build', '=1.2.3+build',
    `1.2.3+${'a'.repeat(251)}`, null, 123, undefined])(
    'rejects ranges, sources and normalized version %j', (version) => {
      expect(() => parseDesktopRegistryUpdate('plugin', version)).toThrow('registry update version')
    },
  )

  it.each(['', '@scope/plugin@1.2.3', 'plugin@1.2.3', 'github:owner/repo', 'file:./plugin', '../plugin', 'a\nb', null])(
    'rejects source selectors as package name %j', (name) => {
      expect(() => parseDesktopRegistryUpdate(name, '1.2.3')).toThrow('package name')
    },
  )
})
