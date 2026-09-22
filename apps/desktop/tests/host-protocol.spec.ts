import { describe, expect, it } from 'vitest'
import {
  DesktopHostRequestDecoder,
  encodeDesktopResponseData,
  encodeDesktopResponseEnd,
  encodeDesktopResponseError,
  encodeDesktopResponseStart,
} from '../../desktop-host/src/wire.ts'
import {
  DesktopHostResponseDecoder,
  encodeDesktopRequestCancel,
  encodeDesktopRequestData,
  encodeDesktopRequestEnd,
  encodeDesktopRequestStart,
  isDesktopPluginCommandOperation,
} from '../src/host-protocol.ts'

function decodeInPieces<T>(bytes: Buffer, push: (chunk: Buffer) => readonly T[]): T[] {
  const values: T[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += 7) {
    values.push(...push(bytes.subarray(offset, offset + 7)))
  }
  return values
}

describe('desktop Host plugin command protocol', () => {
  it.each([
    { type: 'list' },
    { type: 'install', source: { type: 'npm', spec: '@scope/plugin@1.0.0' } },
    { type: 'install', source: { type: 'github', spec: 'owner/repo#main' } },
    { type: 'install', source: { type: 'release', release: { schemaVersion: 1, type: 'githubRelease' } } },
    { type: 'remove', name: 'example-plugin' },
    { type: 'update', name: 'example-plugin', version: '1.2.3' },
    { type: 'enable', name: 'example-plugin' },
    { type: 'disable', name: 'example-plugin' },
    { type: 'disable-all' },
  ])('accepts the closed JSON operation %j', (operation) => {
    expect(isDesktopPluginCommandOperation(operation)).toBe(true)
  })

  it.each([
    null,
    { type: 'list', extra: true },
    { type: 'install', source: { type: 'file', spec: './plugin' } },
    { type: 'install', source: { type: 'release', release: [] } },
    { type: 'toggle', name: 'plugin', enabled: true },
    { type: 'remove', name: '' },
  ])('rejects malformed or widened operation %j', (operation) => {
    expect(isDesktopPluginCommandOperation(operation)).toBe(false)
  })
})

describe('desktop Host pipe protocol', () => {
  it('keeps Electron request frames compatible with the installed Host decoder', () => {
    const decoder = new DesktopHostRequestDecoder()
    const bytes = Buffer.concat([
      encodeDesktopRequestStart(7, {
        url: 'dsh-app://app/api/session',
        method: 'POST',
        headers: [['content-type', 'application/json']],
        hasBody: true,
      }),
      encodeDesktopRequestData(7, Buffer.from('{"ok":true}')),
      encodeDesktopRequestEnd(7),
      encodeDesktopRequestCancel(7),
    ])

    expect(decodeInPieces(bytes, chunk => decoder.push(chunk))).toEqual([
      {
        type: 'start',
        streamId: 7,
        url: 'dsh-app://app/api/session',
        method: 'POST',
        headers: [['content-type', 'application/json']],
        hasBody: true,
      },
      { type: 'data', streamId: 7, data: Buffer.from('{"ok":true}') },
      { type: 'end', streamId: 7 },
      { type: 'cancel', streamId: 7 },
    ])
    expect(() => { decoder.finish() }).not.toThrow()
  })

  it('keeps Host response frames compatible with the Electron decoder', () => {
    const decoder = new DesktopHostResponseDecoder()
    const bytes = Buffer.concat([
      encodeDesktopResponseStart(9, {
        status: 201,
        headers: [['content-type', 'application/octet-stream']],
        hasBody: true,
      }),
      encodeDesktopResponseData(9, Buffer.from([0, 1, 2, 255])),
      encodeDesktopResponseEnd(9),
      encodeDesktopResponseError(10, 'failed'),
    ])

    expect(decodeInPieces(bytes, chunk => decoder.push(chunk))).toEqual([
      {
        type: 'start',
        streamId: 9,
        status: 201,
        headers: [['content-type', 'application/octet-stream']],
        hasBody: true,
      },
      { type: 'data', streamId: 9, data: Buffer.from([0, 1, 2, 255]) },
      { type: 'end', streamId: 9 },
      { type: 'error', streamId: 10, message: 'failed' },
    ])
    expect(() => { decoder.finish() }).not.toThrow()
  })

  it('rejects a corrupt marker and truncated EOF on both directions', () => {
    const request = new DesktopHostRequestDecoder()
    const response = new DesktopHostResponseDecoder()
    expect(() => request.push(Buffer.alloc(13))).toThrow(/request frame marker/u)
    expect(() => response.push(Buffer.alloc(13))).toThrow(/response frame marker/u)

    const partialRequest = new DesktopHostRequestDecoder()
    partialRequest.push(encodeDesktopRequestEnd(1).subarray(0, 5))
    expect(() => { partialRequest.finish() }).toThrow(/ended inside a frame/u)

    const partialResponse = new DesktopHostResponseDecoder()
    partialResponse.push(encodeDesktopResponseEnd(1).subarray(0, 5))
    expect(() => { partialResponse.finish() }).toThrow(/ended inside a frame/u)
  })
})
