// Web e2e scenario: the agent-preset settings section as copy-only authoring.
// The browser never edits composition text — a shipped preset opens in a
// read-only viewer, the copy dialog collects an id and an optional display
// name, and the host copies the whole directory. The section's other job is
// getting the user TO the files: this lane pins `nativeOpen: false` (see the
// overlay), so the location affordance answers the preset directory as text —
// the deterministic branch a golden can hold on every platform.
//
// Zero model calls: no replay fixture mounts, so a stray stream fails loud.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page, Request, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Locator } from 'playwright'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/agent-preset-authoring', import.meta.url))
const SECTION_EXPECTED = join(SNAPSHOT_DIR, 'section.expected.md')
const COPY_DIALOG_EXPECTED = join(SNAPSHOT_DIR, 'copy-dialog.expected.md')
const CREATED_EXPECTED = join(SNAPSHOT_DIR, 'created.expected.md')
const DAMAGED_EXPECTED = join(SNAPSHOT_DIR, 'damaged.expected.md')
/** The shipped roster, bundled inside the `dsh-agent-presets` package. */
const SHIPPED_PRESETS = fileURLToPath(new URL('../../../packages/preset/agent-presets/presets', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./agent-preset-authoring.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: agent-preset authoring is a host-side copy', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let userRoot: string

  /** The settings dialog, opened on the Agent-presets section. */
  function settingsDialog(): Locator {
    return page.getByRole('dialog', { name: '设置' })
  }

  beforeAll(async () => {
    userRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-e2e-presets-')))
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      profile: { packages: [] },
      agentPresets: {
        // The shipped root is the plugin's own, prepended before this.
        roots: [{ path: userRoot, trust: 'user' }],
        default: 'standard',
      },
    })
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(userRoot, { recursive: true, force: true })
  })

  it('offers the roster with copy as the only way to create', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-section'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = settingsDialog()
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Agent 预设' }).click()
    await dialog.getByRole('heading', { name: 'Agent 预设' }).waitFor({ timeout: 10_000 })
    // The intro copy also names 标准模式. Wait for the roster's own action so
    // the snapshot cannot land between the section shell and its cards.
    await dialog.getByRole('button', { name: '查看: 标准模式', exact: true }).waitFor({ timeout: 10_000 })

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)

    await compareOrRefreshGolden(SECTION_EXPECTED, snapshot, MODE)
    const toggle = dialog.getByRole('switch', { name: '允许切换agent模式' })
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    // The intro states the copy path directly, and the shipped rows offer
    // view/copy but never delete or a location — their
    // install is overwritten by upgrades and is not the user's to manage.
    expect(snapshot).toContain('或用「创造模式」让 Agent 帮你创建')
    expect(snapshot).not.toContain('新建预设')
    expect(snapshot).toContain('查看: 标准模式')
    expect(snapshot).not.toContain('删除: 标准模式')
    expect(snapshot).not.toContain('打开目录')
    // The rest of this scenario exercises the existing default and Creator
    // actions with the beta picker enabled by default.
  }, 60_000)

  it('views a shipped composition read-only instead of editing it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-view'))
    const dialog = settingsDialog()
    await dialog.getByRole('button', { name: '查看: 标准模式' }).click()
    const viewer = page.getByRole('dialog', { name: '查看 · 标准模式' })
    await viewer.waitFor({ timeout: 10_000 })

    // The real shipped composition, not a golden: the viewer shows whatever
    // the deployment ships, and this lane only asserts it is shown read-only.
    const shipped = await readFile(join(SHIPPED_PRESETS, 'standard', 'agent.cordis.yml'), 'utf8')
    expect(await viewer.locator('pre').textContent()).toBe(shipped)
    expect(await viewer.getByRole('textbox').count()).toBe(0)
    // The header X and the footer button share the 关闭 name; the footer one
    // is last in the dialog.
    await viewer.getByRole('button', { name: '关闭' }).last().click()
    await viewer.waitFor({ state: 'detached', timeout: 10_000 })
  }, 60_000)

  it('copies 极简模式 whole under a new id and lands in its files', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-copy'))
    const dialog = settingsDialog()
    await dialog.getByRole('button', { name: '复制: 极简模式' }).click()
    const copyDialog = page.getByRole('dialog', { name: '复制预设 · 复制自 极简模式' })
    await copyDialog.waitFor({ timeout: 10_000 })

    const dialogSnapshot = await captureStableAria(
      page, '[role="dialog"][aria-label^="复制预设"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COPY_DIALOG_EXPECTED, dialogSnapshot, MODE)
    // Two fields and nothing else: the id is the directory name the host
    // needs up front; description and composition live in the files.
    expect(dialogSnapshot).toContain('标识符')
    expect(dialogSnapshot).not.toContain('描述')

    await copyDialog.getByPlaceholder('my-agent').fill('my-agent')
    await copyDialog.getByPlaceholder('选择器中显示的名字，缺省用标识符').fill('我的模式')
    await copyDialog.getByRole('button', { name: '创建' }).click()
    await copyDialog.waitFor({ state: 'detached', timeout: 10_000 })

    // The new row lands in the custom group, and — with no desktop opener —
    // its directory is revealed as text right away: landing in the files is
    // the completion of a copy, not a follow-up.
    await dialog.getByText('我的模式').first().waitFor({ timeout: 10_000 })
    await dialog.getByText('预设文件：').waitFor({ timeout: 10_000 })
    // The copy dialog is detached, so the settings dialog is the only one
    // left (it names itself via aria-labelledby, which a CSS attribute
    // selector cannot address).
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, {
      replacements: [[userRoot, '{{presetRoot}}']],
    })
    await compareOrRefreshGolden(CREATED_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('{{presetRoot}}/my-agent')

    // The host copied the whole directory and rewrote only the display
    // metadata: the composition is byte-identical to the shipped source, the
    // description rides along for the user to edit in place, and neither the
    // source's name nor its roster order survives into the copy.
    const composition = await readFile(join(userRoot, 'my-agent', 'agent.cordis.yml'), 'utf8')
    expect(composition).toBe(await readFile(join(SHIPPED_PRESETS, 'minimal', 'agent.cordis.yml'), 'utf8'))
    const metadata = await readFile(join(userRoot, 'my-agent', 'preset.yml'), 'utf8')
    expect(metadata).toContain('name: 我的模式')
    expect(metadata).toContain('description: 仅提供持久 shell 的单工具编码 Agent。')
    expect(metadata).not.toContain('order:')
  }, 60_000)

  it('deletes the copy after confirmation and reclaims the roster', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-delete'))
    const dialog = settingsDialog()
    await dialog.getByRole('button', { name: '删除: 我的模式' }).click()
    const confirm = page.getByRole('dialog', { name: '删除该预设？' })
    await confirm.waitFor({ timeout: 10_000 })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.waitFor({ state: 'detached', timeout: 10_000 })

    await expect.poll(async () => dialog.getByText('我的模式').count(), { timeout: 10_000 }).toBe(0)
    expect(existsSync(join(userRoot, 'my-agent'))).toBe(false)
    // The custom group outlives its only member: the heading stays with the
    // creator entry so the place to author a preset never disappears.
    expect(await dialog.getByRole('heading', { name: '自定义' }).count()).toBe(1)
    expect(await dialog.getByRole('button', { name: '用「创造模式」创作自定义预设' }).count()).toBe(1)
    expect(await dialog.getByText('标准模式').count()).toBeGreaterThan(0)
  }, 60_000)

  it('marks damaged presets broken and clears a ghost through delete', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-damaged'))
    // The two hand-edit damage shapes: a composition that no longer parses,
    // and a directory whose composition file was deleted outright.
    await mkdir(join(userRoot, 'broken-yaml'), { recursive: true })
    await writeFile(join(userRoot, 'broken-yaml', 'agent.cordis.yml'), '- id: x\n  name: [unclosed\n')
    await mkdir(join(userRoot, 'ghost'), { recursive: true })
    await writeFile(join(userRoot, 'ghost', 'preset.yml'), 'name: 幽灵预设\ndescription: composition 已被手动删除。\n')

    // The section reads the roster when it mounts; hop away and back.
    const dialog = settingsDialog()
    await dialog.getByRole('button', { name: '通用设置' }).click()
    await dialog.getByRole('button', { name: 'Agent 预设' }).click()
    await dialog.getByText('加载失败').first().waitFor({ timeout: 10_000 })

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, {
      replacements: [[userRoot, '{{presetRoot}}']],
    })
    await compareOrRefreshGolden(DAMAGED_EXPECTED, snapshot, MODE)
    // Both damage shapes surface as marked, unselectable, uncopyable cards
    // that still carry their metadata and the discovery-reported reason.
    expect(snapshot).toContain('加载失败: broken-yaml')
    expect(snapshot).toContain('加载失败: 幽灵预设')
    expect(snapshot).toContain('not valid YAML')
    expect(snapshot).toContain('agent.cordis.yml is missing')
    expect(await dialog.getByRole('button', { name: '加载失败: broken-yaml' }).isDisabled()).toBe(true)
    expect(await dialog.getByRole('button', { name: '复制: 幽灵预设' }).isDisabled()).toBe(true)
    // A broken card offers no "set default" affordance at all — the aria name
    // IS the broken marking, so the picking name must not exist.
    expect(await dialog.getByRole('button', { name: '设为默认: broken-yaml' }).count()).toBe(0)

    // The ghost's way out is the card's own delete — and the id it blocked
    // is claimable again immediately afterwards.
    await dialog.getByRole('button', { name: '删除: 幽灵预设' }).click()
    const confirm = page.getByRole('dialog', { name: '删除该预设？' })
    await confirm.waitFor({ timeout: 10_000 })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.waitFor({ state: 'detached', timeout: 10_000 })
    await expect.poll(async () => dialog.getByText('幽灵预设').count(), { timeout: 10_000 }).toBe(0)
    expect(existsSync(join(userRoot, 'ghost'))).toBe(false)

    await dialog.getByRole('button', { name: '复制: 极简模式' }).click()
    const copyDialog = page.getByRole('dialog', { name: '复制预设 · 复制自 极简模式' })
    await copyDialog.waitFor({ timeout: 10_000 })
    await copyDialog.getByPlaceholder('my-agent').fill('ghost')
    await copyDialog.getByRole('button', { name: '创建' }).click()
    await copyDialog.waitFor({ state: 'detached', timeout: 10_000 })
    await dialog.getByRole('button', { name: '设为默认: ghost' }).waitFor({ timeout: 10_000 })

    // Leave the roster as the earlier tests shaped it.
    await dialog.getByRole('button', { name: '删除: ghost' }).click()
    const cleanup = page.getByRole('dialog', { name: '删除该预设？' })
    await cleanup.waitFor({ timeout: 10_000 })
    await cleanup.getByRole('button', { name: '删除', exact: true }).click()
    await cleanup.waitFor({ state: 'detached', timeout: 10_000 })
    await rm(join(userRoot, 'broken-yaml'), { recursive: true, force: true })
  }, 60_000)

  /** The exact main Session committed by the browser's selection store. */
  const selectedId = (): Promise<string | null> => page.evaluate(() => {
    const current = localStorage.getItem('dsh.sessions.current')
    return current === null ? null : (JSON.parse(current) as { sessionId?: string }).sessionId ?? null
  })

  /** Read real Host rows; preset labels alone do not establish composition. */
  const hostSessions = async () => (
    await scaffold.ctx.sessionController.list({}, new AbortController().signal)
  ).items

  it('keeps Settings open without a Workspace and creates no deferred Creator Session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-no-workspace'))
    const dialog = settingsDialog()
    const creator = dialog.getByRole('button', { name: '用「创造模式」创作自定义预设' })
    const createRequests: Request[] = []
    const observeCreate = (request: Request): void => {
      if (new URL(request.url()).pathname === '/api/session/create') createRequests.push(request)
    }
    expect(await hostSessions()).toEqual([])
    expect(await selectedId()).toBeNull()
    page.on('request', observeCreate)
    try {
      await creator.click()
      await expect.poll(() => creator.getAttribute('aria-busy')).toBe('false')
      expect(await dialog.isVisible()).toBe(true)
      expect(await creator.isEnabled()).toBe(true)
      await dialog.getByText('请先选择工作区，再使用此操作。没有可用的工作区时，不会启动创造模式会话。', { exact: true })
        .waitFor({ timeout: 10_000 })
      expect(createRequests).toEqual([])
      expect(await hostSessions()).toEqual([])
      expect(await selectedId()).toBeNull()
    } finally {
      page.off('request', observeCreate)
    }
  })

  it('commits a fresh Host Cordis Session without changing the old blank or the next default', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-creator'))
    await settingsDialog().getByRole('button', { name: '关闭' }).last().click()
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await expect.poll(hostSessions, { timeout: 15_000 }).toHaveLength(1)
    const original = (await hostSessions())[0]!
    await expect.poll(selectedId).toBe(original.sessionId)
    await expect.poll(hostSessions, { timeout: 15_000 }).toEqual([
      expect.objectContaining({
        sessionId: original.sessionId, blank: true,
        projections: expect.objectContaining({ values: expect.objectContaining({ agentPreset: 'standard' }) as unknown }) as unknown,
      }),
    ])
    // Blank Sessions need not have a physical log; observe the owned live log instead.
    const originalSession = scaffold.ctx.sessions.get(original.sessionId)!
    expect(originalSession).toBeDefined()
    const originalSeq = originalSession.seq
    await page.getByRole('button', { name: '标准模式', exact: true }).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = settingsDialog()
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Agent 预设' }).click()
    const creatorButton = dialog.getByRole('button', { name: '用「创造模式」创作自定义预设' })

    // Hold the real request before Host creation; never substitute a Remote success.
    const createPattern = '**/api/session/create'
    const release = Promise.withResolvers<undefined>()
    let createRequest: Request | undefined
    let routeWork: Promise<void> | undefined
    const holdCreate = (route: Route): Promise<void> => {
      createRequest = route.request()
      routeWork = release.promise.then(() => route.continue())
      return routeWork
    }
    await page.route(createPattern, holdCreate, { times: 1 })
    try {
      await creatorButton.click()
      await expect.poll(() => createRequest, { timeout: 15_000 }).toBeDefined()
      const requestBody = createRequest!.postDataJSON() as {
        payload: { args: { request: { agentPreset?: string; workspaceId?: string } } }
      }
      expect(requestBody.payload.args.request.agentPreset).toBe('cordis')
      expect(requestBody.payload.args.request.workspaceId).toBeTruthy()
      expect(await dialog.isVisible()).toBe(true)
      expect(await creatorButton.isDisabled()).toBe(true)
      expect(await creatorButton.getAttribute('aria-busy')).toBe('true')
      expect(await selectedId()).toBe(original.sessionId)
      expect(await hostSessions()).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      await page.unroute(createPattern, holdCreate)
      await routeWork
    }

    await expect.poll(hostSessions, { timeout: 15_000 }).toHaveLength(2)
    const creator = (await hostSessions()).find(row => row.sessionId !== original.sessionId)!
    await expect.poll(selectedId, { timeout: 15_000 }).toBe(creator.sessionId)
    await dialog.waitFor({ state: 'detached', timeout: 10_000 })
    await expect.poll(async () => (await hostSessions()).find(row => row.sessionId === creator.sessionId), {
      timeout: 15_000,
    }).toMatchObject({
      blank: true, projections: { values: { agentPreset: 'cordis' } },
    })
    expect(creator.parentSessionId).toBeUndefined()
    await page.getByRole('button', { name: '创造模式', exact: true }).waitFor({ timeout: 10_000 })
    expect((await hostSessions()).find(row => row.sessionId === original.sessionId)).toMatchObject({
      blank: true, projections: { values: { agentPreset: 'standard' } },
    })
    expect(scaffold.ctx.sessions.get(original.sessionId)).toBe(originalSession)
    expect(originalSession.seq).toBe(originalSeq)
    const roster = await scaffold.ctx.agentPresets.remoteExportList()
    expect(roster.presets.find(preset => preset.isDefault)?.id).toBe('standard')

    await page.getByRole('button', { name: '新建会话', exact: true }).last().click()
    await expect.poll(hostSessions, { timeout: 15_000 }).toHaveLength(3)
    const ordinary = (await hostSessions()).find(row =>
      row.sessionId !== original.sessionId && row.sessionId !== creator.sessionId)!
    await expect.poll(selectedId, { timeout: 15_000 }).toBe(ordinary.sessionId)
    await expect.poll(async () => (await hostSessions()).find(row => row.sessionId === ordinary.sessionId), {
      timeout: 15_000,
    }).toMatchObject({
      blank: true, projections: { values: { agentPreset: 'standard' } },
    })
    await page.getByRole('button', { name: '标准模式', exact: true }).waitFor({ timeout: 10_000 })
    expect((await hostSessions()).find(row => row.sessionId === creator.sessionId)).toMatchObject({
      projections: { values: { agentPreset: 'cordis' } },
    })
    expect((await hostSessions()).find(row => row.sessionId === original.sessionId)).toMatchObject({
      blank: true, projections: { values: { agentPreset: 'standard' } },
    })
    expect(scaffold.ctx.sessions.get(original.sessionId)).toBe(originalSession)
    expect(originalSession.seq).toBe(originalSeq)
  })

  it('drove every surface without a page error or a stream warning', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
