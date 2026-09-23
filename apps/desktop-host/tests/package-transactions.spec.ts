import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { provideDesktopPackageTransactions } from '../src/package-transactions.ts'

const transactionId = '11111111-1111-4111-8111-111111111111'
const legacy = { transactionId, state: 'prepared', packageName: 'plugin', baseFingerprint: 'a'.repeat(64), health: 'pending' }
const selection = { schemaVersion: 2, kind: 'selection', transactionId, state: 'prepared', packageNames: ['first', 'second'],
  baseFingerprint: 'b'.repeat(64), health: 'pending' }

async function withProxy<T>(reply: (operation: string) => unknown, action: (ctx: Context, operations: string[]) => Promise<T>): Promise<T> {
  const previousSend = Object.getOwnPropertyDescriptor(process, 'send')
  const previousConnected = Object.getOwnPropertyDescriptor(process, 'connected')
  const messagesBefore = process.listenerCount('message')
  const disconnectBefore = process.listenerCount('disconnect')
  const operations: string[] = []
  const ctx = new Context()
  const failures: unknown[] = []
  let outcome: { value: T } | undefined
  try {
    Object.defineProperty(process, 'connected', { configurable: true, value: true })
    Object.defineProperty(process, 'send', { configurable: true, value(message: unknown, callback: (error: Error | null) => void) {
      if (message === null || typeof message !== 'object' || !('operation' in message) || !('rpcId' in message)) {
        throw new Error('Expected only the fixture-owned package transaction request')
      }
      const operation = String(message.operation)
      operations.push(operation)
      process.emit('message', { type: 'package-transaction-result', protocolVersion: 1, rpcId: message.rpcId,
        ok: true, value: operation === 'hello' ? 1 : reply(operation) }, undefined)
      callback(null)
      return true
    } })
    await provideDesktopPackageTransactions(ctx)
    outcome = { value: await action(ctx, operations) }
  } catch (error) { failures.push(error) }
  finally {
    try {
      await ctx.fiber.dispose()
      expect(process.listenerCount('message')).toBe(messagesBefore)
      expect(process.listenerCount('disconnect')).toBe(disconnectBefore)
    } catch (error) { failures.push(error) }
    for (const [key, previous] of [['send', previousSend], ['connected', previousConnected]] as const) {
      try {
        if (previous === undefined) Reflect.deleteProperty(process, key)
        else Object.defineProperty(process, key, previous)
      } catch (error) { failures.push(error) }
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Proxy test body and cleanup failed')
  if (outcome === undefined) throw new Error('Proxy action did not settle')
  return outcome.value
}

describe('actual Host staging proxy pending readers', () => {
  it('refuses a silent shell hello in five seconds without ever publishing a staging capability', async () => {
    const previousSend = Object.getOwnPropertyDescriptor(process, 'send')
    const previousConnected = Object.getOwnPropertyDescriptor(process, 'connected')
    const messagesBefore = process.listenerCount('message')
    const disconnectBefore = process.listenerCount('disconnect')
    const ctx = new Context()
    let helloRpcId: string | undefined
    let settled = false
    vi.useFakeTimers()
    try {
      Object.defineProperty(process, 'connected', { configurable: true, value: true })
      Object.defineProperty(process, 'send', { configurable: true, value(message: unknown, callback: (error: Error | null) => void) {
        if (message === null || typeof message !== 'object' || !('operation' in message) || message.operation !== 'hello'
          || !('rpcId' in message) || typeof message.rpcId !== 'string') {
          throw new Error('Only the boot-time hello may reach a shell without staging ownership')
        }
        helloRpcId = message.rpcId
        callback(null)
        return true
      } })
      const handshake = provideDesktopPackageTransactions(ctx)
      const refused = expect(handshake).rejects.toThrow('desktop packages: shell staging handshake deadline exceeded')
      void handshake.then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(4999)
      expect(settled).toBe(false)
      expect(ctx.get('profilePackageTransactions')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      await refused
      expect(settled).toBe(true)
      if (helloRpcId === undefined) throw new Error('Fixture did not send staging hello')
      process.emit('message', { type: 'package-transaction-result', protocolVersion: 1,
        rpcId: helloRpcId, ok: true, value: 1 }, undefined)
      expect(ctx.get('profilePackageTransactions')).toBeUndefined()
    } finally {
      try { await ctx.fiber.dispose() } finally {
        vi.useRealTimers()
        for (const [key, previous] of [['send', previousSend], ['connected', previousConnected]] as const) {
          if (previous === undefined) Reflect.deleteProperty(process, key)
          else Object.defineProperty(process, key, previous)
        }
      }
      expect(process.listenerCount('message')).toBe(messagesBefore)
      expect(process.listenerCount('disconnect')).toBe(disconnectBefore)
    }
  })

  it('reads both pending variants while preserving the legacy stage response', async () => {
    await withProxy(operation => operation === 'list' ? [legacy, selection] : operation === 'status' ? selection : legacy,
      async (ctx, operations) => {
        const service = ctx.get('profilePackageTransactions')
        if (service === undefined) throw new Error('Actual proxy did not provide its service')
        expect(await service.status(transactionId)).toEqual(selection)
        expect(await service.listPending()).toEqual([legacy, selection])
        expect(await service.stage(transactionId, { kind: 'remove', name: 'plugin' }, new AbortController().signal)).toEqual(legacy)
        expect(operations).toEqual(['hello', 'status', 'list', 'stage'])
      })
  })

  it('does not accept the selection variant as an ordinary stage result', async () => {
    await withProxy(() => selection, async (ctx) => {
      const service = ctx.get('profilePackageTransactions')
      if (service === undefined) throw new Error('Actual proxy did not provide its service')
      await expect(service.stage(transactionId, { kind: 'remove', name: 'plugin' }, new AbortController().signal))
        .rejects.toThrow('prepared result')
    })
  })

  it.each([
    { ...selection, packageNames: [] }, { ...selection, packageNames: ['second', 'first'] },
    { ...selection, packageName: 'fake-target' }, { ...selection, commandOrigin: {} },
  ])('rejects malformed pending variant case %# in both readers', async (invalid) => {
    await withProxy(operation => operation === 'list' ? [invalid] : invalid, async (ctx) => {
      const service = ctx.get('profilePackageTransactions')
      if (service === undefined) throw new Error('Actual proxy did not provide its service')
      await expect(service.status(transactionId)).rejects.toThrow()
      await expect(service.listPending()).rejects.toThrow()
    })
  })
})
