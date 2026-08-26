# 安装本地发布族

[English](installing-a-local-release-family.md) | 中文

当 DSH Desktop 需要运行本地 DeepSeek Harness commit，同时不能从 npm 解析尚未发布的 fork 包，也不能从 Desktop 打包的 Core 加载模块时，使用本教程。

## 前置条件

使用仓库支持的 Node.js 和 pnpm 版本，在同一个干净 checkout 中构建并打包。安装器只下载外部依赖；所提供的 tarball 必须包含每个 `@deepseek-ai/*` 运行时依赖和 peer。

## 构建并打包

生成正式客户端产物和三个运行时发布输入：

```powershell
pnpm run build:official
pnpm run release:pack --family dsh --out dist/npm
pnpm run release:pack --family vendor --out dist/npm-vendor
pnpm --dir native/landlock-run/packages/entry pack --pack-destination "$PWD/dist/npm-landlock"
```

`release:pack` 校验每个 DSH 包的 payload，并记录依赖安全的发布族顺序。本地 fork 不支持只安装 `@deepseek-ai/dsh`，因为其同版本 sibling 可能尚未存在于 registry。

## 安装隔离 prefix

选择希望 Desktop 运行的确切 commit 和版本：

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

默认 prefix 是 `$HOME/.dsh/local-cli/<commit>`。传入 `--prefix <directory>` 可以选择其他隔离或全局 npm prefix。

如果顺序文件中的 tarball 缺失，或提供的包遗漏 fork 自有的运行时依赖或 peer，安装器会在运行 npm 前失败。它校验每个 DSH payload，选择以 `@deepseek-ai/dsh` 为根的递归 dependency/peer 闭包，按依赖顺序安装该闭包，并在 `dsh-local-install.json` 中写入 repository URL、commit SHA、CLI package/version、release-manifest SHA-256 和各已安装 tarball hash。测试支持与仅构建使用的发布族成员仍是经过验证的 pack 输入，但不会成为运行时根。

npm install 默认限制为五分钟，Web probe 默认限制为 30 秒。用 `--install-timeout-ms` 和 `--boot-timeout-ms` 覆盖；超时会携带有界的输出尾部并失败。Web probe 会清除 `NODE_PATH` 和 `NODE_OPTIONS`，并等待 `dsh --profile web --port 0 --no-open` 报告 URL。

## 在 Desktop 中选择 CLI

把 `DSH_CLI_PATH` 设置为安装器最终打印的路径。在 Windows 上是 `<prefix>\node_modules\.bin\dsh.cmd`；在 macOS 和 Linux 上是 `<prefix>/node_modules/.bin/dsh`。

针对同一 commit 重新运行命令时，只有 staged 安装通过所有检查后才会替换 prefix。安装失败会保留先前选择的 prefix。
