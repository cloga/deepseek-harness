import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as packageTypes from '../src/types.ts'

describe('public package transaction types', () => {
  it('exposes a non-root types entry and includes its emitted module in published files', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, { types?: string; default?: string } | string>
      files: string[]
    }
    expect(manifest.exports['./types']).toEqual({
      types: './lib/types/types.d.ts',
      default: './lib/types/types.js',
    })
    expect(manifest.files).toEqual([
      'lib/index.js',
      'lib/worker/profile-resolution-bootstrap.js',
      'lib/types/**/*.js',
      'lib/types/**/*.d.ts',
    ])
  })

  it('loads the shared source entry without Host runtime exports', () => {
    expect(Object.keys(packageTypes)).toEqual([])
  })
})
