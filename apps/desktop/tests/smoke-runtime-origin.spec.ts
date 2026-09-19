import { expect, it } from 'vitest'
import { desktopSmokeOrigin } from '../scripts/smoke-runtime-browser.ts'

it('uses the official Host origin without retaining its authentication URL', () => {
  expect(desktopSmokeOrigin('http://127.0.0.1:19387/?token=private-fixture')).toBe('http://127.0.0.1:19387')
})

it.each([
  'https://127.0.0.1:19387/',
  'http://example.com:19387/',
  'http://127.0.0.1/',
  'http://user:password@127.0.0.1:19387/',
  'dsh-app://app/',
])('rejects non-owned smoke endpoint %s', (url) => {
  expect(() => desktopSmokeOrigin(url)).toThrow('explicit loopback Host port')
})
