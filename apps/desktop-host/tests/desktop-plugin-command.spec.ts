import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopPluginCommandDefinition,
  formatDesktopPluginListRows,
  parseDesktopPluginCommand,
  registerDesktopPluginCommand,
  registerDesktopPluginCommandRuntime,
  type DesktopPluginCommandDefinition,
  type DesktopPluginCommandRuntime,
} from '../src/desktop-plugin-command.ts'

describe('parseDesktopPluginCommand', () => {
  it.each([
    [' list ', { type: 'list' }],
    ['install npm example-plugin', { type: 'install', source: { type: 'npm', spec: 'example-plugin' } }],
    ['install npm @scope/example-plugin@^1.2.0', { type: 'install', source: { type: 'npm', spec: '@scope/example-plugin@^1.2.0' } }],
    ['install npm example-plugin@>=1 <2', { type: 'install', source: { type: 'npm', spec: 'example-plugin@>=1 <2' } }],
    ['install npm example-plugin@1.2.3 - 2.3.4', { type: 'install', source: { type: 'npm', spec: 'example-plugin@1.2.3 - 2.3.4' } }],
    ['install npm @scope/example-plugin@next', { type: 'install', source: { type: 'npm', spec: '@scope/example-plugin@next' } }],
    ['install github owner/repo#feature/ref', { type: 'install', source: { type: 'github', spec: 'owner/repo#feature/ref' } }],
    ['remove @scope/example-plugin', { type: 'remove', name: '@scope/example-plugin' }],
    ['update example-plugin 2.0.0-beta.1', { type: 'update', name: 'example-plugin', version: '2.0.0-beta.1' }],
    ['enable example-plugin', { type: 'enable', name: 'example-plugin' }],
    ['disable @scope/example-plugin', { type: 'disable', name: '@scope/example-plugin' }],
    ['disable-all', { type: 'disable-all' }],
  ])('parses %j', (rawInput, expected) => {
    expect(parseDesktopPluginCommand(rawInput)).toEqual(expected)
  })

  it('parses release JSON without interpreting its verified-release fields', () => {
    expect(parseDesktopPluginCommand('install release {"owner":"example","asset":{"id":7}}')).toEqual({
      type: 'install',
      source: { type: 'release', release: { owner: 'example', asset: { id: 7 } } },
    })
  })

  it.each([
    '',
    'list now',
    'disable-all now',
    'install npm ./plugin',
    'install npm ../plugin',
    'install npm C:\\plugin',
    'install npm /tmp/plugin',
    'install npm \\\\server\\share\\plugin',
    'install npm file:plugin',
    'install npm link:plugin',
    'install npm alias@npm:example-plugin@1.0.0',
    'install npm git+https://github.com/owner/repo.git',
    'install npm https://user:secret@example.test/plugin.tgz',
    'install npm example-plugin extra',
    'install github https://github.com/owner/repo',
    'install github user:secret@owner/repo',
    'install github owner/repo extra',
    'install release {',
    'install release []',
    'remove Example-Plugin',
    'remove example-plugin extra',
    'update example-plugin',
    'update example-plugin 2.0.0 extra',
    'update example-plugin latest',
    'enable ./example-plugin',
    'disable',
  ])('rejects unsafe or malformed input without echoing it: %j', (rawInput) => {
    expect(() => parseDesktopPluginCommand(rawInput)).toThrow('Invalid /desktop-plugin command.')
    try {
      parseDesktopPluginCommand(rawInput)
    } catch (error: unknown) {
      expect(String(error)).not.toContain('secret')
    }
  })

  it('aligns package-name and GitHub bounds with the Electron control protocol', () => {
    const package256 = `a${'b'.repeat(255)}`
    expect(parseDesktopPluginCommand(`remove ${package256}`)).toEqual({ type: 'remove', name: package256 })
    expect(() => parseDesktopPluginCommand(`remove ${package256}c`)).toThrow('Invalid /desktop-plugin command.')

    const github4096 = `o/${'r'.repeat(4094)}`
    expect(parseDesktopPluginCommand(`install github ${github4096}`)).toEqual({
      type: 'install', source: { type: 'github', spec: github4096 },
    })
    expect(() => parseDesktopPluginCommand(`install github ${github4096}r`)).toThrow('Invalid /desktop-plugin command.')
  })

  it('accepts exactly one MiB and rejects one additional byte', () => {
    const prefix = 'install release {"value":"'
    const suffix = '"}'
    const exact = `${prefix}${'x'.repeat(1024 * 1024 - prefix.length - suffix.length)}${suffix}`
    expect(parseDesktopPluginCommand(exact)).toMatchObject({ type: 'install', source: { type: 'release' } })
    expect(() => parseDesktopPluginCommand(`${exact} `)).toThrow('Invalid /desktop-plugin command.')
  })
})

describe('formatDesktopPluginListRows', () => {
  it('sorts and formats package rows', () => {
    expect(formatDesktopPluginListRows([
      { name: 'zeta', version: '2.0.0', enabled: false },
      { name: '@scope/alpha', version: '1.0.0', enabled: true },
    ])).toBe('@scope/alpha@1.0.0 — enabled\nzeta@2.0.0 — disabled')
  })

  it('formats an empty inventory', () => {
    expect(formatDesktopPluginListRows([])).toBe('No Desktop plugins installed.')
  })
})

describe('desktop plugin command definition', () => {
  it('requests operations and returns concise list and restart output', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ type: 'list', rows: [{ name: 'example-plugin', version: '1.2.3', enabled: true }] })
      .mockResolvedValueOnce({ type: 'prepared' })
    const definition = createDesktopPluginCommandDefinition(request)
    const signal = new AbortController().signal

    await expect(definition.handler({ commandId: 'command-list', rawInput: ' list', signal })).resolves.toEqual({
      kind: 'success',
      text: 'example-plugin@1.2.3 — enabled',
    })
    await expect(definition.handler({ commandId: 'command-disable', rawInput: ' disable example-plugin', signal })).resolves.toEqual({
      kind: 'success',
      text: 'Plugin change prepared. Review the native confirmation to restart the Desktop Host.',
    })
    expect(request.mock.calls).toEqual([
      [{ type: 'list' }, 'command-list', signal],
      [{ type: 'disable', name: 'example-plugin' }, 'command-disable', signal],
    ])
  })

  it('does not expose invalid input or request failures', async () => {
    const request = vi.fn().mockRejectedValue(new Error('request included secret-token'))
    const definition = createDesktopPluginCommandDefinition(request)
    const signal = new AbortController().signal

    const invalid = await definition.handler({ commandId: 'command-invalid', rawInput: ' install npm secret://token', signal })
    expect(invalid.kind).toBe('error')
    expect(invalid.text).not.toContain('secret')
    expect(request).not.toHaveBeenCalled()

    await expect(definition.handler({ commandId: 'command-failed', rawInput: ' list', signal })).resolves.toEqual({
      kind: 'error',
      text: 'Desktop plugin request failed.',
    })

    const explicit = createDesktopPluginCommandDefinition(vi.fn().mockResolvedValue({
      type: 'error', code: 'failed', message: 'secret-token C:\\private\\plugin.tgz',
    }))
    const result = await explicit.handler({ commandId: 'command-explicit', rawInput: ' list', signal })
    expect(result).toEqual({
      kind: 'error',
      text: 'Desktop could not prepare the plugin change. Review Desktop diagnostics for details.',
    })
    expect(result.text).not.toContain('secret-token')
    expect(result.text).not.toContain('private')
  })

  it('registers through the structural registry and returns its disposer', () => {
    let registered: DesktopPluginCommandDefinition | undefined
    const dispose = vi.fn()
    const registry = { register: (definition: DesktopPluginCommandDefinition) => { registered = definition; return dispose } }

    expect(registerDesktopPluginCommand(registry, async () => ({ type: 'prepared' }))).toBe(dispose)
    expect(registered).toMatchObject({
      name: 'desktop-plugin',
      description: 'List or change Desktop Host plugins',
    })
  })

  it('binds command registration to the matching command/done settlement event', async () => {
    let definition: DesktopPluginCommandDefinition | undefined
    let listener: Parameters<DesktopPluginCommandRuntime['onSessionEvent']>[0] | undefined
    const settled = vi.fn()
    const signal = new AbortController().signal
    const request = vi.fn(async () => ({ type: 'prepared' as const }))
    registerDesktopPluginCommandRuntime({
      commands: { register(value) { definition = value; return vi.fn() } },
      effect(register) { register() },
      onSessionEvent(value) { listener = value },
    }, request, settled)

    await expect(definition?.handler({ commandId: 'command-1', rawInput: ' disable example-plugin', signal }))
      .resolves.toMatchObject({ kind: 'success' })
    expect(request).toHaveBeenCalledWith({ type: 'disable', name: 'example-plugin' }, 'command-1', signal)
    expect(settled).not.toHaveBeenCalled()
    let resolvePersisted!: (value: boolean) => void
    const persisted = new Promise<boolean>((resolve) => { resolvePersisted = resolve })
    const flush = vi.fn(() => persisted)
    listener?.({ type: 'command/done', data: { commandId: 'unrelated', kind: 'success' } }, flush)
    expect(flush).not.toHaveBeenCalled()
    listener?.({ type: 'command/done', data: { commandId: 'command-1', kind: 'success' } }, flush)
    await Promise.resolve()
    expect(flush).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
    resolvePersisted(true)
    await vi.waitFor(() => { expect(settled).toHaveBeenCalledWith('command-1', true) })
    listener?.({ type: 'message/create', data: {} }, flush)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it.each(['command-error', 'flush-error', 'no-persistence', 'disposed'] as const)(
    'never acknowledges prepared success when %s', async (mode) => {
      let definition: DesktopPluginCommandDefinition | undefined
      let listener: Parameters<DesktopPluginCommandRuntime['onSessionEvent']>[0] | undefined
      let dispose: (() => void) | undefined
      const settled = vi.fn()
      registerDesktopPluginCommandRuntime({
        commands: { register(value) { definition = value; return vi.fn() } },
        effect(register) { dispose = register() },
        onSessionEvent(value) { listener = value },
      }, async () => ({ type: 'prepared' }), settled)
      await definition?.handler({ commandId: 'command-1', rawInput: 'disable example-plugin', signal: new AbortController().signal })
      const flush = vi.fn(async () => {
        if (mode === 'flush-error') throw new Error('private-storage-error')
        return mode !== 'no-persistence'
      })
      listener?.({ type: 'command/done', data: { commandId: 'command-1', kind: mode === 'command-error' ? 'error' : 'success' } }, flush)
      if (mode === 'disposed') dispose?.()
      if (mode !== 'disposed') await vi.waitFor(() => { expect(settled).toHaveBeenCalledWith('command-1', false) })
      else {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        expect(settled).not.toHaveBeenCalled()
      }
      expect(settled).not.toHaveBeenCalledWith('command-1', true)
      if (mode === 'command-error') expect(flush).not.toHaveBeenCalled()
    },
  )
})
