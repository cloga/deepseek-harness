# Agent Note: 本地发布族安装

Status: implemented

[English](2026-08-26-local-release-family-install.md) | 中文

## Problem

本地 DSH tarball 会声明运行时所需的同版本 Harness 包。只安装 `@deepseek-ai/dsh` 会把这些名称交给 npm，而 fork commit 的版本可能尚未发布。手动安装许多 tarball 可能遗漏 vendored 或 native 兼容包，成功启动也可能意外从嵌入它的 Desktop 安装中解析模块。

## Decision

`release:install-local` 把 DSH、vendor 和 native 打包目录作为一个本地产物单元消费。它要求完整 DSH 发布族，以及所提供 manifest 可达的每个 fork 自有依赖或 peer；它拒绝顺序文件中缺失的条目，校验每个 DSH payload，并按确定性的依赖优先顺序安装以 `@deepseek-ai/dsh` 为根的递归运行时闭包。测试支持与仅构建使用的发布族成员仍是经过验证的输入，但不会成为运行时根。

该命令安装到 staging npm prefix，校验选定 checkout commit 和 DSH 版本，应用 DSH tarball payload 策略，记录每个 tarball 的 SHA-256 和文件数，并在移除 `NODE_PATH` 与 `NODE_OPTIONS` 后驱动已安装的 JavaScript entry。它创建稳定的 prefix 根 shim，并由该 shim 委托给 npm 的内部 shim。staged 根 shim 必须通过 `dsh --profile web --port 0 --no-open` 报告 Web URL，之后已验证目录才能替换选定 prefix；如果替换移动失败，发布过程会恢复原 prefix。receipt 和 `DSH_CLI_PATH` 选择根 shim，使 Desktop 可以从 prefix 推导 `node_modules/@deepseek-ai/dsh`。

这个安装工作流扩展了 [npm 发布序列](2026-08-10-npm-release-sequences.zh.md) 所拥有的 packed-artifact 保证；它不改变发布成员、版本或 registry 行为。

## Alternatives considered

**只安装 CLI tarball。** 这种方案依赖 registry 已经包含每个同版本 fork 包，无法测试尚未发布的 commit。

**把 tarball 直接安装到 Desktop 打包的 Core。** 这会把产品自有模块和测试候选混在一起，使回滚含糊，也无法证明候选的运行时闭包自包含。

**使用 workspace link。** link 会绕过 packed payload 选择，并允许未构建或不会发布的源文件满足 import，因此无法测试 Desktop 将执行的发布产物。

## Consequences

本地 Desktop 测试获得一个可重复的 prefix，其中包含确切 commit、版本、payload 清单和 tarball hash。重新运行命令时，只有新的 staged 安装通过才会替换该 prefix；不完整闭包会在 registry 解析可能掩盖问题之前失败。

该工作流要求完整 DSH pack 输出，但只安装 CLI 运行时闭包。这样既让 payload 校验与维护的发布族成员保持一致，也避免把无关测试与构建依赖放入 Desktop prefix。
