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

Fork 在包含自定义 Core 改动期间保留自己的 Desktop/Core 升级通道。复用官方更新交互、调度或安全机制不代表选择官方二进制制品。每次普通更新仍绑定 cloga 自编译制品；迁回官方发行版需要单独授权。

## 发布记录

Manifest schema 3 对规范 JSON 进行 self-hash，并记录源码 repository、commit、tree、tag、upstream version、sequence、workflow path、lockfile hash、plan hash、固定 Node 与 pnpm 版本、依赖物化 registry、fork identities、installer filename、byte size、SHA-256、SHA-512、未签名 Authenticode 状态、build-receipt hashes、已安装 executable 与 runtime hashes、网络策略和交互式重启后 completion 语义。

安装后的运行时描述文件为 `resources/app.asar/dsh/desktop-runtime.json`；receipt 对打包 Electron 在 Node 模式下读取的归档原始字节计算哈希，而非重新序列化的 JSON。构建时的[打包运行时检查](../../../../apps/desktop/scripts/packaged-runtime.mjs)使用构建器的 ASAR 读取器拒绝不安全路径与链接，核对物理解包文件集合完全一致，并把实际字节物化到私有临时验证目录。归档内文件的可执行标志取自 ASAR，解包文件的模式取自物理文件，因为 Electron 的虚拟 stat 会合成权限且遗漏未登记的 sidecar 文件。未修改的清单验证器通过有界、环境已清理的 Electron Node 模式检查该副本，并在子进程退出后清理。该副本不是安装后的运行时，也不是第二个权威来源，且不启动 Host 或 profile。发布 workflow 在 finalization 前使用打包 Electron 运行清单 canary 检查。

插件兼容性保留 manifest schema 3 对完整通用 `desktopNativeVerifiedRelease` capability 的记录，包括 capability schema 1 与结构化 source 和 receipt schema version 1，并设置 `automaticProvisioning: false`。保持该记录不变，使已安装的 0.1.5 client 能够解析并安装包含 provisioning 实现的 release。

经过评审的 release plan schema 2 携带通用精确状态 Desktop 插件 plan；schema 1 会规范化为空 plan，使现有且版本中立的 release 定义仍然可读。Build receipt 独立 self-hash，并记录相同的 source、build inputs、identity、artifact evidence、helper 与 capability hashes、已发布 provisioning plan 的文件 hash 与规范 hash、native-updater exclusion、network policy、installation policy 与通用插件 schema 兼容性。`SHA256SUMS` 与 `SHA512SUMS` 覆盖 installer、provisioning plan、manifest 与 receipt。

仅构建使用的元数据发现可以通过 [release fetch adapter](../../../../apps/desktop/scripts/desktop-release-github-fetch.ts) 显式接收 `DSH_DESKTOP_RELEASE_GITHUB_TOKEN`。CI 向 preparation 与 remote verification 提供该适配器的只读 Actions token，不传给 packaging 或应用；独立的基线获取凭据在“发布”一节说明。仅固定 GitHub API repository 的规范 release-list 与 tag-resolution GET 请求携带认证。带认证的重定向会失败关闭；下载及其他 origin 保持匿名，并移除调用方的 authorization/cookie。传输和响应错误不输出任意远端文本，只保留安全的取消分类或数字 HTTP 状态。未提供 token 时仍匿名发现；不会读取凭据存储或环境中的 `GH_TOKEN`，receipt 也绝不包含 token。已发布应用的行为保持不变。

## 发现与安装

Capability schema 3 包含固定的 `cloga/deepseek-harness` owner、`dsh-desktop-v` tag prefix、`release.json` asset name、包内 sequence、minimum sequence、精确插件 provisioning capability 与规范 plan hash，以及一个精确 migration record。它不接受用户选择的 repository 或 URL。

Check 列出固定 repository 的 GitHub Releases。每个匹配 release 必须已经发布、不可变、锁定 commit，并携带恰好一个具有 GitHub SHA-256 digest 的已上传 manifest asset。Desktop 把 tag 解析到同一 commit，验证 raw asset digest，解析 self-hashed manifest，并选择最高且不冲突的 sequence。包内 sequence 防止企业部署后的 self-selection；durable completion receipt 防止回滚。

所选 handoff 同时锁定 manifest 的规范 self-hash 与 raw release-asset SHA-256。独立 helper 在下载 receipt 与 installer 前重新验证二者。下次启动时，Desktop 会在 Host 启动前协调打包的插件 plan。Completion 在记录新 sequence 前验证运行中的 executable、runtime descriptor、预期 GitHub release 与 asset identifiers，并根据 capability schema 3 验证打包 plan。

独立 helper 是自包含 bundle：因为 launcher 不复制依赖目录，所以只有 Node builtin 可以保留为 external。Finalization 检查模块语法，强制执行的打包字节 smoke 在安全取消前证明隔离启动与有效合成 handoff acknowledgement。仅相对 import 检查或源码 runner 测试不能证明不依赖 workspace 包。确认前 stderr 在持久化前进行限量与脱敏；发现更新成功不构成 helper 启动证据。

Helper 下载仍最多尝试三次，退避为 500/1000 毫秒。每次元数据请求的总期限为 60 秒、无活动期限为 15 秒；每次安装器请求的总期限为 30 分钟、无活动期限为 60 秒。Launcher 的 185 秒 acknowledgement 预算容纳 manifest 传输预算，但不证明 helper 已退出。只有封闭枚举且由模块拥有的传输类别才能控制重试及持久化 helper 诊断。未知错误保留原始拒绝对象身份；受保护的字段探测不能替换错误，也不能在持久化诊断中暴露原始消息、cause 或 URL。完整性与重定向错误仍是终止性失败，传输层绝不重试安装器执行。

普通退出与原生恢复会等待已获准的插件激活和托管更新交接，再关闭最终 Host。尚未完成的确认会取消；已获准的候选启动或回滚可以完成，但不会重新开放请求准入，也不会导航正在关闭的窗口。Launcher 用确认未启动 helper 或确认 helper 已退出的证据标识失败；任意 Promise 拒绝、终止请求或超时都不证明 helper 已停止。Helper 清理未获确认时，普通退出仍被阻止，并恢复仍可用的壳窗口显示，避免父进程 PID 消失意外授权安装。经过验证、由安装器拥有的交接保留独立退出路径。

保留事务的协调在接受取消标记前，先验证新版 helper 的阶段、错误类别、安装状态与退出证据；取消文件不能掩盖格式错误或相互矛盾的安装器证据。旧 schema-2 handoff 只作为历史身份读取，绝不授权新的启动。失败或中断的 stage 本身不能获得完成资格。候选必须匹配已安装 executable、runtime、capability sequence、无冲突的 release 身份及打包 plan。基线尚待处理或保留用户选择时，在 `baseline-outcome.json` 中记录 `baseline-not-qualified`：写入所选候选的证据目录，或在没有 helper operation 的独立手动恢复中写到 `completion.json` 旁。此诊断不会虚构 helper operation、推进 completion 或触发重新安装；只有后续通过清单验证的复查才可完成。

打包的 `--recover-managed-update` 入口向拥有应用的 Electron 实例请求一次新的、串行化的证据复查。它与持续生效的原生致命恢复状态分离，绝不清除致命状态或当前 helper 是否已停止的不确定性。只有就绪 Host 与 completion 所拥有的启动准入 token 仍精确匹配时，可用结果才能释放门控。因门控等待的初始文档通过原有 boot Promise 继续，不重新加载。退出会等待已获准的复查；检查保留证据不会停止或重启 Host、改写 profile、授权安装或绕过请求准入。普通第二实例启动只聚焦应用。尚待处理或保留用户选择的基线仍可用，但不视为已认证。

加载后的配置区分打包的 discovery 下限与持久完成的 sequence。Discovery 与 handoff 使用打包和已完成 sequence 中的较大值；completion 只使用持久 receipt 的 sequence，缺失时为零。若 completion 使用打包下限，就会跳过新安装 release 自身的待完成结果及清单检查。重复 completion 是幂等的，清单验证失败会保留先前 receipt，较高的已完成 sequence 绝不降低。

不可变 `cloga/dsh-windows-ops` `dsh-local-0.1.5-rc.2.local.1` manifest 仅在源码 repository 没有匹配 release 时作为精确 sequence-zero migration 保留。Migration record 固定 manifest 与 installer hash，并固定 build receipt 的 `dsh-v0.1.5-rc.2` source tag；由 manifest 固定的 receipt 仍保留 source commit 与 tree。任何格式错误、可变、冲突或不可达的 source release 都会 fail closed，不会 fallback。一旦 source release 存在，Windows Ops 不能充当第二通道。

## 保留历史与手动安装恢复

Completion 将历史 handoff 身份读取与当前启动资格分开：schema 2 和早期 schema 3 都包含字段严格为 `version`/`commit` 的迁移源。只读规范化先验证 commit，再构造仅供 parser 使用的 tag 元数据，保留 schema-3 provisioning 验证，并丢弃规范化的 capability，不授权安装，也不改写保留文件。仅按 capability schema 判断兼容性会拒绝已发布的 schema-3 历史，因为迁移字段在该 schema 内发生过变化。未知 schema 和格式错误记录仍然 fail closed。

已经暂存的失败保持未解决状态，除非独立候选核验了同一或更高版本的实际安装。已确认但尚未记录终态的 helper 若仍存活，则不允许取代该事务；存活检查不会结束它。Completion 将保留的 manifest 字节绑定到 handoff asset hash，检查 executable/runtime hash，要求当前打包 sequence 与插件清单匹配，并拒绝更高序号或同序号冲突的已暂存事务。补充的安装前 manifest 只能标识当前打包 release；未开始安装的未来下载不能阻止有效的当前安装完成。验证已完成历史时，不会追溯应用后来提高的 discovery 下限。

显式恢复可通过不可变发现与 manifest 验证的 build receipt，独立于历史 handoff 验证当前安装的 release。精确 version 和 sequence 选择允许在更新 release 已发布时恢复，而不安装它。Receipt 绑定源码身份、executable/runtime hash、打包 capability 字节，以及 provisioning-plan 字节与规范 hash。Completion 仍要求最终位置 Host 就绪及实际清单，在网络访问后重新读取历史 operation，并拒绝并发推进的 completion。历史 operation 保持不变。普通启动只使用本地 completion 证据；离线或无法验证的发布元数据不能授权手动安装恢复。此入口不能修复无法启动的 Host。结果仍阻塞时，提供保留活动工作确认的现有更新流程。[Desktop README](../../../../apps/desktop/README.zh.md) 说明恢复用法。

## 发布

手动 Windows workflow 通过必填的 `confirm_version` 和 `expected_source_sha` 输入要求经过评审的 plan version 与源码 commit。在安装依赖或打包之前，步骤局部的 `EXPECTED_SOURCE_SHA` 必须恰好包含 40 个小写十六进制字符，并与检出的 `HEAD` 完全一致。即使 plan 相同，较新的 commit 也会被拒绝，而不是悄然改变经过评审的源码。Rehearsal 仍要求 checkout 等于所选远端分支的当前 head，使用 build job 与干净 checkout、固定 Node 和 pnpm、冻结 lockfile、focused Desktop tests 及未签名 packaging，然后完成 finalization，并上传保留七天且经过 checksum 验证的 asset set。元数据准备步骤接收步骤专属的只读 `DSH_DESKTOP_RELEASE_GITHUB_TOKEN`；独立的已验证安装器基线获取步骤接收步骤专属的只读 `GH_TOKEN`，用于读取元数据与资产。两种凭据均不传入打包或应用启动步骤。这是限定作用域的凭据使用，而不是无凭据的构建或验收 workflow。Rehearsal 绝不运行 release 或 remote-check job。

Publication run 必须使用当前 `master`。受保护 release job 是唯一具有 `contents: write` 的 job。它下载 build artifact，交叉检查完整 asset set，以精确 source commit tag 创建 draft，上传每个 asset，并只在 asset set 完整后发布。随后它要求 GitHub 报告 release immutable，tag 与 release target 解析到 build commit，并且每个 remote asset digest 匹配本地 bytes。最后一个只读 job 通过仅用于构建的元数据适配器针对 GitHub 运行已发布 discovery，并要求它选择经过评审的 version、sequence、commit 与 tree。

## Workflow 发布策略

[fork 发布策略](../../../../.github/AGENTS.md#fork-publication-policy) 将 Desktop 确定为默认公开交付物，也涵盖 Core/Web 变更。Issue #90 表明，checksum 有效的包 tarball 仍可能违反用户批准的产品与通道要求。Release 标题和资产数量不能证明交付了 installer。

`verify-release-policy` 使用现有 YAML parser 发现每个 `.yml` 和 `.yaml` workflow。阻塞式 `ci-static` 检查显式权限默认值，仅允许现有 Desktop release job 使用 `contents: write`，拒绝未经评审的 package/OIDC writer 及已识别的发布命令/action，并将 rehearsal job/event 清单固定为 CI artifact 输出。现有 npm、Python 和 native publication job 使用精确的 fork 排除条件；dispatch 输入与 repository variable 无法覆盖这些条件。非 fork 行为保持不变，包括已配置的私有 Python publisher。Pages OIDC 是按确切 job 命名的非 release 例外。

Desktop 只允许一个 publisher step，使用经过评审的旧版单行命令，或比较检出 HEAD 与 build source SHA 并传递失败的五行 PowerShell 模板。两处检查复用同一个完整脚本精确分类器，仅规范 CRLF 和末尾换行。Publisher 保留 `pwsh`、输出 id、精确 token/tag/version/source 绑定，以及在其之前执行的一次 build SHA 干净检出，且不持久化凭据。额外语句、重复 publisher、步骤条件、错误抑制和工作目录覆盖均被拒绝；支持更强模板不会替换其源码检查或改变生产 publisher。

脚本白名单不是防御任意代码的安全边界。该检查验证声明的 workflow 权限与已知入口，不解释任意 shell 程序、local action、external action 或凭据使用。它不检查远端设置，也不能阻止获授权的源码编辑者修改策略。评审仍负责新代码与另行获授权的通道。Desktop 现有 publisher 在任何远端调用之前验证精确的 installer 与配套资产清单；有效 checksum、Desktop 标题或 Desktop tag 都不能替代该清单。实际 installer 资格仍由 packaging 与 acceptance 检查负责，而不是文件名检查。

源码策略变异测试覆盖新增 writer、继承权限、已识别的发布步骤、输入/变量覆盖及当前源码。离线 publisher 回归拒绝 checksum 一致的 293 个 Core/Web tarball、用 tarball 替换 installer，以及在 installer 旁额外加入 tarball。这些测试补充现有发布成功路径与 receipt 检查，不改变 packaging 或版本。

## 考虑过的替代方案

**仅按标题或 checksum 批准 release。** 两者都不能识别可安装的 Desktop 产品。Workflow 权限清单与 publisher 的精确资产清单分别检查不同义务；两者都不能替代打包后验收。

**禁用 upstream workflow 或增加 dispatch 覆盖开关。** 禁用会丢弃有效的 upstream 分发与仅输出 CI artifact 的 rehearsal。Dispatch 覆盖会将操作输入变成新 fork 通道的授权。固定 repository 排除条件保留 upstream 行为，同时禁止这种覆盖。

**只确认版本与当前分支。** 从控制器评审到 workflow dispatch 之间，分支可能推进到未经评审的 commit，而 plan version 未变。在 workflow 内锁定预期源码 commit 可消除这一缺口，同时保留当前分支与版本检查。

**让 Windows Ops 继续作为第二 release owner。** 两份 manifest 与 build definition 可能不一致，而且 operational repository 无法权威证明其打包的 source tree 与 application protocol。

**为未签名 generic feed 使用 electron-updater。** Native update mode 依赖 publisher 与 platform-signature validation。为未签名 artifact 启用它会削弱官方更新安全模型，并生成不安全的可变 channel metadata。

**嵌入下一个 release URL 与 hash。** 当前 build 无法知道尚未创建的 successor，因此每个包都会终止通道，或需要 out-of-band rebuild。

**使用可变 channel index。** 可变 index 需要独立的 signing 与 key-rotation system。固定 GitHub owner 与 tag discovery、不可变 releases、asset digests、精确 tag commits、self-hashed manifests 与单调本地 sequence 提供持续 discovery，不需要另一把 signing key。

## 结果

每个新 fork release 都需要经过评审的 plan change 与受保护的手动 workflow run。GitHub release immutability 是强制要求；repository setting 缺失时 publication 失败。源码通道依赖 GitHub API 与 immutable Release service，并且当 channel 超出一个有界 API page 时拒绝 discovery，直到 capability version 发生变化。

未签名 installer 会继续显示 Windows trust warning，并可能要求 UAC。fork 身份防止这些 artifact 表现为已签名官方 vendor release。Windows Ops 保留 enterprise pinning 与 deployment 工作，而 source code、protocol、release identity 与 immutable bytes 只有一个 owner。
