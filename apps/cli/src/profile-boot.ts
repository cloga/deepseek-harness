/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, apply its selected patch-reload
 * lifecycle, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  assertNoLegacyHmrOverride,
  composeEntries,
  createProfileResolutionGeneration,
  healProfilesModuleFallback,
  healIsolatedProfileModuleFallback,
  initProfile,
  installFailLoud,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PluginPackages,
  prepareProfileRootConfig,
  PROFILE_PATCH_FILENAME,
  PROFILE_ROOT_FILENAME,
  PROFILE_TEMPLATES,
  writeProfileRootConfig,
  resolveProfileDir,
  type Profile,
  type ProfileContext,
  type ProfileResolutionGeneration,
  type ProfileResolutionMode,
} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-hmr'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/** Launcher-owned readiness signal committed only after boot and host setup succeed. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** Root config filename inside a profile directory; canonical bytes are shared with staging. */
export { PROFILE_ROOT_FILENAME }

/**
 * Initialize a missing profile from one shipped template. This copies only
 * the template's bundle list and patch-reload policy; local state from the
 * same-named shipped profile is not read, and no inheritance metadata is
 * persisted. Shipped profile names are reserved, and the target directory is
 * claimed exclusively so existing or concurrent state is never reused.
 * @param name - the new profile name.
 * @param fromDefaultProfile - shipped profile template to copy.
 * @param home - Harness home containing the profile directory.
 * @throws when the template is unknown, the target name is shipped, or the target directory exists.
 */
export function initializeProfileFromDefault(
  name: string,
  fromDefaultProfile: string,
  home: string = resolveDshHome(),
): void {
  const dir = resolveProfileDir(name, home)
  const template = Object.hasOwn(PROFILE_TEMPLATES, fromDefaultProfile)
    ? PROFILE_TEMPLATES[fromDefaultProfile]
    : undefined
  if (template === undefined) {
    const expected = Object.keys(PROFILE_TEMPLATES).sort().map(value => JSON.stringify(value)).join(', ')
    throw new Error(
      `${NAME}: unknown default profile ${JSON.stringify(fromDefaultProfile)}; expected one of ${expected}`,
    )
  }
  if (Object.hasOwn(PROFILE_TEMPLATES, name)) {
    throw new Error(
      `${NAME}: profile ${JSON.stringify(name)} is shipped and cannot be a custom profile target; `
      + 'omit --from-default-profile to use it',
    )
  }
  mkdirSync(dirname(dir), { recursive: true })
  try {
    mkdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      throw new Error(
        `${NAME}: profile ${JSON.stringify(name)} already exists at ${manifestPath}; `
        + 'omit --from-default-profile to use it',
      )
    }
    throw new Error(
      `${NAME}: profile directory ${dir} already exists; choose an unused profile name`,
    )
  }
  try {
    initProfile(dir, template.bundles, template.patchReload)
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${NAME}: profile initialization failed and ${dir} could not be removed`,
      )
    }
    throw error
  }
}

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Load a resolved profile for `name` and (re)write the empty root config. The
 * root is always rewritten: the whole composition is patch layers, and the
 * vendored Loader's tree write-back (a plugin self-disposing persists the
 * current tree) can bake composed rows into this file — which would duplicate
 * every bundle insert on the next boot. The file exists on disk only because
 * the Loader needs a real include root to anchor `baseUrl` at the profile
 * directory (the config dump anchors on the same file, so both compose over
 * the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @param fromDefaultProfile - shipped template used once to initialize a missing profile.
 * @returns the loaded profile.
 * @throws when explicit initialization names an unknown template or an existing profile.
 */
export function prepareProfile(name: string, userLayer = true, fromDefaultProfile?: string): Profile {
  if (fromDefaultProfile !== undefined) initializeProfileFromDefault(name, fromDefaultProfile)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  writeProfileRootConfig(profile.dir)
  return profile
}

/** One profile's patch layers, in application order. */
interface ComposedProfile {
  profile: Profile
  /** Immutable package fallback selected before any plugin imports. */
  resolution: ProfileResolutionGeneration
  /** Bundle layers concatenated — the part below the user layers on a live reload. */
  bundlePatches: PatchOptions[]
  /** The home-level user layer (`$DSH_HOME/cordis.patch.yml`), applied after the profile's own. */
  homePatches: PatchOptions[]
  /** Layers above the user layers on a live reload: `--patch` overlays and the telemetry switch. */
  overlays: PatchOptions[]
}

/** The full patch stack of one composed profile, in application order. */
function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...composed.overlays,
  ]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (a base-backed profile gets the base bundle's
 * platform-gated shell rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile and its patch layers.
 */
async function composeProfile(
  name: string,
  patchFiles: readonly string[],
  resolutionMode: ProfileResolutionMode,
  fromDefaultProfile?: string,
  resolvedProfile?: ResolvedProfileRuntime,
): Promise<ComposedProfile> {
  const profile = resolvedProfile?.profile ?? prepareProfile(name, true, fromDefaultProfile)
  if (resolvedProfile !== undefined) prepareProfileRootConfig(profile.dir)
  const resolutionOptions = { installAnchor: resolvedProfile?.installAnchor ?? INSTALL_ANCHOR, profile }
  if (resolvedProfile !== undefined && resolutionMode !== 'runtime') healIsolatedProfileModuleFallback(resolvedProfile)
  const resolution = resolutionMode === 'runtime' || resolvedProfile !== undefined
    ? await createProfileResolutionGeneration(resolutionOptions)
    : await healProfilesModuleFallback(resolutionOptions)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  assertNoLegacyHmrOverride([...bundlePatches, ...profile.patches, ...homePatches, ...overlays])
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const composedOverlays = [...overlays]
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
  return { profile, resolution, bundlePatches, homePatches, overlays: composedOverlays }
}

/** Application-owned profile plus the installation that supplies its runtime packages. */
export interface ResolvedProfileRuntime {
  readonly profile: Profile
  readonly installAnchor: string
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** Already loaded application-owned profile; never initialize another named user profile. */
  resolvedProfile?: ResolvedProfileRuntime
  /** Shipped template used once to initialize a missing profile. */
  fromDefaultProfile?: string | undefined
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
  /** Application-owned package executable, scoped to explicit plugin operations. */
  packageManager?: ProfileContext['packageManager']
  /** Refuse live mutations when the launcher does not provide its staged package service. */
  stagedPackageTransactions?: boolean
  /** Fiber-owned Host services installed before any profile entry mounts. */
  prepare?: (ctx: Context) => void | Promise<void>
  /** Module fallback backend; pkg executables always use runtime resolution. */
  resolutionMode?: ProfileResolutionMode
}

/**
 * Re-throw a watcher-setup failure unless a shutdown already owns the tree:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @param error - the setup failure.
 */
function suppressShutdownError(ctx: Context, signal: AbortSignal, error: unknown): void {
  if (signal.aborted) return
  if (ctx.fiber.state !== FiberState.ACTIVE || ctx.get('loader') === undefined) return
  throw error
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  if (options.resolvedProfile !== undefined && options.fromDefaultProfile !== undefined) {
    throw new Error('dsh: application-owned profile cannot initialize a separate named profile')
  }
  if (options.resolvedProfile !== undefined && options.resolvedProfile.profile.name !== options.profile) {
    throw new Error('dsh: application-owned profile name differs from the requested launch identity')
  }
  // Before the first plugin mounts and before anything can issue a request: Node's fetch ignores the
  // proxy environment on its own, so every profile would otherwise connect directly. Resolving from
  // the launcher's snapshot — not `process.env` — is what lets a proxy declared in a `.env` layer
  // work, which the NODE_USE_ENV_PROXY flag cannot do because Node samples the environment at start.
  const disposeProxy = await installProxyFromEnvironment(
    options.environment,
    (message) => { process.stderr.write(`${NAME}: ${message}\n`) },
  )

  const app: { current?: Context } = {}
  let disposing: Promise<void> | undefined
  const dispose = (): Promise<void> => disposing ??= (async () => {
    const failures: unknown[] = []
    try { await app.current?.fiber.dispose() } catch (error) { failures.push(error) }
    try { await disposeProxy() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dsh: profile cleanup failed')
  })()
  try {
    const packaged = (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined
    const resolutionMode = packaged ? 'runtime' : options.resolutionMode ?? (options.resolvedProfile === undefined ? 'link' : 'runtime')
    const composed = await composeProfile(
      options.profile, options.patchFiles, resolutionMode, options.fromDefaultProfile, options.resolvedProfile,
    )
    const appReady = createAppReady()
    const shutdown = createProcessShutdown(dispose)
    const signalShutdown = new AbortController()
    const interrupt = (code: number): void => {
      signalShutdown.abort()
      shutdown.interrupt(code)
    }
    // Signals own teardown throughout the startup window, not only after boot()
    // settles: an inserted provider can publish before sibling rows finish mounting.
    // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
    // surface — the launcher does not know whether the app considered its work
    // complete; SIGINT is a user interrupt and reports 130.
    process.on('SIGTERM', () => { interrupt(0) })
    process.on('SIGINT', () => { interrupt(130) })
    installFailLoud(NAME, process, async () => {
      await app.current?.fiber.dispose()
    })

    const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
    // Loader mutates inserted rows by reference. Clone this invocation's
    // complete boot generation; the official HMR service reads fresh ProfileContext
    // layers under its own serialized queue when a live named profile changes.
    const profileContext: ProfileContext = {
      name: options.profile,
      ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
      ...(options.stagedPackageTransactions === undefined ? {} : { stagedPackageTransactions: options.stagedPackageTransactions }),
      watchProfilePatches: options.resolvedProfile === undefined && composed.profile.patchReload === 'live',
      dir: composed.profile.dir, patchPath: composed.profile.patchPath,
      installAnchor: options.resolvedProfile?.installAnchor ?? INSTALL_ANCHOR,
      cwd: process.cwd(), home: resolveDshHome(),
      startedBundles: composed.profile.layers.map(layer => layer.packageName),
      overlays: composed.overlays, telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    }
    const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), async (hostCtx) => {
      app.current = hostCtx
      hostCtx.provide('profileContext', profileContext)
      // Before any config-tree entry mounts, so plugins resolve all launch-time
      // environment values from the same immutable launch snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      await hostCtx.plugin(PluginPackages, resolutionMode === 'link' ? {} : {
        generation: composed.resolution,
        behavior: resolutionMode === 'dual' ? 'verify' : 'enforce',
      })
      // The command line and bounded exit request are launcher facts available
      // to every app plugin that injects the argument snapshot.
      provideCmdline(hostCtx, {
        args: options.args,
        exit: code => void shutdown.shutdown(code),
        ready: appReady.service,
      })
      await options.prepare?.(hostCtx)
      if (options.stagedPackageTransactions === true && hostCtx.get('profilePackageTransactions')?.protocolVersion !== 1) {
        throw new Error('dsh: launcher package staging is required but unavailable')
      }
    })
    app.current = ctx
    // A named live profile can dispose the whole tree while the official HMR
    // service opens its configuration watches. The launcher skips a tree that
    // already exited; startup-frozen and application-owned profiles acquire no
    // automatic profile/home/manifest watcher.
    if (profileContext.watchProfilePatches === true
      && !signalShutdown.signal.aborted
      && ctx.fiber.state === FiberState.ACTIVE
      && ctx.get('loader') !== undefined) {
      try {
        // The base bundle disables source-module reload. Its absent HMR service
        // is installed watch-only for named live profile/home/manifest patches;
        // a user who explicitly enabled the base row keeps opt-in module reload.
        if (ctx.get('hmr') === undefined) {
          if (ctx.get('timer') === undefined) {
            await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
          }
          await ctx.loader.create({ name: '@deepseek-ai/dsh-hmr', config: { root: [] } })
          await ctx.loader.await()
        }
      } catch (error) {
        suppressShutdownError(ctx, signalShutdown.signal, error)
      }
    }
    // A legacy user HMR row must not silently satisfy a startup-frozen or
    // application-owned profile either: the official manager needs runExclusive
    // whenever any HMR service is mounted, regardless of who owns patch watches.
    if (!signalShutdown.signal.aborted && ctx.fiber.state === FiberState.ACTIVE
      && ctx.get('loader') !== undefined) {
      const current: unknown = ctx.get('hmr')
      if (current !== undefined && (typeof current !== 'object' || current === null
        || !('runExclusive' in current) || typeof current.runExclusive !== 'function')) {
        throw new Error('dsh: profile HMR requires official serialized HMR; remove the legacy HMR row')
      }
      if (profileContext.watchProfilePatches === true && current === undefined) {
        throw new Error('dsh: live profile requires official serialized HMR')
      }
    }
    if (!signalShutdown.signal.aborted
      && ctx.fiber.state === FiberState.ACTIVE
      && ctx.get('loader') !== undefined) {
      appReady.commit()
    }
    return { ctx, shutdown }
  } catch (error) {
    try { await dispose() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'dsh: profile startup and cleanup failed')
    }
    throw error
  }
}
