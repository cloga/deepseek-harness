# Agent Note: 在源码中拥有 fork Windows Desktop 发布通道

Status: implemented

[English](2026-09-15-fork-owned-windows-desktop-release-channel.md) | 中文

## 问题

cloga Windows Desktop fork 需要未签名 installer 与托管更新路径，同时不能声称官方供应商的应用身份、签名或原生更新信任。发布定义如果分散在源码仓库与 Windows Ops，版本、源码 commit、installer hash、插件 capability 兼容性或 completion 语义可能发生分歧。

固定未来 manifest URL 无法支持持续更新，因为打包应用无法预知下一个 release 的 hash。可变的任意 feed URL 会把发布权威移出经过评审的源码，并允许回滚或 origin 变化。

## 决策

Windows Ops 每次选择并锁定一个受支持的 upstream baseline。`cloga/deepseek-harness` 在经过评审的 Windows x64 release plan 中记录该 baseline，并拥有固定 fork 身份、installer 构建、托管 capability、release manifest、build receipt、checksums、不可变 Git tag 与 GitHub Release。Windows Ops 锁定、验证并部署这些由源码拥有的资产，不发布并行的长期 Desktop release 定义。

fork 身份为 `io.github.cloga.deepseek-harness.desktop`，产品为 `DeepSeek Harness (cloga)`，包为 `cloga-deepseek-harness-desktop`，可执行文件为 `cloga-deepseek-harness`，artifact 前缀为 `cloga-deepseek-harness`。Installer 是未签名交互式 NSIS。它不接收静默参数，Windows warning、installer 选择、elevation 与 UAC 仍由用户控制。原生 `electron-updater` 被禁用，包中不存在 `app-update.yml`。

经过评审的 plan 推进语义化 channel version 与整数 sequence。第一个由源码拥有的版本高于 `0.1.5-rc.2.local.1` 过渡构建，并使用 sequence 2。Tag 使用 `dsh-desktop-v<version>`，绝不覆盖历史。

## 发布记录

Manifest schema 3 对规范 JSON 进行 self-hash，并记录源码 repository、commit、tree、tag、upstream version、sequence、workflow path、lockfile hash、plan hash、固定 Node 与 pnpm 版本、依赖物化 registry、fork identities、installer filename、byte size、SHA-256、SHA-512、未签名 Authenticode 状态、build-receipt hashes、已安装 executable 与 runtime hashes、网络策略和交互式重启后 completion 语义。

安装后的运行时描述文件为 `resources/app.asar/dsh/desktop-runtime.json`；receipt 对打包 Electron 在 Node 模式下读取的归档原始字节计算哈希，而非重新序列化的 JSON。构建时的[打包运行时检查](../../../../apps/desktop/scripts/packaged-runtime.mjs)使用构建器的 ASAR 读取器拒绝不安全路径与链接，核对物理解包文件集合完全一致，并把实际字节物化到私有临时验证目录。归档内文件的可执行标志取自 ASAR，解包文件的模式取自物理文件，因为 Electron 的虚拟 stat 会合成权限且遗漏未登记的 sidecar 文件。未修改的清单验证器通过有界、环境已清理的 Electron Node 模式检查该副本，并在子进程退出后清理。该副本不是安装后的运行时，也不是第二个权威来源，且不启动 Host 或 profile。发布 workflow 在 finalization 前使用打包 Electron 运行清单 canary 检查。

插件兼容性保留 manifest schema 3 对完整通用 `desktopNativeVerifiedRelease` capability 的记录，包括 capability schema 1 与结构化 source 和 receipt schema version 1，并设置 `automaticProvisioning: false`。保持该记录不变，使已安装的 0.1.5 client 能够解析并安装包含 provisioning 实现的 release。

经过评审的 release plan schema 2 携带通用精确状态 Desktop 插件 plan；schema 1 会规范化为空 plan，使现有且版本中立的 release 定义仍然可读。Build receipt 独立 self-hash，并记录相同的 source、build inputs、identity、artifact evidence、helper 与 capability hashes、已发布 provisioning plan 的文件 hash 与规范 hash、native-updater exclusion、network policy、installation policy 与通用插件 schema 兼容性。`SHA256SUMS` 与 `SHA512SUMS` 覆盖 installer、provisioning plan、manifest 与 receipt。

仅构建使用的元数据发现可以通过 [release fetch adapter](../../../../apps/desktop/scripts/desktop-release-github-fetch.ts) 显式接收 `DSH_DESKTOP_RELEASE_GITHUB_TOKEN`。CI 只向 preparation 与 remote verification 提供其只读 Actions token，不传给 packaging 或应用。仅固定 GitHub API repository 的规范 release-list 与 tag-resolution GET 请求携带认证。带认证的重定向会失败关闭；下载及其他 origin 保持匿名，并移除调用方的 authorization/cookie。传输和响应错误不输出任意远端文本，只保留安全的取消分类或数字 HTTP 状态。未提供 token 时仍匿名发现；不会读取凭据存储或环境中的 `GH_TOKEN`，receipt 也绝不包含 token。已发布应用的行为保持不变。

## 发现与安装

Capability schema 3 包含固定的 `cloga/deepseek-harness` owner、`dsh-desktop-v` tag prefix、`release.json` asset name、包内 sequence、minimum sequence、精确插件 provisioning capability 与规范 plan hash，以及一个精确 migration record。它不接受用户选择的 repository 或 URL。

Check 列出固定 repository 的 GitHub Releases。每个匹配 release 必须已经发布、不可变、锁定 commit，并携带恰好一个具有 GitHub SHA-256 digest 的已上传 manifest asset。Desktop 把 tag 解析到同一 commit，验证 raw asset digest，解析 self-hashed manifest，并选择最高且不冲突的 sequence。包内 sequence 防止企业部署后的 self-selection；durable completion receipt 防止回滚。

所选 handoff 同时锁定 manifest 的规范 self-hash 与 raw release-asset SHA-256。独立 helper 在下载 receipt 与 installer 前重新验证二者。下次启动时，Desktop 会在 Host 启动前协调打包的插件 plan。Completion 在记录新 sequence 前验证运行中的 executable、runtime descriptor、预期 GitHub release 与 asset identifiers，并根据 capability schema 3 验证打包 plan。

独立 helper 是自包含 bundle：因为 launcher 不复制依赖目录，所以只有 Node builtin 可以保留为 external。Finalization 检查模块语法，强制执行的打包字节 smoke 在安全取消前证明隔离启动与有效合成 handoff acknowledgement。仅相对 import 检查或源码 runner 测试不能证明不依赖 workspace 包。确认前 stderr 在持久化前进行限量与脱敏；发现更新成功不构成 helper 启动证据。

加载后的配置区分打包的 discovery 下限与持久完成的 sequence。Discovery 与 handoff 使用打包和已完成 sequence 中的较大值；completion 只使用持久 receipt 的 sequence，缺失时为零。若 completion 使用打包下限，就会跳过新安装 release 自身的待完成结果及清单检查。重复 completion 是幂等的，清单验证失败会保留先前 receipt，较高的已完成 sequence 绝不降低。

不可变 `cloga/dsh-windows-ops` `dsh-local-0.1.5-rc.2.local.1` manifest 仅在源码 repository 没有匹配 release 时作为精确 sequence-zero migration 保留。Migration record 固定 manifest 与 installer hash，并固定 build receipt 的 `dsh-v0.1.5-rc.2` source tag；由 manifest 固定的 receipt 仍保留 source commit 与 tree。任何格式错误、可变、冲突或不可达的 source release 都会 fail closed，不会 fallback。一旦 source release 存在，Windows Ops 不能充当第二通道。

## 失败事务与恢复

最终 stage 提升前的 helper 失败不可能已经启动 installer：旧版和当前 helper 都先提升 stage。Completion 验证 operation 身份、acknowledgement、cancellation 与结果证据，然后才将此类失败归为终态，不推进已完成 sequence。当前 helper 在 acknowledgement 前保留已验证 manifest，并在调用 launcher 前标记安装可能开始。Cancellation 绝不覆盖最终 stage 或 installer 证据。保留的记录仍可用于诊断。Completion 将 schema-2 历史 handoff 身份读取与当前启动资格分开，包括其旧版迁移源字段；规范化的 capability 元数据随即丢弃，绝不用于授权安装。未知 schema 和格式错误记录仍然 fail closed。

已经暂存的失败保持未解决状态，除非独立候选核验了同一或更高版本的实际安装。已确认但尚未记录终态的 helper 若仍存活，则不允许取代该事务；存活检查不会结束它。Completion 将保留的 manifest 字节绑定到 handoff asset hash，检查 executable/runtime hash，要求当前打包 sequence 与插件清单匹配，并拒绝更高序号或同序号冲突的已暂存事务。补充的安装前 manifest 只能标识当前打包 release；未开始安装的未来下载不能阻止有效的当前安装完成。验证已完成历史时，不会追溯应用后来提高的 discovery 下限。

传输时限涵盖响应头、重定向及响应体读取，元数据与 installer 使用不同预算。有界重试仅适用于已分类的临时传输/HTTP 失败，不适用于身份或完整性校验。Installer 取消会先关闭由 Node 包装的 Web stream 与输出，再删除其私有部分文件。持久诊断保留阶段、已验证资产文件名、错误类别及安装是否可能开始，不保留远程消息、凭据、签名 URL 参数或 operation token。

已安装 executable 提供 `--recover-managed-update`。后续启动将恢复请求转交单实例持有者；重新核验证据不停止 Host 或重置 profile。结果仍阻塞时，提供保留活动工作确认的现有更新流程。此入口无法修复不能启动的 Host，也不能凭空生成缺失的独立完成候选；此时仍需要经过验证的流程外安装。[Desktop README](../../../../apps/desktop/README.zh.md) 说明恢复用法与传输限制。

## 发布

手动 Windows workflow 通过必填的 `confirm_version` 和 `expected_source_sha` 输入要求经过评审的 plan version 与源码 commit。在安装依赖或打包之前，步骤局部的 `EXPECTED_SOURCE_SHA` 必须恰好包含 40 个小写十六进制字符，并与检出的 `HEAD` 完全一致。即使 plan 相同，较新的 commit 也会被拒绝，而不是悄然改变经过评审的源码。Rehearsal 仍要求 checkout 等于所选远端分支的当前 head，使用 build job 与干净 checkout、固定 Node 和 pnpm、冻结 lockfile、focused Desktop tests 及未签名 packaging，然后完成 finalization，并上传保留七天且经过 checksum 验证的 asset set。只有元数据准备步骤获得只读 GitHub 凭据；打包与验收进程仍不带凭据。它绝不运行 release 或 remote-check job。

Publication run 必须使用当前 `master`。受保护 release job 是唯一具有 `contents: write` 的 job。它下载 build artifact，交叉检查完整 asset set，以精确 source commit tag 创建 draft，上传每个 asset，并只在 asset set 完整后发布。随后它要求 GitHub 报告 release immutable，tag 与 release target 解析到 build commit，并且每个 remote asset digest 匹配本地 bytes。最后一个只读 job 通过仅用于构建的元数据适配器针对 GitHub 运行已发布 discovery，并要求它选择经过评审的 version、sequence、commit 与 tree。

## 考虑过的替代方案

**忽略所有 blocked 结果或删除 operation 历史。** 两者都会丢失安装中断保护与诊断证据。只有经过验证、未开始安装的失败不阻塞启动；已经暂存的失败需要独立核验的替代证据。

**根据已安装版本推进 completion，或重试所有错误。** 版本不能证明文件 hash 或插件激活，重试完整性失败也不会修复字节，只会削弱诊断。Completion 使用已验证证据；重试排除校验与 installer 执行。

**只确认版本与当前分支。** 从控制器评审到 workflow dispatch 之间，分支可能推进到未经评审的 commit，而 plan version 未变。在 workflow 内锁定预期源码 commit 可消除这一缺口，同时保留当前分支与版本检查。

**让 Windows Ops 继续作为第二 release owner。** 两份 manifest 与 build definition 可能不一致，而且 operational repository 无法权威证明其打包的 source tree 与 application protocol。

**为未签名 generic feed 使用 electron-updater。** Native update mode 依赖 publisher 与 platform-signature validation。为未签名 artifact 启用它会削弱官方更新安全模型，并生成不安全的可变 channel metadata。

**嵌入下一个 release URL 与 hash。** 当前 build 无法知道尚未创建的 successor，因此每个包都会终止通道，或需要 out-of-band rebuild。

**使用可变 channel index。** 可变 index 需要独立的 signing 与 key-rotation system。固定 GitHub owner 与 tag discovery、不可变 releases、asset digests、精确 tag commits、self-hashed manifests 与单调本地 sequence 提供持续 discovery，不需要另一把 signing key。

## 结果

每个新 fork release 都需要经过评审的 plan change 与受保护的手动 workflow run。GitHub release immutability 是强制要求；repository setting 缺失时 publication 失败。源码通道依赖 GitHub API 与 immutable Release service，并且当 channel 超出一个有界 API page 时拒绝 discovery，直到 capability version 发生变化。

未签名 installer 会继续显示 Windows trust warning，并可能要求 UAC。fork 身份防止这些 artifact 表现为已签名官方 vendor release。Windows Ops 保留 enterprise pinning 与 deployment 工作，而 source code、protocol、release identity 与 immutable bytes 只有一个 owner。
