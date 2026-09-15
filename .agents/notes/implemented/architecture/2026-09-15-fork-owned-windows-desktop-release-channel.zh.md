# Agent Note: 在源码中拥有 fork Windows Desktop 发布通道

Status: implemented

[English](2026-09-15-fork-owned-windows-desktop-release-channel.md) | 中文

## 问题

cloga Windows Desktop fork 需要未签名 installer 与托管更新路径，同时不能声称官方供应商的应用身份、签名或原生更新信任。发布定义如果分散在源码仓库与 Windows Ops，版本、源码 commit、installer hash、插件 provisioning 或 completion 语义可能发生分歧。

固定未来 manifest URL 无法支持持续更新，因为打包应用无法预知下一个 release 的 hash。可变的任意 feed URL 会把发布权威移出经过评审的源码，并允许回滚或 origin 变化。

## 决策

`cloga/deepseek-harness` 拥有经过评审的 Windows x64 release plan、固定 fork 身份、installer 构建、托管 capability、release manifest、build receipt、checksums、不可变 Git tag 与 GitHub Release。Windows Ops 锁定、验证并部署这些由源码拥有的资产，不发布并行的长期 Desktop release 定义。

fork 身份为 `io.github.cloga.deepseek-harness.desktop`，产品为 `DeepSeek Harness (cloga)`，包为 `cloga-deepseek-harness-desktop`，可执行文件为 `cloga-deepseek-harness`，artifact 前缀为 `cloga-deepseek-harness`。Installer 是未签名交互式 NSIS。它不接收静默参数，Windows warning、installer 选择、elevation 与 UAC 仍由用户控制。原生 `electron-updater` 被禁用，包中不存在 `app-update.yml`。

经过评审的 plan 推进语义化 channel version 与整数 sequence。第一个由源码拥有的版本高于 `0.1.5-rc.2.local.1` 过渡构建，并使用 sequence 2。Tag 使用 `dsh-desktop-v<version>`，绝不覆盖历史。

## 发布记录

Manifest schema 3 对规范 JSON 进行 self-hash，并记录源码 repository、commit、tree、tag、upstream version、sequence、workflow path、lockfile hash、plan hash、固定 Node 与 pnpm 版本、依赖物化 registry、fork identities、installer filename、byte size、SHA-256、SHA-512、未签名 Authenticode 状态、build-receipt hashes、已安装 executable 与 runtime hashes、网络策略和交互式重启后 completion 语义。

插件 provisioning 记录完整 `desktopNativeVerifiedRelease` capability，包括 capability schema 1 与结构化 source 和 receipt schema version 1。它锁定 `dsh-github-copilot` GitHub Release source，以及预期 release 与 asset identifiers。预期 native transaction receipt hash 包含 staging、health、activation、rollback 与 verification states。

Build receipt 独立 self-hash，并记录相同的 source、build inputs、identity、artifact evidence、helper 与 capability hashes、native-updater exclusion、network policy、installation policy 与 plugin receipt expectation。`SHA256SUMS` 与 `SHA512SUMS` 覆盖 installer、manifest 与 receipt。

## 发现与安装

Capability schema 2 只包含固定的 `cloga/deepseek-harness` owner、`dsh-desktop-v` tag prefix、`release.json` asset name、包内 sequence、minimum sequence 与一个精确 migration record。它不接受用户选择的 repository 或 URL。

Check 列出固定 repository 的 GitHub Releases。每个匹配 release 必须已经发布、不可变、锁定 commit，并携带恰好一个具有 GitHub SHA-256 digest 的已上传 manifest asset。Desktop 把 tag 解析到同一 commit，验证 raw asset digest，解析 self-hashed manifest，并选择最高且不冲突的 sequence。包内 sequence 防止企业部署后的 self-selection；durable completion receipt 防止回滚。

所选 handoff 同时锁定 manifest 的规范 self-hash 与 raw release-asset SHA-256。独立 helper 在下载 receipt 与 installer 前重新验证二者。Completion 在记录新 sequence 前验证运行中的 executable、runtime descriptor、预期 GitHub release 与 asset identifiers，以及完整 native plugin transaction receipt。

不可变 `cloga/dsh-windows-ops` `dsh-local-0.1.5-rc.2.local.1` manifest 仅在源码 repository 没有匹配 release 时作为精确 sequence-zero migration 保留。任何格式错误、可变、冲突或不可达的 source release 都会 fail closed，不会 fallback。一旦 source release 存在，Windows Ops 不能充当第二通道。

## 发布

手动 Windows workflow 只能从当前 `master` 运行，并要求操作员重复经过评审的 plan version。不带凭据的 build job 使用干净 checkout、固定 Node 与 pnpm、冻结 lockfile、focused Desktop tests 与未签名 packaging。它验证独立 helper 没有 relative import、包内 capability 与经过评审的 plan 匹配、`app-update.yml` 不存在，并且 installer 与 installed evidence 匹配生成记录。

受保护 release job 是唯一具有 `contents: write` 的 job。它下载 build artifact，交叉检查完整 asset set，以精确 source commit tag 创建 draft，上传每个 asset，并只在 asset set 完整后发布。随后它要求 GitHub 报告 release immutable，tag 与 release target 解析到 build commit，并且每个 remote asset digest 匹配本地 bytes。最后一个不带凭据的 job 针对 GitHub 运行已发布 discovery，并要求它选择经过评审的 version、sequence、commit 与 tree。

## 考虑过的替代方案

**让 Windows Ops 继续作为第二 release owner。** 两份 manifest 与 build definition 可能不一致，而且 operational repository 无法权威证明其打包的 source tree 与 application protocol。

**为未签名 generic feed 使用 electron-updater。** Native update mode 依赖 publisher 与 platform-signature validation。为未签名 artifact 启用它会削弱官方更新安全模型，并生成不安全的可变 channel metadata。

**嵌入下一个 release URL 与 hash。** 当前 build 无法知道尚未创建的 successor，因此每个包都会终止通道，或需要 out-of-band rebuild。

**使用可变 channel index。** 可变 index 需要独立的 signing 与 key-rotation system。固定 GitHub owner 与 tag discovery、不可变 releases、asset digests、精确 tag commits、self-hashed manifests 与单调本地 sequence 提供持续 discovery，不需要另一把 signing key。

## 结果

每个新 fork release 都需要经过评审的 plan change 与受保护的手动 workflow run。GitHub release immutability 是强制要求；repository setting 缺失时 publication 失败。源码通道依赖 GitHub API 与 immutable Release service，并且当 channel 超出一个有界 API page 时拒绝 discovery，直到 capability version 发生变化。

未签名 installer 会继续显示 Windows trust warning，并可能要求 UAC。fork 身份防止这些 artifact 表现为已签名官方 vendor release。Windows Ops 保留 enterprise pinning 与 deployment 工作，而 source code、protocol、release identity 与 immutable bytes 只有一个 owner。
