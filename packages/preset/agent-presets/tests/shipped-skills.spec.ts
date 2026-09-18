/** The shipped Cordis skill row keeps deployment assets outside the execution filesystem. */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-shipped-skills-')))
  roots.push(root)
  return root
}

async function writeSkill(root: string, name: string, content: string): Promise<void> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: User-owned ${name}\n---\n\n${content}\n`)
}

async function mountSkills(preset: string, home: string, customRoot?: string) {
  const parsed: unknown = load(await readFile(join(preset, 'agent.cordis.yml'), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('the shipped preset must be an entry list')
  const row = (parsed as EntryOptions[]).find(entry => entry.id === 'skill-filesystem')
  if (row === undefined) throw new Error('the shipped preset must register skill-filesystem')
  expect(row.name).toBe('@deepseek-ai/dsh-skill-filesystem')
  const config: unknown = row.config
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new TypeError('the shipped skill row must configure a mapping')
  }

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(preset).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(LocalFileSystem, { cwd: home })
  await ctx.plugin(SkillRegistry)

  const shippedRoot = join(preset, 'skills')
  const resolve = ctx.fs.resolve.bind(ctx.fs)
  const resolveCalls = vi.spyOn(ctx.fs, 'resolve').mockImplementation(async (path, options) => {
    if (path === shippedRoot || path.startsWith(shippedRoot + sep)) {
      throw new TypeError('Cannot mix BigInt and other types, use explicit conversions')
    }
    if (path === customRoot) throw new Error('custom root rejected by execution filesystem')
    return await resolve(path, options)
  })
  const readCalls = vi.spyOn(ctx.fs, 'readText')
  // Keep the actual YAML row and Loader interpolation; resolve only its module to source.
  vi.spyOn(ctx.loader, 'import').mockImplementation(async (name) => {
    if (name !== row.name) throw new Error(`unexpected fixture module: ${name}`)
    return SkillFileSystem
  })
  const entry = await ctx.loader.create({
    ...row,
    config: {
      ...config,
      dshHome: home,
      agentsHome: join(home, 'agents'),
      watch: false,
      ...(customRoot === undefined ? {} : { customSkillDirs: [customRoot] }),
    },
  })
  await ctx.loader.await()
  expect(ctx.loader.resolve(entry).fiber?.state).toBe(FiberState.ACTIVE)
  return { ctx, shippedRoot, resolveCalls, readCalls }
}

describe('the shipped Cordis skill composition', () => {
  it.each(['shipped', 'copied'] as const)('loads bundled and user skills with a %s preset-relative root', async (location) => {
    const home = await tempRoot()
    let preset = join(SHIPPED_PRESET_ROOT, 'cordis')
    if (location === 'copied') {
      const copy = join(home, 'copied preset')
      await cp(preset, copy, { recursive: true })
      preset = copy
    }
    for (const name of ['impeccable', 'ui-flow-gif']) await writeSkill(join(home, 'skills'), name, `Load ${name}.`)
    const { ctx, shippedRoot, resolveCalls, readCalls } = await mountSkills(preset, home)

    const snapshot = await ctx.skills.snapshot()
    expect(snapshot.complete).toBe(true)
    expect(snapshot.skills.map(skill => [skill.name, skill.source]).sort()).toEqual([
      ['cordis-plugin-development', 'bundled'],
      ['editing-cordis-compositions', 'bundled'],
      ['impeccable', 'user-dsh'],
      ['ui-flow-gif', 'user-dsh'],
    ])
    for (const name of ['cordis-plugin-development', 'editing-cordis-compositions']) {
      const skill = await ctx.skills.get(name)
      expect(skill?.source).toBe('bundled')
      expect(skill?.path).toBe(await realpath(join(shippedRoot, name, 'SKILL.md')))
      expect(skill?.content.length).toBeGreaterThan(0)
    }
    for (const name of ['impeccable', 'ui-flow-gif']) {
      expect((await ctx.skills.get(name))?.content).toBe(`Load ${name}.`)
    }
    expect(resolveCalls.mock.calls.some(([path]) => path === shippedRoot || path.startsWith(shippedRoot + sep))).toBe(false)
    expect(readCalls.mock.calls.some(([target]) => target.displayPath === join(home, 'skills', 'impeccable', 'SKILL.md'))).toBe(true)
  })

  it('lets a user skill override the same bundled name', async () => {
    const home = await tempRoot()
    await writeSkill(join(home, 'skills'), 'cordis-plugin-development', 'Use the user override.')
    const { ctx, readCalls } = await mountSkills(join(SHIPPED_PRESET_ROOT, 'cordis'), home)

    expect((await ctx.skills.snapshot()).complete).toBe(true)
    expect(await ctx.skills.get('cordis-plugin-development')).toMatchObject({
      source: 'user-dsh',
      content: 'Use the user override.',
    })
    expect((await ctx.skills.get('editing-cordis-compositions'))?.source).toBe('bundled')
    expect(readCalls.mock.calls.some(([target]) => target.displayPath === join(home, 'skills', 'cordis-plugin-development', 'SKILL.md'))).toBe(true)
  })

  it('does not bypass the execution filesystem for an additional custom root', async () => {
    const home = await tempRoot()
    const customRoot = join(home, 'custom')
    await writeSkill(customRoot, 'blocked-custom', 'This host-readable skill is not authorized by the backend.')
    const { ctx, resolveCalls } = await mountSkills(join(SHIPPED_PRESET_ROOT, 'cordis'), home, customRoot)

    const snapshot = await ctx.skills.snapshot()
    expect(snapshot.complete).toBe(false)
    expect(snapshot.skills.some(skill => skill.name === 'blocked-custom')).toBe(false)
    expect(resolveCalls.mock.calls.some(([path]) => path === customRoot)).toBe(true)
  })
})
