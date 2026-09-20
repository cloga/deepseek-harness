# DeepSeek Harness 桌面端

[English](README.md) | 中文

桌面应用是包裹 dsh Web UI 的 Electron 壳。它不打开监听端口：以 Node 模式运行的 Electron 子进程启动 ASAR 中的 dsh 项目，带版本的分帧字节管道在没有外层 Base64 信封的情况下承载 Fetch 请求与流式响应，Node IPC 承载生命周期控制，`dsh-app://` 则提供与后端版本匹配的客户端资源。

## 关键技术决策

| 决策 | 原因 | 直接结果 |
|---|---|---|
| 发布身份 | 桌面壳 API、Web 客户端、后端与插件依赖图作为一个组合完成验证；独立版本会产生未经验证的组合，并让更新可用性含糊不清。 | Electron 与 `@deepseek-ai/dsh` 始终使用同一精确版本。即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本。 |
| 运行时 | 打包 Host 需要 Electron 的 ASAR 文件系统；系统运行时和包管理器状态不可控。 | dsh 通过打包的 Electron 可执行文件运行，并设置 `ELECTRON_RUN_AS_NODE=1`。内置上游 Node 运行 pnpm，并随独立更新器一起复制；二者均不使用 Host 可执行文件。 |
| 包来源 | 即使离线，启动时安装核心依赖也会增加开销。 | `resources/app.asar/dsh` 携带生产依赖树；原生可执行入口使用 `app.asar.unpacked`。Profile 只安装外部插件。 |
| 共享模块 | 宿主 API 可能需要在不写入包链接的情况下共享模块实例身份。 | Host 在挂载插件前安装不可变的 profile 解析代际；运行时解析既不创建也不退役旧链接。普通插件依赖保留在本地。 |
| 状态归属 | 共享可执行依赖图会让 CLI（命令行界面）与 Desktop 相互改变 dsh、Cordis、插件或原生模块版本，而两个桌面进程还可能争用同一个 profile。 | Electron 在访问任何 profile 前获取进程生命周期单实例锁，并独占 `$DSH_HOME/profiles/desktop` 及其包管理器状态。CLI 与 Desktop 共享 `$DSH_HOME` 下受支持的产品数据，但绝不共享可执行包、插件激活、锁文件或 `node_modules`。 |
| 通信 | 监听 Web 服务会引入端口归属、认证、CORS 与暴露风险；桌面壳与 Host 子进程之间也需要明确的跨进程协议。 | 应用不打开 Web 端口。`dsh-app://` 承载 Web 资源和 Fetch 流量；分帧字节管道以背压传输有界请求与响应分块，Node IPC 只承载子进程生命周期控制。 |
| 插件变更 | 包安装和 Host 启动可能失败。 | Desktop 准备并 health-check 私有 staging profile，再把它交换到活动位置。激活失败会恢复先前 profile 与 Host。 |
| 更新 | 桌面壳与 dsh 独立更新会重新产生版本分裂，而未签名 fork 构建不能削弱原生发布者验证。 | 已签名发布使用原生更新器。cloga fork 发布未签名且由源码仓库拥有的托管通道，并携带独立 helper；两种模式互斥，并且都替换完整 Desktop 发布。 |

[Electron 打包与更新 Agent Note](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)负责发布验证，[fork 通道 Agent Note](../../.agents/notes/implemented/architecture/2026-09-15-fork-owned-windows-desktop-release-channel.zh.md)负责未签名发布身份与发现，[验证 Release 事务 Agent Note](../../.agents/notes/implemented/architecture/2026-09-15-desktop-verified-release-plugin-transactions.zh.md)负责插件来源验证与激活回滚。

## 安装归属

Electron 拥有 `$DSH_HOME/profiles/desktop`。其 `dependencies` 包含精确版本的 registry 插件、profile 拥有的来源快照，或由 receipt 证明的 Release tgz 文件；`dsh.profile.bundles` 包含内置 bundle，后接已启用插件。应用从 `resources/app.asar/dsh` 提供 dsh、私有 Desktop Host 及其生产依赖。Host 与插件在同一个 Electron Node 模式进程中执行。Host 在 profile 行挂载前安装不可变的 [profile 解析代际](../../.agents/notes/implemented/architecture/2026-09-09-profile-resolution-generations.zh.md)；该操作不创建、更新或移除旧包链接。Node 继续负责包导出与 import/require 选择。[验证 Release 事务决策](../../.agents/notes/implemented/architecture/2026-09-15-desktop-verified-release-plugin-transactions.zh.md)负责私有依赖验证与模块隔离。CLI 不能启动或修改此 profile。

本地启动页提供启动状态和可用恢复操作；加载后的 dsh 渲染进程接收传输标记、未保存输入影响上报，以及受限的更新状态、订阅和查看接口。查看更新始终进入现有用户确认流程，不开放直接安装或任意 IPC 能力。独立插件窗口接收结构化的列表、来源安装、删除、更新、capability 和更新检查操作。来源输入经过 Electron 的受限解析器与获取检查；两个渲染进程都不获得直接文件系统访问、原始 Electron IPC、shell、通用下载 API 或任意 pnpm 参数。

Electron 根据应用 locale 选择类型化的英文或中文桌面壳文案，并以英文作为 fallback。菜单、原生对话框、启动页与插件管理渲染进程使用同一 locale 数据；仓库的 Client UI i18n gate 会检查这些桌面源文件。

应用菜单（macOS 上为应用名称菜单）的首项是 **关于 Desktop {version}…**，直接显示正在运行的 Electron 应用的完整版本号，保留预发布和 fork 后缀；点击后打开显示相同 Desktop 版本的原生“关于”面板。Host 就绪前即可查看，无需检查更新或访问网络；这里不会显示可用的新版本或独立安装的 CLI 版本。

Windows 打包和所有应用窗口统一使用 [assets/whale.png](assets/whale.png)，它是共享[鲸鱼 favicon](../web/public/favicon.svg) 的 256 像素透明栅格图。打包会把该图片放入应用归档，并用于可执行文件和安装器创建的快捷方式图标；图片缺失或格式错误时拒绝打包。单独修改快捷方式不会改变运行中窗口的图标。应先保存当前工作，再安装更新并重新打开 Desktop。

### 运行时与插件激活

打包的 `resources/app.asar/dsh/desktop-runtime.json` 绑定 shell 版本、记录的 Node 版本、平台、架构、共享包版本和最终文件清单。在原生签名与清单生成之前，运行时准备对私有生产副本应用锁定版本打包器的包元数据转换。原生、Host 与浏览器 smoke 使用经过规范化并封存的依赖树。打包流程通过一次性验证副本检查发布身份、目标兼容性及完整的归档与物理解包清单，不依赖 Electron 的虚拟文件 stat。描述文件字节和严格的打包后检查保持不变；打包绝不通过重新封存归档来修复失配。启动读取元数据，并检查共享包记录。首次启动不会把核心包复制到 profile 存储或通过 pnpm 安装核心包。

准备与打包共享 `app-builder-lib` 26.15.3 的元数据转换，并显式启用 script/keyword 删除设置。运行时包名、版本、模块入口声明、依赖与 `dsh` 元数据仍与 shell 的 fork 元数据分离。删除包元数据并非在所有情况下都不影响行为：依赖可能在运行时读取被删除的字段，因此小型 ASAR canary 不能替代完整规范化产物的 smoke 与打包发布演练。[内置运行时决策](../../.agents/notes/implemented/architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)负责内部 API 版本耦合与验证范围限制。

1. 主窗口在 profile 准备或后端启动前显示本地加载页。新 profile 创建清单并记录运行时身份，不物化共享包链接。已有包元数据但运行时元数据缺失时，初始化会停止而不覆盖 profile；孤立的用户 receipt、bundle 或来源 lock 需要人工检查。复用会检查运行时身份与锁文件内容；打包的插件 plan 还必须准确核对已安装版本、receipt、本地产物哈希与启用状态。
2. 应用升级先把目标运行时元数据和目标插件清单一起暂存，再检查 peer。过时的 release-owned 插件不会阻止计划中的替换或删除。Profile 配置和手动插件版本会保留。
3. 每次 profile 变更只复制元数据与保留的产物，绝不复制 `node_modules`。内置 pnpm 在 staging 中禁用脚本重建私有依赖，验证共享 peer 兼容性，再运行获准的待执行构建并再次验证。运行时升级绝不在活动的保留 profile 中执行包操作。
4. 插件添加、更新和删除使用内置 pnpm 及 Desktop 独有的包管理器状态。`githubRelease` 来源绑定精确 Release、资产、commit、大小、hash、integrity、包身份与依赖 registry 元数据；Desktop 只通过批准的 GitHub 主机下载，并在禁用生命周期脚本的情况下从经过验证的本地 tgz 安装根包。保留的宿主包必须声明为 peer。运行时模式根据打包清单验证这些 peer，不要求 profile 链接。
5. 插件变更先在私有目录中准备目标依赖图，再停止活动 Host 以执行 staged 健康检查，随后把 staged profile 重命名到最终位置并激活。Staged 健康检查失败时会重新启动先前的 Host。旧 profile 一直保留到最终位置的 Host 启动且 required 清单验证完成。激活失败恢复旧 profile；恢复失败保留事务与恢复 journal，而不删除剩余旧数据。

原生插件管理操作在私有 staging 期间保持应用页面打开。在首次中断 Host 前，Electron 通过原生确认框展示运行中的 Session、排队消息、job，以及最新的输入草稿、附件和提交状态。确认后重新读取影响；状态变化时再次询问。无法获取影响时不允许中断；取消会保留活动 profile、Host 和应用页面，也不会报告安装成功。事务获得同意并中断 Host 后，失败恢复会还原先前 profile，不再提供可取消的二次确认。插件变更、应用更新安装和手动恢复不能重叠执行。退出会取消尚未完成的确认，并等待插件事务及其 staged Host 结束，再关闭活动后端。

### 插件来源与快照

插件窗口提供独立的 verified-release JSON 表单，以 `githubRelease` 描述符调用带版本的安装 API。使用经过评审的 lock，其中包含精确 Release、资产、commit、包与 checksum 数据；原生解析器和下载器仍负责最终校验。此显式安装记录用户归属。Release-owned 包名在启动时仍遵循打包计划，因此持久更改该基线需要发布 Desktop。把 Release tgz URL 输入普通来源表单只会创建来源快照，不会生成 verified-release receipt。

普通来源表单接受以下输入。安装要求包具有真实名称、精确版本、`dsh.bundle.patch`，以及声明的预构建 Host 与 Client 文件。仓库名称不决定安装后的包名称。

| 来源 | 接受的输入 | 保存的安装结果 |
|---|---|---|
| npm registry | `plugin`、`@scope/plugin@next`、`plugin@^1.2.0` 或其他有效 semver 范围 | 精确解析的 registry 版本 |
| 公开 GitHub 仓库 | `github:owner/repo[#ref]`、`owner/repo[#ref]`、`https://github.com/owner/repo[.git][#ref]`，或同一 GitHub URL 的 `git+https` 形式 | 完整解析的 commit 与 profile 拥有的包快照 |
| 本地目录 | Windows 或 POSIX 绝对路径、显式 `./` 或 `../` 路径、`file:<path>` 或 `link:<path>` | 打包快照；`link:` 不创建实时链接 |
| 本地归档 | 以 `.tgz` 或 `.tar.gz` 结尾的显式路径或 `file:<path>` | 复制的包快照 |
| HTTPS 归档 | 以 `.tgz` 或 `.tar.gz` 结尾、不含凭据、query、fragment 或自定义端口的 HTTPS URL | 下载的包快照 |

GitHub ref 接受分支名、tag 与 commit，包括含斜杠的分支名；不支持 revision 表达式与 `semver:` 选择器。获取过程使用公开 GitHub API 请求与经过验证的归档下载，不使用 Git 可执行文件、SSH、私有仓库认证或通用 Git 主机。存在歧义的裸名称按 registry 包处理；本地文件必须使用显式路径。带版本的安装 API 保持 `npmRegistry` 仅接受 registry 输入，以 `packageSpec` 接受通用来源输入，并保留 `githubRelease` 处理经过验证的 Release lock。

来源包必须已经构建。Desktop 拒绝根包的 `preinstall`、`install` 与 `postinstall` 钩子、根目录 `binding.gyp`、捆绑依赖，以及非 registry 的直接运行时依赖，包括 file、link、Git、URL、workspace 与 npm 别名选择器。普通依赖与可选依赖使用 registry 版本、tag 或 semver 范围；peer 使用 semver 范围，并继续接受共享包规则检查。来源获取期间不执行保留在包中的 `prepare`、`prepack`、`postpack` 与 `build` 脚本。缺少声明的输出会报错，不构成下载编译器或执行构建的许可。经过评审的原生 registry 依赖构建继续遵循 profile 的 `allowBuilds` 策略；获取限制不承诺所有传递依赖都完全不执行脚本。

每个非 registry 来源都转换为 Desktop profile 下的 `.desktop-plugin-artifacts/<sha256>.tgz`。独立的 `desktop-plugin-package-locks.json` 记录请求 spec、解析后的来源 URL、适用时的 GitHub commit、包名与版本、SHA-256 及 SHA-512 integrity。这些 hash 标识保存的字节，不证明发布者身份，也不赋予 `githubRelease` 验证 receipt 的保证。打包不会修改来源目录的元数据。重启与冻结重装复用保存的快照，不要求原始来源目录仍然存在，也不重新解析其可能移动的 GitHub ref。

使用 **Reinstall from source** 在页内对话框中检查或编辑来源；再次选择本地文件时使用绝对路径。即使包版本不变，显式重装也可以选择不同的字节或 commit。Registry 更新继续选择版本。经过验证的 Release 更新使用验证通道，不会静默退回 registry 或通用来源。替换包来源会清除另一类 source lock 或 receipt 归属，不会把两者同时显示为当前来源依据。

快照缺失或损坏时，插件仍可列出并删除。先删除该包，再从原始来源安装以恢复；禁用插件或直接重装损坏快照不保证修复。删除操作先排除目标包，再重建保留的依赖。如果损坏快照属于保留的包，事务会在活动 Host 停止前被拒绝。成功应用插件事务仍会重启 Host；获取快照不等于验证运行时兼容性或插件代码可信度。[来源快照决策](../../.agents/notes/implemented/feature/2026-09-17-desktop-plugin-source-snapshots.zh.md)负责打包隔离、取舍与必需验证。

### 由 Release 拥有的插件 provisioning

托管 fork release 可以携带 `resources/desktop-provisioning/plan.json`。该精确状态计划列出外部插件，但不会把它们加入 `desktop-runtime.json.sharedPackages`；Desktop 继续拥有 `@deepseek-ai/cordis` 和 `@deepseek-ai/dsh-*` 包，从经过验证的 Release tgz 安装每个外部根包，并在保留 profile 中启用其 bundle。常规 Host 组合随后加载插件的服务端 patch，而 `dsh.client` 与 `./client` 让其 Client contribution 可供 Settings 使用。该计划是通用机制。Capability smoke 使用 neutral provider fixture 证明 Client module 与 provider-card 组合；验收选定 provider 需要其实际不可变制品以及 Settings > Models 中的账户与认证 UI。

外部包必须将目标运行时 `sharedPackages` 中的每个所需包声明为 peer，而非普通或 optional dependency。同一个名称同时出现在 dependency 与 peer 区域中仍会失败。这包括共享的 authorization 和 Schemastery 包；校验和有效的制品与兼容的 peer 范围都不能免除冲突依赖声明的检查。

`dsh.client.external` 声明由 Client 提供的模块，例如 React；它不能满足必需的 Node peer。仅在 Client bundle 中使用 React 的包应声明该 external，而非 Node 运行时依赖。

每个条目分为 `required` 或 optional，并包含带 checksum-manifest lock 的 `githubRelease` source。GitHub 必须明确报告 `immutable: true`。Artifact lock 指定精确的 Release asset id、文件名、字节大小与 SHA-256。Checksum lock 指定精确的 asset id、规范 GitHub Release URL、文件名、字节大小、SHA-256 与 `sha256sums` 格式。每次 acquisition 使用独占私有目录，因此多个来源可以使用 `SHA256SUMS`。Desktop 验证恰好一个 `<sha256>  <artifact>` 条目；缺失、重复、格式错误、重命名或不匹配都会拒绝该来源。可选 SHA-512 SRI 字段一旦提供就必须验证。同一个 plan 的所有条目使用相同的无凭据 HTTPS dependency registry。

Windows Ops 修改 [`release/cloga-windows-x64.json`](release/cloga-windows-x64.json) 中的 `desktopProvisioning`，然后运行受保护的 `desktop-fork-release.yml` workflow，同时传入经过评审的 plan version（`confirm_version`）与源码 commit（`expected_source_sha`）；[发布通道决策](../../.agents/notes/implemented/architecture/2026-09-15-fork-owned-windows-desktop-release-channel.zh.md)定义源码锁定校验。直接使用现有不可变的版本化 tgz 与 `SHA256SUMS` 资产，不要重新发布。Prepare 为 packaging 设置 `DSH_DESKTOP_PLUGIN_PROVISIONING_PLAN` 并嵌入 plan 与 capability schema 3。Finalization 拒绝经过评审的输入、打包 capability 与 plan、发布字节和 receipt hash 之间的不一致。它将打包 plan 发布为 `desktop-provisioning.json`，在 `build-receipt.json` 中记录文件 hash 与规范 plan hash，并通过 `SHA256SUMS` 和 `SHA512SUMS` 覆盖 release 文件。部署需要包含实际非空 provider plan 的 release。

Desktop 在启动时把 release-owned 插件协调到打包 plan，同时保留手动 registry、来源快照与 verified-release 声明，包括已禁用插件。同名手动安装会阻止自动替换，只有已启用、user-owned 且验证来源与计划完全相同的安装例外。其他来源、版本、产物、commit、安装类型或启用状态冲突需要显式用户操作。Required 条目构成经过验证的基线。每个 optional 条目在独立 candidate 中测试；失败会记录阶段与原因，不保留成功 receipt。如果排除 optional 条目会移除已有用户插件，则整次事务失败并保留活动 profile。复用要求 desired/result 成员完全一致，来源、receipt、版本、产物字节与启用状态匹配，且没有额外 release-owned 根包。空 plan 只删除 release-owned 根包。

私有 receipt 存储将用户或发行版归属与来源验证分别记录。显式手动验证安装记录用户归属，包括对同一来源的重装；重建该精确来源时保留用户归属。只有 receipt 产物引用与声明匹配且不存在冲突来源快照时，release ownership 才能把该声明排除在用户保留检查之外。旧数据仅在先前一致的 provisioning state 中存在 active、相同 receipt 且 manifest 引用匹配时推断发行版归属，其他验证插件保留用户归属。旧记录无法区分留下完全相同 receipt 的手动重装。归属迁移与变更随暂存 profile 一起提交或回滚。[插件保留决策](../../.agents/notes/implemented/bug-fix/2026-09-17-desktop-plugin-retention-and-lockfiles.zh.md)负责归属迁移；[用户清单决策](../../.agents/notes/implemented/bug-fix/2026-09-19-desktop-user-inventory-guards.zh.md)负责初始化与冲突检查。

每次包事务在 prune 或包操作前捕获用户依赖 specifier、启用状态、receipt 身份与 owner、来源 lock 身份，以及经过校验的产物摘要。Receipt 和快照引用必须与声明的依赖一致；矛盾或并存的来源需要人工检查。事务冻结准备好的目标声明，在 staged 健康检查后及最终激活后核对保留的声明和产物字节，并在替换前确认活动声明仍匹配。显式 add、install、update 和 remove 只能替换其验证确定的目标名称；toggle 只能改变该目标的启用标记，disable-all 只能改变启用标记。这些检查不能恢复首次捕获前已经被一致清空的清单。带版本的激活证据和保留的私有操作记录支持后续恢复与归因，但不能识别更早且未被记录的操作方。

每次 staged 冻结 pnpm 安装前，Desktop 仅规范化产物 importer specifier 中的 Windows 分隔符差异；候选项必须精确匹配 manifest 中的规范引用，由已验证的来源快照 lock 或 verified-release receipt 支持，且产物 SHA-256 匹配。既有规范化器限制文件读取大小，拒绝不安全的文件和产物目录，并以原子替换方式写入 staged 锁文件。它不改变包解析结果、版本、integrity 或 manifest；无关漂移仍由冻结校验检查。

Windows Ops 验证 `resources/managed-update/capability.json` 中的 `desktopNativePluginProvisioning`、打包和发布的 plan hash、`desktop-plugin-receipts.json` 中的 Release 与 artifact identity，以及 `$DSH_HOME/profiles/desktop/desktop-plugin-provisioning-state.json` 中每个插件的 `active` 或 `optional-failed` 结果和已删除包证据。托管更新 completion 仅在最终位置的 Host ready 后运行，并在记录 sequence 前独立核对实际安装清单、receipt 和打包 plan。仅 staging 健康检查通过不构成 completion 证据。

加载页不依赖 Host。错误页提供重启和重装指导。只有已打包应用的资源支持 profile 恢复时，才提供禁用插件和重置 Desktop；开发模式和早期初始化失败只提供重启。应用菜单仍提供插件管理器入口。每次后端启动前都会检查运行时标识。

启动页和不依赖 preload 的应急页都必须先取得原生破坏性操作确认，默认选择取消，然后重置才会停止 Host。取消会恢复恢复操作控件；退出应用或关闭窗口会使迟到的确认失效。在持有事务锁时，Desktop 将配置和产物复制到 `$DSH_HOME/desktop/profile-recovery/reset-*`，排除生成的 `node_modules`，校验并同步文件，并在删除活动 profile 前发布副本 receipt。配置链接或复制失败会停止重置，并尝试重新启动未改变的 Host。随后重置初始化内置 profile；独立 outcome 记录最终 Host 就绪或失败。共享任务、设置和 Harness-home `.env` 保持不变。副本可能包含私有配置，既不会上传，也不会自动恢复；不要把其内容附到公开报告中。

包事务持有 `$DSH_HOME/desktop/profile.lock`，直到 pnpm 退出并完成激活。版本 2 的 `profile-activation.json` 记录操作身份及前后清单指纹。恢复在重命名或清理前核对活动及保留的候选。版本 1 的 journal 不能授权手动清单不同或运行时、workspace、必需 lock 元数据不完整的恢复。孤立 rollback 阻止初始化空活动路径；健康 profile 仍可与孤立 staging 共存。验证失败会保留 journal 和事务目录供检查。不要删除这些副本，也不要在保留 profile 中运行 pnpm。运行时解析不改动旧链接；清理绝不跟随目录链接，原生构建继续使用经过审查的 `allowBuilds` 策略。

`$DSH_HOME/desktop/profile-operations` 下的私有记录在激活 journal 清理后继续保留操作类型、验证确定的目标名称、事务身份、清单 hash/名称及结果。保留上限为 64 组记录，包括部分写入，每条最多 128 KiB；不删除未知文件。来源 URL、原始错误、提示词和配置内容不进入记录。原子发布记录之前同步文件数据，但不保证断电后的目录持久性。提交后审计失败会保留 committed journal 和 rollback，而不是撤销已提交 profile 或宣称成功。

### Fork 拥有的 Windows 托管更新

Desktop 在启动十秒后静默检查更新，此后运行期间每六小时检查一次。可用版本持续显示在主内容区上方；点击“查看更新”或应用菜单中的 **Check for updates** 才进入现有确认及活动任务检查。后台检查不弹安装对话框，也不自动安装。选择 **Later** 后提示栏仍保留。临时检查失败时保留此前验证过的可用版本；重叠检查会合并，确认与安装期间跳过，退出时停止定时检查并忽略迟到结果。详见[更新提示决策](../../.agents/notes/implemented/feature/2026-09-17-persistent-desktop-update-notice.zh.md)。Windows 警告、安装选项与 UAC 仍需你批准。

托管更新检查失败时，提示会指出出错的是读取版本列表、验证版本标签还是下载更新清单。已知的连接重置、超时、DNS、网络可达性和证书错误会提供本地化恢复建议；取消操作单独说明。未知网络原因保留通用表述，证书建议要求保持验证开启。完整性与元数据校验错误保留原有诊断。这些提示不改变更新来源、下载路径或重试行为。

发现更新、helper acknowledgement、安装完成与经过认证的模型使用是独立检查。复制后的 helper 必须仅凭其 Node 可执行文件与 bundle 启动，才能确认 handoff。确认前失败会保持 Desktop 运行，并在所属 managed-update operation 目录中的 `helper-startup-error.json` 记录有界、脱敏的 stderr。

已发布的 `0.1.5-rc.3.cloga.1` 和 `.cloga.2` helper 包含无法解析的 `semver` import，无法通过失效的 handoff 自我修复。恢复需要通过更新器之外的途径取得较新的已验证 installer。先保存或完成活动工作，明确关闭 Desktop，并验证其精确应用与 Host 进程均已退出，再启动经过 hash 验证的交互式 installer。不要重跑旧 handoff、修改已安装 helper 文件、复制 `node_modules` 或在活动 Desktop profile 中运行 pnpm。Windows 警告与 UAC 仍由用户决定。

包含 `resources/app-update.yml` 的已签名包使用 `electron-updater`，并保留其发布者与平台签名检查。未签名 cloga 包仅在同时携带 `resources/managed-update/capability.json` 与已打包的 `resources/managed-update/helper.mjs` 时选择托管模式；启动会拒绝同时启用两种模式的包。Capability schema 3 固定 `cloga/deepseek-harness`、`dsh-desktop-v` tag 前缀、`release.json` 资产名、包内 sequence、最小 sequence 与规范插件 provisioning plan hash，不接受 URL。一个精确的 `cloga/dsh-windows-ops` manifest 只作为 sequence 为零时的迁移入口。

**Check for updates** 通过固定 GitHub API 仓库列出 release，要求 release 不可变且 tag 锁定 commit，验证 release asset digest，然后检查 manifest schema 3、规范 self-hash、单调 sequence、源码 commit 与 tree、构建输入、fork 身份、installer hash、installed evidence、网络策略、交互式 completion 策略，以及通用 `desktopNativeVerifiedRelease` capability、source-schema 与 receipt-schema 兼容性。Schema 3 保留 `automaticProvisioning: false`，使现有 0.1.5 Desktop 客户端仍能解析并安装该 release；已安装 capability 与 build receipt 负责该 release 的启动 provisioning 证据。包内 sequence 防止企业部署后的 release 选择自身，已完成 sequence 防止回滚。Renderer 消息不能提供 repository、URL、executable、process id、path 或 installer argument。

**Install** 在确认前报告正在运行的 Sessions、排队消息、活动 jobs、当前 composer draft、attachments 与 submission 状态；如果 dialog 打开期间这些影响发生变化，应用会重新要求确认。Electron 在自己的 user-data 目录中写入一次性交接文件，并启动复制的 Node.js 与独立 helper。除非 helper 验证所选 manifest 并确认同一 manifest hash，Electron 会保持应用与 Host 运行。Acknowledgement 失败会把 operation 标记为 cancelled，仅结束该 owned helper 并等待它退出；Host 停止失败会回滚 updater-owned quit，并执行相同取消流程。Acknowledgement 与 Host 停止完成后，Electron 正常退出。Helper 只等待记录的 Electron 与 Host process id，将每次元数据请求限制为一分钟且无数据活动上限为十五秒，将每次 installer 请求限制为三十分钟且无数据活动上限为一分钟，仅对已分类的临时失败重试、总尝试次数不超过三次，把流式下载字节限制为 manifest size，下载并重新验证 build receipt 与 installer，并在 operation 目录下暂存它们。它会在重新计算 hash、检查声明的未签名 Authenticode 状态及启动无参数交互式 NSIS 期间持有不可写 installer handle；子进程不会继承凭据型环境变量。Windows warning 与 UAC 仍由用户交互决定。

下一个 Desktop process 将打包的插件 plan 与运行时一起暂存，启动最终位置的 Host，并且仅在 helper 结果、已安装文件、capability、plan、实际插件清单、receipt 与 sequence 一致时接受 completion。Completion 使用持久完成 receipt 中的 sequence，而非 discovery 为防止选择自身所用的打包 sequence。新打包版本不证明其待处理安装已经完成。保留的 schema-2 和 schema-3 handoff 可能包含基于 commit 的迁移源记录；completion 验证这些记录，不改写历史，也不使其具备新安装资格。身份验证通过且发生在 stage 提升前的失败属于终态，不阻止启动，也不推进 completion receipt；operation 元数据完整保留。已经暂存或可能启动 installer 的事务仍需恢复，除非独立的完成候选通过锁定的 manifest、executable/runtime hash、打包 capability 与插件清单，核验同一或更高版本的实际安装。冲突、格式错误、中断或不匹配的证据不会仅凭版本比较变为成功。Helper 失败记录阶段、资产文件名、错误类别及安装是否可能已开始，不持久化原始网络错误或签名 URL。

恢复命令通过 `--recover-managed-update` 调用已安装 executable。它转交给持有单实例锁的 Electron，并要求最终位置的 Host 已就绪。手动重装后，即使该版本没有 managed helper operation，此显式操作也能从已安装版本的不可变 GitHub Release 获取独立 completion 证据。它核验 tag 与源码身份、manifest 和 build-receipt hash、已安装 executable/runtime 字节、打包 capability 与 provisioning plan，以及实际插件清单。它原样保留历史 operation，拒绝格式错误、仍在运行、更新序号或冲突的安装证据。普通启动仍为离线核验；发布元数据不可用或无法验证时，恢复保持阻塞，原 completion receipt 保持不变。

恢复成功会打开应用，不重置插件或重启 Host。证据仍不通过时，操作提供现有 **Check for updates** 流程，并在替换安装前保留活动工作确认。恢复绝不重跑旧 handoff 或绕过 hash 检查。如果 Host 无法就绪，仍需在此流程之外进行经过验证的交互式重装；单独重装不会完成旧 managed operation。手动启动修复后的应用后，运行其显示的恢复命令。本地安装与启动验证由操作者负责。

Windows Ops 每次选择并锁定一个受支持的 upstream baseline。`cloga/deepseek-harness` 在经过评审的 release plan 中记录该选择，并拥有 installer、manifest、receipt、checksums、不可变 tag 与 capability 注入。随后 Windows Ops 锁定、验证并部署这些由源码拥有的资产，不维护另一份 release 定义。旧 `dsh-local-0.1.5-rc.2.local.1` manifest 只能通过显式 migration 条目接受，不能成为第二个持续通道。当 fork 改用带发布者验证的已签名原生产物时，省略 capability 即可删除托管模式，而无需改变原生更新器。

## 开发

### 隔离 provisioning 验收

在 Windows 上，下列命令构建当前 checkout，并在全新的 headless Edge context 中针对隔离的 workspace-linked Desktop Host 运行真实 Models UI。它们不启动已安装 Desktop，也不使用 live 凭据。Runner 把 provider-card、授权结果、恢复状态截图与运行证据写入 `output/desktop-provisioning-fixes/`。合成授权 receipt 证明通用组合，不证明不可变 artifact integrity、实际 account/model discovery 或已安装 unified-0.1.6 release。打包 runtime smoke 使用 Playwright Chromium；fork release workflow 在 packaging 前准备该浏览器。

```powershell
$env:npm_execpath = (Resolve-Path apps\desktop\node_modules\pnpm\bin\pnpm.mjs).Path
node node_modules\tsx\dist\cli.mjs scripts\build.ts
node node_modules\tsx\dist\cli.mjs apps\desktop\scripts\smoke-workspace-fixture.ts
```

### 开发应用

`dev:desktop` 会构建当前 Host、客户端 bundle、Web 前端和 Electron 壳，把已构建的 CLI 包、私有 Desktop Host 包及其 workspace 依赖投影为一次性桌面 npm 项目，然后直接启动 Electron；这条路径不下载安装包内的 Node.js，也不从 npm 解析 dsh：

```sh
pnpm run dev:desktop
```

开发 Harness 状态默认写入 `apps/desktop/.desktop-build/development/home`，一次性 npm 项目位于 `apps/desktop/.desktop-build/development/project`，Electron 浏览器数据则位于 `apps/desktop/.desktop-build/development/electron-user-data`。因此，会话、设置、凭据、包链接和浏览器数据都不会进入用户正常使用的 Harness home；显式 `DSH_HOME` 只会替换开发 Harness home。Renderer DevTools 默认自动打开，Main、Renderer 和 dsh Host 调试端口依次为 9229、9222 和 9230。`DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT` 与 `DSH_DESKTOP_HOST_INSPECT_PORT` 可以替换这些端口，`DSH_DESKTOP_OPEN_DEVTOOLS=0` 则保持 Renderer 调试窗口关闭。

显式构建完成后，`start:desktop` 会重新生成一次性项目，并跳过构建直接启动已有产物：

```sh
pnpm run start:desktop
```

Workspace 开发使用调用命令的 Node.js 运行当前 CLI 与私有 Desktop Host 包，并禁用桌面包修改；只有该模式明确链接的一次性 profile 可以从自身目录外解析 bundle。需要验证 Electron Node 模式 Host、ASAR 中的 dsh 资源、内置 Node.js 与 pnpm，以及插件安装和修复时，应运行未封装安装器的应用目录。

## 打包

正常打包只需执行一条完整命令。该命令会先准备发布资源，再生成宿主平台的安装包与更新元数据。所有目标都要求通过 `DSH_DESKTOP_APP_ID` 提供反向域名形式的应用 ID。macOS 目标还要求通过 `DSH_DESKTOP_MACOS_SIGNING_IDENTITY` 提供 electron-builder 证书限定名，通过 `DSH_DESKTOP_MACOS_TEAM_ID` 提供对应的 10 字符 Apple Team ID，并提供一套完整的 notarytool 凭据方案。App Store Connect API Key 方式使用以下变量：

```sh
export DSH_DESKTOP_APP_ID='<reverse-DNS application ID>'
export DSH_DESKTOP_MACOS_SIGNING_IDENTITY='<certificate name without the Developer ID Application prefix>'
export DSH_DESKTOP_MACOS_TEAM_ID='<10-character Apple Team ID>'
export APPLE_API_KEY='<absolute path to the .p8 file>'
export APPLE_API_KEY_ID='<App Store Connect API Key ID>'
export APPLE_API_ISSUER='<App Store Connect issuer UUID>'
```

无需提前执行 `prepare:desktop`：

```sh
pnpm run package:desktop
```

发布自动化使用固定目标命令，确保运行时准备、dsh 准备与 electron-builder 接收相同的平台和架构：

```sh
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
```

macOS arm64 命令要求 Apple Silicon。macOS x64 命令可以在 Intel macOS 或带 Rosetta 的 Apple Silicon 上运行。Windows x64 命令要求 Windows x64。Linux 不是受支持的 Desktop 发布目标。

每个目标都在 `apps/desktop/.desktop-build/targets/<target>/` 下持有自己的打包输入、已准备运行时、包集合、dsh 依赖树、pnpm 准备状态、未打包应用、更新元数据和最终产物。Node.js 归档缓存继续由 `.desktop-build/downloads` 共享，因为每个归档文件名都包含版本、平台和架构，并且在解包前经过验证。目标构建绝不读取其他目标的可变准备状态。

### 运行时文件筛选

生产包首先经过 npm 发布规则和依赖安装。[桌面文件规则](scripts/runtime-file-policy.ts)随后在签名、完整性封存与 ASAR 打包之前过滤准备好的 `dsh/node_modules` 依赖树。它排除 TypeScript 声明、明确属于 JavaScript/CSS/TypeScript 的 source map、TypeScript 构建缓存、Domino 测试目录、指定的原生编译产物，以及其他平台的 node-pty 预构建文件。它保留运行时 JavaScript、原生模块及其 DLL/EXE 辅助程序、WASM、未知资源、许可证和声明。规则不会修改 npm tarball、内置包管理器或用户安装的插件文件。

打包应用运行编译后的 JavaScript 和预生成的 Typert 元数据，不编译 TypeScript 插件。源码级调试导航和编辑器声明仍可从开发包中获取。[复制规则测试](tests/runtime-file-policy.spec.ts)覆盖排除项和保留资源；`prepare:dsh` 在 Host smoke 和最终清单验证之前，使用内置 Node 执行[产物 smoke](tests/fixtures/runtime-payload-smoke.mjs)。

Windows 发布验收还需在 Desktop 构建后手动运行[原生清理和替换检查](scripts/smoke-windows.ps1)。将 `$Electron` 设为已准备的 Electron 可执行文件，将 `$Makensis`、`$SevenZip` 和 `$PluginDir` 分别设为锁定版本构建器的 NSIS 编译器、7-Zip 可执行文件和 x86-unicode NSIS 插件目录。从仓库根目录运行以下命令。它验证 Electron junction 清理、安装器临时目录清理和两种文件占用替换方式；不属于单元测试通道。

```powershell
pwsh -NoProfile -File apps/desktop/scripts/smoke-windows.ps1 -Electron $Electron -Makensis $Makensis -SevenZip $SevenZip -PluginDir $PluginDir
```

### 上传更新

`DSH_DESKTOP_AUTO_UPDATE_ENV` 同时选择打包时写入的更新 URL 与后续 COS 上传目标，可取 `test` 或 `production`；未设置时使用 `test`。测试打包必须通过 `DOWNLOAD_TEST_ORIGIN` 提供 HTTPS origin，生产 origin 仍为 `https://download.deepseek.com`。上传还必须通过 `DOWNLOAD_TEST_COS_BUCKET` 或 `DOWNLOAD_PROD_COS_BUCKET` 提供所选环境的 COS bucket。目标路径为 `_/harness/desktop/stable/<target>/`，其中 `target` 为 `mac-arm64`、`mac-x64` 或 `win-x64`。

更新目标与上传凭据都与所选环境对应：

| 环境 | 公开 origin | COS bucket | COS 凭据 |
|---|---|---|---|
| `test` 或未设置 | `DOWNLOAD_TEST_ORIGIN` | `DOWNLOAD_TEST_COS_BUCKET` | `DOWNLOAD_TEST_COS_SECRET_ID`、`DOWNLOAD_TEST_COS_SECRET_KEY` |
| `production` | `https://download.deepseek.com` | `DOWNLOAD_PROD_COS_BUCKET` | `DOWNLOAD_PROD_COS_SECRET_ID`、`DOWNLOAD_PROD_COS_SECRET_KEY` |

同一目标必须在同一环境下完成打包与上传。例如，默认测试环境使用：

```sh
export DOWNLOAD_TEST_ORIGIN='https://desktop-updates.example.com'
pnpm run package:desktop:mac:arm64

export DOWNLOAD_TEST_COS_BUCKET='<test COS bucket>'
export DOWNLOAD_TEST_COS_SECRET_ID='<test COS SecretId>'
export DOWNLOAD_TEST_COS_SECRET_KEY='<test COS SecretKey>'
pnpm run upload:mac:arm64
```

生产发布需在打包前设置 `DSH_DESKTOP_AUTO_UPDATE_ENV=production`，再在执行 `upload:mac:arm64`、`upload:mac:x64` 或 `upload:win:x64` 前提供 `DOWNLOAD_PROD_COS_BUCKET` 与生产凭据对。打包不要求 COS bucket 或凭据。它会明确禁止 electron-builder 发布，从其子进程中删除全部四个 COS 凭据字段，并且只有在 electron-builder 以及全部签名或公证钩子成功后才写入目标完成记录。上传会先要求该记录与所选环境、目标、公开 URL 和当前 dsh 版本一致，再要求根 dsh 版本、Desktop 版本、频道元数据版本、产物名称、大小与 SHA-512 全部一致，之后才读取所选 COS 凭据对。它只上传该目标不可变且带版本的产物，最后以 `no-cache` 上传根据版本得出的频道元数据，并且不会删除历史对象。稳定版本使用 `latest-mac.yml` 或 `latest.yml`；`alpha` 等预发布版本则使用 `alpha-mac.yml` 或 `alpha.yml`，与 electron-builder 生成的文件名一致。

macOS 配置使用必填发布环境，不会接受钥匙串中最先发现的证书。空值、格式错误的 Team ID、包含 electron-builder 不支持的 `Developer ID Application:` 前缀的签名身份，以及不完整的公证凭据都会被拒绝。macOS 打包要求已配置的身份及其私钥可用。运行时准备会把该身份、安全时间戳与 hardened runtime 应用到每个内嵌 Mach-O 文件；应用签名完成后，深度严格检查会拒绝其他叶证书 Authority 或 Team ID，验证通过才生成发布产物。macOS 固定目标安装包命令为已签名应用创建独立副本，并发执行两条产物流。一路先公证 App 并钉票，再生成 ZIP 及其更新元数据。另一路把已签名 App 副本封装进签名 DMG，再公证 DMG、钉票并验证；其中的 App 不单独附加票据。只有两路均成功结束，产物才会移入最终目录并写入发布完成记录。仅生成目录的命令同样需要公证凭据，并等待 Apple 公证和 App 钉票完成。[并行公证决策](../../.agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.zh.md)负责副本隔离与容器票据语义。私钥可以来自登录钥匙串或 electron-builder 的标准 `CSC_LINK` 输入；环境中的 `CSC_NAME` 与证书发现顺序都不能选择发布所有者。公证凭据也可以使用 electron-builder 支持的完整 Apple ID 或钥匙串 profile 方式。手动执行 `pnpm --dir apps/desktop run verify:mac-signature -- <path-to-app>` 重复应用检查时，也必须提供两个 macOS 身份变量。

macOS 签名遍历真实文件，不跟随 Framework 的软链接别名。PAK 资源保留全部随附语言，由外层 Framework 或应用签名记录完整性，不逐个签名。[发布策略](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)负责依赖补丁和验证要求。

可通过公司代理加速向 Apple 公证服务上传。代理配置参见公司内部文档。

### 未签名 Windows 测试安装包

在 Windows x64 上，使用完整的未签名打包命令进行本地安装测试：

```sh
pnpm run package:desktop:win:x64:unsigned
```

该命令要求设置 `DSH_DESKTOP_APP_ID` 并具备常规构建依赖，包括编译原生模块所需的 Python 和 Visual C++ 构建工具。Python 不在 `PATH` 中时，将 `PYTHON` 设置为其可执行文件路径。命令将安装包写入 `.desktop-build/targets/win-x64/unsigned-artifacts/`，省略自动更新配置，清除签名凭据，且不生成发布完成记录。它不需要 EV 凭据或更新源地址。签名打包和上传命令仍遵循正式发布要求。

### Fork 拥有的 Windows 发布

`release/cloga-windows-x64.json` 中经过评审的 plan 同时推进语义版本与整数 sequence。手动 `Desktop fork release (Windows x64)` workflow 要求操作员确认经过评审的版本，固定 Node 24.13.0 与 pnpm 11.7.0，从冻结 lockfile 安装，测试 Desktop，打包固定 cloga 身份，并验证独立 helper、capability、未签名 installer、已安装 executable、runtime descriptor 与原生/托管互斥。Rehearsal run 要求 checkout 等于所选远端分支的当前 head，执行相同的构建、finalization、checksum 验证与 artifact upload，并跳过 publication 与远端 release discovery。Publication run 必须使用当前 `master`；其受保护的 release job 获得唯一的 `contents: write` 权限，交叉检查下载的 workflow artifact，以精确 commit tag 创建 draft，上传全部资产并发布；除非 GitHub 报告 release 不可变且每个远程 asset digest 匹配，否则流程失败。最后一个 job 仅在 publication 后针对 GitHub 运行 release discovery。Preparation 和 remote verification 可以通过 step 专属的 `DSH_DESKTOP_RELEASE_GITHUB_TOKEN` 为允许的元数据 GET 请求认证；下载仍匿名，token 绝不进入已打包应用或 receipt。[Fork 发布决策](../../.agents/notes/implemented/architecture/2026-09-15-fork-owned-windows-desktop-release-channel.zh.md)定义仅构建认证的限制。

每个 release 包含交互式 NSIS installer、`release.json`、`build-receipt.json`、`SHA256SUMS` 与 `SHA512SUMS`。Manifest 与 receipt 锁定源码 commit 与 tree、lockfile 与 plan hash、构建工具与依赖 registry、fork package identity、installer size 与 hash、插件 capability 与结构化 source/receipt 版本、允许的 origin 与 redirect，以及重启后 completion 语义。Workflow 不会启动 installer。

在 finalization 前，[打包 Copilot 验收](tests/fixtures/copilot-release-smoke.ts) 使用全新的 Harness 与 Electron 数据目录启动 unpacked Electron 应用。它要求真实 Settings > Models 账户、登录入口、不再包含已移除 compatibility disclosure 的展开 Manage 面板、成功加载的只读 Model roles 视图、仅提供方级别的 Search provider 与 Fallback provider 控件，以及已注册搜索提供方目录。它验证已安装插件依赖图和 provisioning 清单，再在退出后重新启动时重复这些观察。独立的七天 workflow artifact 记录截图、安全的设置观察、receipt、打包 runtime/capability/plan 记录、可执行文件元数据与精确源码身份。失败运行保留脱敏启动诊断和 receipt/state 是否存在，不保留凭据或 profile 副本。夹具绝不保存设置、创建 Session、登录、打开验证地址或调用模型与搜索提供方。目录注册不等于提供方可用；这些检查不证明 OAuth 成功、模型可用、搜索路由或回退行为，也不证明旧版本到新版本的 installer 升级。Rehearsal artifact 不是不可变 Release。

当前维护计划保留 Core `0.1.6-alpha.1` 并固定 Copilot `0.4.0-alpha.30`。只读验收覆盖 alpha.29 的仅提供方设置和 alpha.30 的登出 Manage 状态。Copilot 自己的合成 Client 测试覆盖 Desktop 同窗口验证交接、Web 新标签页行为以及可选择的手动验证地址；Desktop 打包不会发起该流程。Alpha.28 request-budget 与 compaction 行为和 alpha.29 账户拥有搜索模型解析继续属于由哈希绑定的插件行为，需要单独的模型/搜索验收。[托管 Copilot 维护决策](../../.agents/notes/implemented/architecture/2026-09-20-managed-desktop-copilot-maintenance.zh.md)记录精确发布证据、官方 Core alpha.2 重叠、保留缺口和迁移条件。

独立依赖图检查以打包 Electron 的 Node 模式针对 `app.asar/dsh` 运行构建后的验证器，选择运行时解析，并以活动 profile 为工作目录。它移除继承的 `NODE_PATH`、`NODE_OPTIONS` 与 ASAR 覆盖项，不使用 tsx loader，并将结果绑定到原始运行时描述文件哈希。这只验证包清单；真实 Host 验收单独验证模块加载。源码 runner 的查找路径仅用于诊断。缺失的可选 peer，以及仅在 profile 之外找到的可选非宿主 peer，均被视为缺失；profile 之外的必需依赖仍会报错。

Release workflow 还会把实际打包的 Node 与 helper 复制到无依赖的临时目录。Helper 专用 bundle 包含所有非 builtin 依赖；finalization 拒绝非 builtin 的静态、动态与 CommonJS 模块引用。复制字节 smoke 先在无 handoff 时到达参数验证，再通过有效合成 manifest transport 要求真实 acknowledgement，并在 fixture 进程仍存活时取消。它禁止 receipt/installer 请求，绝不执行 installer。失败会阻止 finalization 与 publication；仅源码 helper 测试不能替代此已打包字节检查。

### Windows EV 签名

Windows 打包将 7-Zip 过滤器固定为 `BCJ`，以兼容内置的 NSIS 解码器。这样可以保留 x64 安装包中由依赖携带的 ARM64 二进制文件；自动 ARM64 过滤会生成该解码器无法解压的条目。

NSIS 在安装阶段清理临时解压目录，完成后才显示完成页或自动启动应用。安装后的生产依赖保留在 `app.asar`，原生可执行入口位于 `app.asar.unpacked`；启动时不会安装或解压第二份核心依赖树。安装仍会写入完整的应用目录树。

Windows 发布打包要求 `DSH_DESKTOP_WINDOWS_CER_FILE` 标识公开的 GlobalSign EV 叶证书，要求 `DSH_DESKTOP_WINDOWS_SIGNTOOL` 标识与 SafeNet 兼容的 SignTool 可执行文件，要求 `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` 标识匹配的私钥容器，并要求 `DSH_DESKTOP_WINDOWS_TOKEN_PIN` 包含 SafeNet Token Password。证书文件保留在源码仓库之外，匹配的私钥仍位于 USB Token。运行固定 Windows 目标前设置这四个输入：

```powershell
$env:DSH_DESKTOP_WINDOWS_CER_FILE = 'C:\path\to\server.cer'
$env:DSH_DESKTOP_WINDOWS_SIGNTOOL = 'C:\path\to\the\validated\signtool.exe'
$env:DSH_DESKTOP_WINDOWS_KEY_CONTAINER = '<SafeNet private-key container name>'
$env:DSH_DESKTOP_WINDOWS_TOKEN_PIN = '<SafeNet Token Password>'
pnpm run package:desktop:win:x64
```

打包前插入并解锁 Token。electron-builder 钩子把每个产物交给采用 CRLF 的 `scripts/windows-sign.cmd`；该 CMD 只调用一次已配置的 SignTool，并指定 `/f`、SafeNet `/kc "[{{PIN}}]=容器"`、`/csp "eToken Base Cryptographic Provider"`、SHA-256 文件摘要和 DigiCert SHA-256 RFC 3161 时间戳。钩子不会改用 electron-builder 内置的 SignTool，也不会重试失败的签名请求。SignTool、证书、容器、PIN、Token 或签名不可用时，Windows 发布打包会失败，不会生成未签名产物。

PIN 不能包含 `]`、引号或换行，因为这些字符用于分隔 SafeNet `/kc` 值或对应的 CMD 参数。CMD 会禁用延迟展开，因此包含 `!` 的 PIN 可以原样到达 SafeNet。打包流程不会把任何 `DSH_DESKTOP_WINDOWS_*` 字段传给构建与 运行时准备子进程；它只向 electron-builder 提供四个配置输入，在其他字段已经清理的环境中只向签名 CMD 提供经过校验的签名字段，在 SignTool 启动前清除这些字段，并遮盖 SignTool 诊断。SafeNet 仍要求 PIN 出现在 SignTool 进程命令行中。只能在连接了物理 Token 的受控 self-hosted Windows runner 上把它注入为临时 secret；绝不能提交该值、把它写进 `.env`，或持久保存为 Windows 用户或系统环境变量。

使用对应的 `:dir` 命令可以生成可直接运行的应用目录，而不是安装包，例如：

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

需要检查或诊断为宿主目标准备的资源而不调用 electron-builder 时，可以让同一流水线在准备完成后停止：

```sh
pnpm run prepare:desktop
```

这条诊断命令是另一种停止位置，并非两条命令构建流程的前半段。之后执行 `package:desktop*` 时仍会重新完成正式构建与准备，避免使用陈旧的 dsh 包、运行时文件或 dsh 内容。

每条打包命令都会构建仓库，打包以 dsh 和私有 Desktop Host 为根的第一方生产依赖闭包，并准备目标专用的 Node 与 pnpm 可执行文件。`prepare:dsh` 在构建时安装并物化一次生产依赖图，移除包管理器元数据，并生成包含共享包版本和最终文件哈希的 `desktop-runtime.json`。Electron-builder 将准备好的依赖树及其显式 `dsh/node_modules` 条目映射到 `app.asar/dsh`，并解包原生可执行入口。在 macOS 上，准备流程先签名原生文件再生成清单，electron-builder 不对其解包目录重复进行嵌套签名。打包 Electron 在封装后运行完整清单验证器，并在 macOS 签名后再次运行。签名安装包、公证、已安装应用升级和各目标原生模块的验收需要发布环境。

未封装安装器的应用目录包含 Electron、ASAR 中的 dsh 生产依赖树与桌面壳、解包的原生可执行文件，以及供包管理和复制更新器使用的物理上游 Node.js 与 pnpm 资源。安装包大小与文件系统占用不同；发布验收需要测量两者，以及 profile 插件存储和首次启动耗时。内置依赖消除了用户机器上的核心包安装过程。

## 更新

打包应用会在主窗口打开十秒后检查目标专用的发布流；本地化的 **检查更新…** 菜单项会手动触发同一检查。发现可用版本时，应用打开一个原生确认弹窗。用户确认后，应用等待正在进行的检查完成，下载并验证已签名的 Desktop 发布、停止 dsh 子进程，并把安装与重启交给 electron-updater。下次启动在显示本地加载页的同时校准版本绑定的运行时。

签名打包为 `DSH_DESKTOP_AUTO_UPDATE_ENV` 选择的部署生成 generic-provider 频道元数据。NSIS 差分包与 macOS ZIP 目标让 electron-updater 可以复用未变化的数据块；供手动安装的 DMG 经过公证，但不生成 blockmap，因为它不是 macOS updater 的载荷。运行时与桌面壳仍属于同一个签名 Desktop 发布。macOS 签名与公证凭据使用 electron-builder 的标准环境变量；Windows EV 签名使用上文所述的公开证书、已验证 SignTool、SafeNet 容器和 runner PIN。必填 Desktop 发布环境选择构建所验证的应用身份与平台签名身份。

## 底层开发覆盖项

未打包的 Electron 进程使用应用目录下的 `.desktop-build/development/project` 作为开发项目。`DSH_DESKTOP_NODE_BINARY`、`DSH_DESKTOP_PNPM_ENTRY` 和 `DSH_DESKTOP_DSH_DIR` 用于选择明确的运行时资源。打包应用忽略这些变量，从 `app.getAppPath()/dsh` 读取 dsh，从 `process.resourcesPath` 解析物理运行时与更新器资源，并使用受管 Desktop profile。

## 已知限制

- Desktop 禁用 Web 的「在本地应用中打开…」操作，因为其 Host 插件依赖 HTTP 路由，而 Desktop 不提供 `webServer`。
- 发布签名、公证、更新托管和跨上一版本的已安装产物验证需要生产发布环境。
- 依赖包含 lifecycle script 的桌面插件，只有其包名进入桌面项目经过评审的 `allowBuilds` 策略后才能安装。
- 桌面壳与 CLI dsh 共享 `$DSH_HOME` 下的会话、设置、凭据、工作区和存储，但可执行包、插件激活、锁文件与包管理器状态彼此隔离。
