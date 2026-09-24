/** The official alpha2 Office Remote and complete Client preview are selected as product Web rows. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const readManifest = (path: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>

it('registers one official Office provider before the retained Document Preview UI row', () => {
  const rows = composeEntries([loadOverlayPatches('official Office Web test', join(root, 'packages/bundle/web-app/cordis.patch.yml'))])
  const provider = rows.filter(row => row.id === 'office-to-pdf')
  expect(provider).toHaveLength(1)
  expect(provider[0]).toMatchObject({ name: '@deepseek-ai/dsh-office-to-pdf' })
  expect(provider[0]?.disabled).not.toBe(true)
  const preview = rows.findIndex(row => row.id === 'ui-sidebar-documentpreview')
  const owner = rows.findIndex(row => row.id === 'office-to-pdf')
  expect(owner).toBeGreaterThanOrEqual(0)
  expect(preview).toBeGreaterThan(owner)
})

it('carries the exact official provider, native-kit version, and lazy Client preview assets', () => {
  const web = readManifest('packages/bundle/web-app/package.json') as { dependencies: Record<string, string> }
  const provider = readManifest('packages/document/office-to-pdf/package.json') as { dependencies: Record<string, string>; exports: Record<string, unknown> }
  const preview = readManifest('packages/client/ui-sidebar-documentpreview/package.json') as { devDependencies: Record<string, string>; files: string[] }
  expect(web.dependencies['@deepseek-ai/dsh-office-to-pdf']).toBe('workspace:^')
  expect(provider.dependencies['@deepseek-ai/libreoffice-kit']).toBe('0.0.1')
  expect(provider.exports).toHaveProperty('./remote')
  expect(preview.devDependencies['@deepseek-ai/dsh-office-to-pdf']).toBe('workspace:^')
  expect(preview.files).toContain('lib/client.*.js')
})
