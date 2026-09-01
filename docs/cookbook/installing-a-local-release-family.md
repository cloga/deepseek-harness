# Install a local release family

English | [中文](installing-a-local-release-family.zh.md)

Use this tutorial when DSH Desktop must run a local DeepSeek Harness commit without resolving unpublished fork packages from npm or loading modules from Desktop's packaged Core.

## Prerequisites

Build and pack from one clean checkout with Node.js and pnpm versions supported by the repository. The installer downloads only external dependencies; every `@deepseek-ai/*` runtime dependency and peer must be present in the supplied tarballs.

## Build and pack

Produce the official client artifacts and all three runtime release inputs:

```powershell
pnpm run build:official
pnpm run release:pack --family dsh --out dist/npm
pnpm run release:pack --family vendor --out dist/npm-vendor
pnpm --dir native/landlock-run/packages/entry pack --pack-destination "$PWD/dist/npm-landlock"
```

`release:pack` validates each DSH package payload and records dependency-safe family order. Installing only `@deepseek-ai/dsh` is not supported for a local fork because its sibling versions may not exist in the registry.

## Install the isolated prefix

Select the exact commit and version you intend Desktop to run:

```powershell
$commit = git rev-parse HEAD
$version = node -p "require('./apps/cli/package.json').version"
pnpm run release:install-local -- `
  --from dist/npm `
  --from dist/npm-vendor `
  --from dist/npm-landlock `
  --expect-commit $commit `
  --expect-version $version
```

The default prefix is `$HOME/.dsh/local-cli/<commit>`. Pass `--prefix <directory>` to select another isolated or global npm prefix.

The installer fails before npm runs when an ordered tarball is absent or the supplied packages omit a fork-owned runtime dependency or peer. It verifies every DSH payload, selects the recursive dependency/peer closure rooted at `@deepseek-ai/dsh`, installs that closure in dependency order, and writes `dsh-local-install.json` with the repository URL, commit SHA, CLI package/version, release-manifest SHA-256, Desktop-compatible root `cliPath`, and individual installed-tarball hashes. The schema-version 1 receipt also seals the staged root shim, npm shim, and `@deepseek-ai/dsh` entrypoint with deterministic prefix-relative paths and SHA-256 values before publishing the prefix. Test-support and build-only family members remain verified pack inputs but do not become runtime roots.

The npm install has a five-minute default limit and the Web probe has a 30-second default limit. Override them with `--install-timeout-ms` and `--boot-timeout-ms`; a timeout fails with the bounded output tail. The Web probe clears `NODE_PATH` and `NODE_OPTIONS` and waits for `dsh --profile web --port 0 --no-open` to report its URL.

## Select the CLI in Desktop

Set `DSH_CLI_PATH` to the final path printed by the installer. On Windows this is `<prefix>\dsh.cmd`; on macOS and Linux it is `<prefix>/dsh`. The root shim delegates to npm's internal `node_modules/.bin` shim, so Desktop can derive the installed package root from the selected prefix.

Re-running the command for the same commit replaces the prefix only after the staged installation passes all checks. A failed installation leaves the previously selected prefix unchanged.
