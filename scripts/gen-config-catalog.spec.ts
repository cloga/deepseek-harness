/** Plugin export ownership and shared schema aliases retain declared-field checks. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConfigCatalog } from './gen-config-catalog.ts'

const roots: string[] = []
const sharedSchema = `
import Schema from '@deepseek-ai/schemastery'
export interface LaunchConfig {
  /** Browser ownership mode. */
  mode: 'launch'
  /** Hide the launched browser. */
  headless: boolean
}
export interface AttachConfig {
  /** Browser ownership mode. */
  mode: 'attach'
  /** Existing browser address. */
  endpoint: string
}
export type BrowserConfig = LaunchConfig | AttachConfig
export const Shared = Schema.union([
  Schema.object({ mode: Schema.const('launch'), headless: Schema.boolean() }),
  Schema.object({ mode: Schema.const('attach'), endpoint: Schema.string() }),
])
`

function fixture(schema = sharedSchema) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-catalog-'))
  roots.push(root)
  const write = (path: string, value: string): void => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, value)
  }
  write('tsconfig.json', JSON.stringify({ compilerOptions: {
    baseUrl: '.', module: 'ESNext', moduleResolution: 'Bundler',
    paths: { '@test/runtime/config': ['./packages/test/runtime/src/config.ts'] },
  }, include: ['packages/**/*.ts'] }))
  write('packages/test/runtime/package.json', JSON.stringify({
    name: '@test/runtime', exports: { './config': { types: './lib/types/config.d.ts', default: './lib/config.js' } },
  }))
  write('packages/test/runtime/src/index.ts', "export { Shared } from './config.ts'\n")
  write('packages/test/runtime/src/config.ts', schema)
  write('packages/test/provider/package.json', JSON.stringify({ name: '@test/provider' }))
  write('packages/test/provider/src/index.ts', `
import { Shared as SharedConfig, type BrowserConfig } from '@test/runtime/config'
export type Config = BrowserConfig
export const Config = SharedConfig
export function apply(ctx: unknown, config: Config): void {}
`)
  return { root, write }
}

const serviceConfig = `
import Schema from '@deepseek-ai/schemastery'
export interface Config {
  /** Enable fixture routing. */
  enabled: boolean
}
export const Config = Schema.object({ enabled: Schema.boolean() })
`
const serviceRuntime = `
import { Context, Service } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
export class Runtime extends Service {
  static inject = ['llm', 'agents']
  static Config = Config
  constructor(ctx: Context, config: Config) { super(ctx, 'fixture') }
}
export default Runtime
`

function serviceFixture(entry = "export { default, Runtime } from './runtime.ts'\n") {
  const f = fixture()
  f.write('packages/test/provider/src/index.ts', entry)
  f.write('packages/test/provider/src/runtime.ts', serviceRuntime)
  f.write('packages/test/provider/src/config.ts', serviceConfig)
  return f
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('shared config schema catalog', () => {
  it('collects every branch through a renamed named import from a public source subpath', () => {
    const { root } = fixture()
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(new Set(provider?.schemaKeys)).toEqual(new Set(['mode', 'headless', 'endpoint']))
    expect(provider?.configTypeName).toBe('Config')
    expect(provider?.pastes?.[0]?.text).toBe('export type Config = BrowserConfig')
  })

  it('rejects a schema field absent from the shared config type', () => {
    const { root } = fixture(sharedSchema.replace('headless: Schema.boolean()', 'headless: Schema.boolean(), hidden: Schema.string()'))
    expect(() => collectConfigCatalog(root)).toThrow("schema validates key 'hidden' but config type 'Config' declares no such member")
  })

  it('follows a local const alias without treating a completed branch as a cycle', () => {
    const { root } = fixture(sharedSchema.replace('export const Shared = Schema.union', 'export const Shared = Base\nconst Base = Schema.union'))
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(new Set(provider?.schemaKeys)).toEqual(new Set(['mode', 'headless', 'endpoint']))
  })

  it('rejects type-only imports used as runtime schemas', () => {
    const { root, write } = fixture()
    write('packages/test/provider/src/index.ts', `
import type { Shared as SharedConfig, BrowserConfig } from '@test/runtime/config'
export type Config = BrowserConfig
export const Config = SharedConfig
export function apply(ctx: unknown, config: Config): void {}
`)
    expect(() => collectConfigCatalog(root)).toThrow("schema alias 'SharedConfig' must name a const or named value import")
  })

  it('rejects a private subpath even when TypeScript can resolve its source', () => {
    const { root, write } = fixture()
    write('packages/test/runtime/package.json', JSON.stringify({ name: '@test/runtime', exports: {} }))
    expect(() => collectConfigCatalog(root)).toThrow("does not explicitly export './config'")
  })

  it('rejects a missing source mapping', () => {
    const { root, write } = fixture()
    write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@test/runtime/config': ['./missing.ts'] } } }))
    expect(() => collectConfigCatalog(root)).toThrow('has no workspace source mapping')
  })

  it('rejects a source mapping into another package', () => {
    const { root, write } = fixture()
    write('tsconfig.json', JSON.stringify({ compilerOptions: {
      baseUrl: '.', paths: { '@test/runtime/config': ['./packages/test/provider/src/index.ts'] },
    } }))
    expect(() => collectConfigCatalog(root)).toThrow('must resolve inside packages/test/runtime/src')
  })

  it('rejects a schema value that the imported module does not export', () => {
    const { root } = fixture(sharedSchema.replace('export const Shared', 'const Shared'))
    expect(() => collectConfigCatalog(root)).toThrow("has no exported const 'Shared'")
  })

  it('rejects recursive const aliases', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = Loop
const Loop = Shared
`)
    expect(() => collectConfigCatalog(root)).toThrow('cyclic schema alias')
  })

  it('rejects a dynamic schema factory instead of dropping its keys', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = makeSchema()
`)
    expect(() => collectConfigCatalog(root)).toThrow('not a statically walkable schemastery call')
  })

  it('rejects an unresolved alias within a schema union', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = Schema.union([MissingSchema])
`)
    expect(() => collectConfigCatalog(root)).toThrow("schema alias 'MissingSchema' must name a const or named value import")
  })
})

describe('default plugin value export ownership', () => {
  it('keeps the package entry while resolving split Service metadata and local static Config', () => {
    const { root } = serviceFixture()
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(provider).toMatchObject({
      entry: 'packages/test/provider/src/index.ts', kind: 'config', className: 'Runtime',
      configTypeName: 'Config', inject: ['llm', 'agents'], schemaKeys: ['enabled'],
    })
    expect(provider?.pastes?.[0]?.source).toMatch(/^packages\/test\/provider\/src\/config\.ts:/)
    expect(provider?.pastes?.[0]?.text).toContain('enabled: boolean')
  })

  it.each([
    "export { Runtime as default } from './runtime.ts'",
    "import Runtime from './runtime.ts'; export default Runtime",
    "import { Runtime as Selected } from './runtime.ts'; export default Selected",
    "import Runtime from './runtime.ts'; export { Runtime as default }",
    "export { Renamed as default } from './barrel.ts'",
  ])('resolves class identity through %s', (entry) => {
    const f = serviceFixture(entry)
    f.write('packages/test/provider/src/barrel.ts', "export { Runtime as Renamed } from './runtime.ts'")
    expect(collectConfigCatalog(f.root).find(item => item.pkg === '@test/provider'))
      .toMatchObject({ kind: 'config', className: 'Runtime', schemaKeys: ['enabled'], inject: ['llm', 'agents'] })
  })

  it('follows a named class through export-star without forwarding the default', () => {
    const f = serviceFixture("export { Runtime as default } from './barrel.ts'")
    f.write('packages/test/provider/src/barrel.ts', "export * from './runtime.ts'")
    expect(collectConfigCatalog(f.root).find(item => item.pkg === '@test/provider')?.kind).toBe('config')
    f.write('packages/test/provider/src/index.ts', "export * from './runtime.ts'")
    expect(collectConfigCatalog(f.root).find(item => item.pkg === '@test/provider')?.kind).toBe('library')
  })

  it.each([
    'export default class Runtime { constructor(ctx: unknown) {} }',
    'export default function runtime(ctx: unknown): void {}',
  ])('classifies a reexported configless plugin: %s', (runtime) => {
    const f = serviceFixture()
    f.write('packages/test/provider/src/runtime.ts', runtime)
    expect(collectConfigCatalog(f.root).find(item => item.pkg === '@test/provider'))
      .toMatchObject({ kind: 'no-config', entry: 'packages/test/provider/src/index.ts' })
  })

  it('classifies a reexported abstract class as a service seam', () => {
    const f = serviceFixture()
    f.write('packages/test/provider/src/runtime.ts', 'export default abstract class Runtime {}')
    expect(collectConfigCatalog(f.root).find(item => item.pkg === '@test/provider'))
      .toMatchObject({ kind: 'seam', className: 'Runtime', inject: [] })
  })

  it('selects class-owned Config and inject instead of entry or declaring-module namespace decoys', () => {
    const f = serviceFixture(`
export { default } from './runtime.ts'
export const inject = ['entry-decoy']
export const Config = InvalidEntrySchema
export function apply(ctx: unknown, config: MissingConfig): void {}
`)
    f.write('packages/test/provider/src/runtime.ts', `
import Schema from '@deepseek-ai/schemastery'
export interface Config {
  /** Enable fixture routing. */
  enabled: boolean
}
export const Config = Schema.object({ namespaceOnly: Schema.boolean() })
export const inject = ['module-decoy']
export default class Runtime {
  static Config = Schema.object({ enabled: Schema.boolean() })
  static inject = ['actual-service']
  constructor(ctx: unknown, config: Config) {}
}
`)
    expect(collectConfigCatalog(f.root).find(item => item.pkg === '@test/provider'))
      .toMatchObject({ kind: 'config', schemaKeys: ['enabled'], inject: ['actual-service'] })
  })

  it('does not borrow namespace or instance metadata when a default class has none', () => {
    const f = serviceFixture()
    f.write('packages/test/provider/src/runtime.ts', `
export const Config = InvalidNamespaceSchema
export const inject = ['namespace-decoy']
export interface Options {
  /** Enable fixture routing. */
  enabled: boolean
}
export default class Runtime {
  Config = InvalidInstanceSchema
  inject = ['instance-decoy']
  constructor(ctx: unknown, config: Options) {}
}
`)
    expect(collectConfigCatalog(f.root).find(item => item.pkg === '@test/provider'))
      .toMatchObject({ kind: 'config', schemaKeys: null, inject: [] })
  })

  it('keeps the schema/type subset check across a local imported static schema', () => {
    const f = serviceFixture()
    f.write('packages/test/provider/src/config.ts', serviceConfig.replace('enabled: Schema.boolean()', 'enabled: Schema.boolean(), hidden: Schema.string()'))
    expect(() => collectConfigCatalog(f.root)).toThrow("schema validates key 'hidden' but config type 'Config' declares no such member")
  })

  it.each([
    "export type { default } from './runtime.ts'",
    "export { type default } from './runtime.ts'",
    "export type * from './runtime.ts'",
  ])('does not treat type-only exports as a runtime plugin: %s', (entry) => {
    const f = serviceFixture(entry)
    expect(collectConfigCatalog(f.root).find(item => item.pkg === '@test/provider')?.kind).toBe('library')
  })

  it.each([
    "import type Runtime from './runtime.ts'; export default Runtime",
    "import { type Runtime } from './runtime.ts'; export default Runtime",
  ])('rejects type-only imports used as runtime plugin bindings: %s', (entry) => {
    const f = serviceFixture(entry)
    expect(() => collectConfigCatalog(f.root)).toThrow('must name a class/function or value import')
  })

  it('rejects explicit reexport cycles instead of classifying them as libraries', () => {
    const f = serviceFixture()
    f.write('packages/test/provider/src/runtime.ts', "export { default } from './index.ts'")
    expect(() => collectConfigCatalog(f.root)).toThrow('cyclic plugin value export')
  })

  it.each([
    'export const other = 1',
    'class Runtime {}',
  ])('rejects missing runtime class exports: %s', (runtime) => {
    const f = serviceFixture("export { Runtime as default } from './runtime.ts'")
    f.write('packages/test/provider/src/runtime.ts', runtime)
    expect(() => collectConfigCatalog(f.root)).toThrow("has no exported plugin class/function 'Runtime'")
  })

  it.each([
    'export default createPlugin()',
    'const Runtime = createPlugin(); export default Runtime',
    "export * as default from './runtime.ts'",
  ])('rejects unsupported dynamic or namespace default plugins: %s', (entry) => {
    const f = serviceFixture(entry)
    expect(() => collectConfigCatalog(f.root))
      .toThrow(/not a statically resolvable|must name a class\/function|not a plugin class\/function/)
  })

  it.each(['./runtime', './runtime.js', '../outside.ts', '../../runtime/src/index.ts'])('refuses a non-source or escaped value target %s', (target) => {
    const f = serviceFixture(`export { default } from '${target}'`)
    expect(() => collectConfigCatalog(f.root)).toThrow('must resolve to an explicit .ts file inside its package src directory')
  })

  it('rejects a local schema import that escapes the package source directory', () => {
    const f = serviceFixture()
    f.write('packages/test/provider/src/runtime.ts', serviceRuntime.replace("'./config.ts'", "'../../runtime/src/config.ts'"))
    expect(() => collectConfigCatalog(f.root)).toThrow('must resolve to an explicit .ts file inside its package src directory')
  })

  it('allows repeated star paths to one class but rejects conflicting class identities', () => {
    const f = serviceFixture("export { Runtime as default } from './barrel.ts'")
    f.write('packages/test/provider/src/barrel.ts', "export * from './left.ts'; export * from './right.ts'")
    f.write('packages/test/provider/src/left.ts', "export { Runtime } from './runtime.ts'")
    f.write('packages/test/provider/src/right.ts', "export { Runtime } from './runtime.ts'")
    expect(collectConfigCatalog(f.root).find(item => item.pkg === '@test/provider')?.kind).toBe('config')
    f.write('packages/test/provider/src/right.ts', 'export class Runtime {}')
    expect(() => collectConfigCatalog(f.root)).toThrow("ambiguous plugin value export 'Runtime'")
  })

  it('continues a star-export search past a legal cycle to the defining class', () => {
    const f = serviceFixture("export { Runtime as default } from './barrel.ts'")
    f.write('packages/test/provider/src/barrel.ts', "export * from './loop.ts'; export * from './runtime.ts'")
    f.write('packages/test/provider/src/loop.ts', "export * from './barrel.ts'")
    expect(collectConfigCatalog(f.root).find(item => item.pkg === '@test/provider')?.kind).toBe('config')
  })

  it('rejects a type-only local schema import and a cycle across local schema const imports', () => {
    const f = serviceFixture()
    f.write('packages/test/provider/src/runtime.ts', serviceRuntime.replace('import { Config }', 'import type { Config }'))
    expect(() => collectConfigCatalog(f.root)).toThrow("schema alias 'Config' must name a const or named value import")
    f.write('packages/test/provider/src/runtime.ts', serviceRuntime)
    f.write('packages/test/provider/src/config.ts', `${serviceConfig.replace(
      'Schema.object({ enabled: Schema.boolean() })', 'Other',
    )}\nimport { Other } from './other.ts'`)
    f.write('packages/test/provider/src/other.ts', "import { Config } from './config.ts'; export const Other = Config")
    expect(() => collectConfigCatalog(f.root)).toThrow('cyclic schema alias')
  })

  it('rejects an unexported local schema and a dynamic imported schema initializer', () => {
    const f = serviceFixture()
    f.write('packages/test/provider/src/config.ts', serviceConfig.replace('export const Config', 'const Config'))
    expect(() => collectConfigCatalog(f.root)).toThrow("has no exported const 'Config'")
    f.write('packages/test/provider/src/config.ts', serviceConfig.replace('Schema.object({ enabled: Schema.boolean() })', 'createSchema()'))
    expect(() => collectConfigCatalog(f.root)).toThrow('not a statically walkable schemastery call')
  })
})
