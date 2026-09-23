/** The official alpha2 Browser is part of the Web/desktop Client roster, not an unmounted workspace package. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const webPatch = join(root, 'packages/bundle/web-app/cordis.patch.yml')

it('selects exactly one official sandboxed Browser row in the shipped Web bundle', () => {
  const rows = composeEntries([loadOverlayPatches('dsh web test', webPatch)])
  const matches = rows.filter(row => row.id === 'ui-sidebar-browser')
  expect(matches).toHaveLength(1)
  expect(matches[0]).toMatchObject({ name: '@deepseek-ai/dsh-client-ui-sidebar-browser' })
  expect(matches[0]?.disabled).not.toBe(true)
})

it('installs the matching browser Client package with its real right-Sidebar dependencies', () => {
  const web = JSON.parse(readFileSync(join(root, 'packages/bundle/web-app/package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  const browser = JSON.parse(readFileSync(join(root, 'packages/client/ui-sidebar-browser/package.json'), 'utf8')) as {
    dsh: { client: { platform: string; inject: string[] } }
  }
  expect(web.dependencies['@deepseek-ai/dsh-client-ui-sidebar-browser']).toBe('workspace:^')
  expect(browser.dsh.client).toMatchObject({ platform: 'web', inject: [
    '@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-ui-session',
  ] })
})
