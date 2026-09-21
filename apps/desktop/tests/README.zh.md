# Desktop 本地更新验证

[English](README.md) | 中文

## 概述

本地下载和强更弹窗证据与生产后端联调、视觉验收、已安装应用升级分开记录。运行 [Desktop README](../README.zh.md) 中的命令可生成新的隔离报告。

已安装应用验收可显式启用 `DSH_DESKTOP_UPDATE_JOURNAL_DIR`，使用安装目录树之外、两个版本共同保留的绝对路径。每个主进程将已安装版本、状态转换和人工操作标记刷新到单独的 JSONL 文件。原始诊断和请求数据被排除；存储错误会向上传播。[日志决策](../../../.agents/notes/implemented/testing/2026-09-14-desktop-installed-update-journal.zh.md)定义证据的局限。单元与主入口测试覆盖该日志；签名安装版升级仍未验证。

## 目录

- [验证证据](#verification-evidence)
- [手动演练](#verification-interactive)
- [托管 runner 安装器与包验收](#verification-hosted)
- [待验证事项](#verification-open)

<a id="verification-interactive"></a>

## 手动演练

实际安装、启动后发布、失败重试与重启证据使用[已安装应用更新人工清单](installed-update/README.zh.md)。下方交互式运行器拦截安装，属于另一类验收。

Host、客户端与 Desktop 产物构建完成后，在 Windows 仓库根目录运行 `node --import tsx apps/desktop/scripts/test-workspace-updates.ts --interactive`。真实工作区持续打开，并提供独立控制窗口。其菜单可选择普通或强制更新、保持和放行下载、注入下载失败，以及添加或清空测试任务。失败模式须在开始下载前选择。确认安装并完成任务收尾后，fixture 消息提示安装器调用已被拦截；确认消息结束演练。关闭控制窗口也会退出。每次运行独占私有 profile 和回环服务器；载荷不是安装器。重新运行命令开始新一轮。省略 `--interactive` 则运行自动化场景，保留 120 秒截止时间和自动退出；交互模式下载的网络截止时间为十分钟。

<a id="verification-evidence"></a>

## 验证证据

本地命令构建 Desktop，并在 Electron 44 中运行真实 HTTP updater、策略客户端、沙箱预加载和强更页面。它记录每个场景，并把报告保存在 `.desktop-build/qualification/local-updater-*`。安装器调用、外部浏览器和剪贴板均替换为观测记录；下载字节不是可执行安装器。

| 层次 | 观测结果 |
|---|---|
| 常规 updater | 同版本／旧版本拒绝、用户授权完整下载、SHA-512 拒绝、传输中断、清单／下载停滞截止时间、显式重试、请求合并、同地址清单替换、就绪状态和独立安装交接通过 |
| 强更策略 | 扁平化 `40005`、完整发布头、游客请求、无需强更验证、失败保留、间隔／退避、超时和 dispose（资源释放）回归通过 |
| 常规调度 | 真实协调器配合模拟时钟的回归验证有上限的抖动／退避、手动复用、成功重置、不自动重试下载、不受系统时钟调整影响，以及 dispose。主入口测试验证聚焦／恢复节流、显式检查立即执行和退出清理 |
| 真实强更窗口 | 服务端纯文本内容、Windows 原生窗口移动／缩放／最大化及还原、Esc 阻塞、直接下载、同弹窗任务确认、稍后更新、仅恢复态页面操作、导航／复制反馈和新策略解除通过；定向测试验证关闭时退出且不清除策略 |
| 真实常规弹窗 | 隔离预加载、380px 卡片、24px 圆角、黑色主按钮、父窗口模糊、Esc 取消后保留就绪，以及任务警告批准后的安装交接记录均通过 |
| 解锁后的 Windows 交互 | 对真实强更页面执行系统级点击并截图，确认 Esc 阻塞、用户发起下载、就绪、红色策略错误提示，以及弹窗解除后父窗口恢复可用。fixture 提供的原生任务警告弹窗在选择稍后更新后回到就绪态；任务活动为模拟，不是完整 Host 工作负载 |
| 主入口 | 已知阻塞拒绝插件修改和恢复，但不停止 Host；新成功响应关闭阻塞；打包策略忽略环境覆盖；正常停止后的安装器失败在下次确认前恢复 Host，并保留强更阻塞 |
| Host 任务保护 | 替换组合环境后的真实控制器识别运行中的 agent、排队的 turn／step、全局和 agent job；API 读取不触发警告。请求准入锁定向新请求返回 503，等待已有请求结束并复查任务；解锁恢复准入 |
| 可见输出 | 中文强更弹窗 DOM 预期输出和常规更新展示预期输出通过；账户行组件测试覆盖进度和持久重试 |
| 打包配置 | 元数据嵌入配置的应用 ID 和策略；构建后的打包前钩子拒绝 HTTP 策略源站，不执行打包或上传 |

弹窗、主入口、设置和侧栏的定向运行通过 119 个回归用例。五个载体测试覆盖共享更新状态源的全部语句、分支、函数和代码行。真实 Electron 命令通过 17 个场景，并捕获常规就绪、任务警告和强更错误弹窗。这些隔离检查不认证完整工作区或发布。全仓门禁结果及环境限制与这些定向证据分开记录。

Chromium headless shell revision 1228 已安装在忽略目录 `.desktop-build/playwright` 中。组装后的设置和侧栏浏览器套件通过 18 个用例。[Desktop 工作区浏览器场景](../../web/tests/desktop-updates.e2e.ts) 的中英文用例均通过，每种语言捕获六张截图，并验证底部账户行位置、紧凑进度及重复点击拦截、顶部展开按钮提示、带错误悬停详情的持久红色重试，以及独立的就绪操作。展示函数、Host Web 组合、客户端插件和 CSS 均为真实实现；Desktop 载体使用替身。这些用例不执行 Electron IPC、菜单、任务授权或安装。

[构建后 Host 场景](fixtures/host-update-qualification.mjs) 使用真实 profile Loader、standard agent 预设、任务服务和 Node 后台进程。它验证排队的轮次／步骤、运行中的模型请求、等待答复的提问／审批、运行／停止中的全局和 agent job、不会取消任务的准入锁定、准入恢复，以及 Host 释放后的检查拒绝。仅模型响应和人工答复使用替身。两个独立调用使用私有 profile 和会话数据并发通过；全部自有 agent、job 和 Host 完成后才写入成功报告。

[Electron 工作区运行器](../scripts/test-workspace-updates.ts) 在私有目录中执行编译后的主入口，使用真实预加载、工作区和独立 Host 进程。它确认首次启动声明，并通过 Electron 输入事件操作页面按钮。十个场景通过，覆盖菜单反馈、下载失败与重试、独立安装确认、确认期间真实任务创建、推迟安装、强更阻塞和真实 Host 停止超时。普通与强更失败均恢复替代 Host，并要求重新确认安装；恢复不会清除强更策略。分发使用本地服务器，安装被拦截；这些不是签名已安装应用的验证结果。

[Windows 验签运行器](../scripts/test-windows-update-signature.mjs) 使用已安装的 electron-builder 元数据生成器和 `NsisUpdater` 验签器，输入为公开发布证书和真实可执行文件。发布者属性匹配时通过；同一有效签名在预期发布者不同时被拒绝，未签名可执行文件也被拒绝。缺少发布者的负对照确认验签被跳过。单元回归覆盖 DN 转义、不完整身份，以及显式或宿主默认 Windows 目标；移除发布者配置会使两条元数据用例失败。此检查不下载、安装或签名产物。

[签名下载运行器](../scripts/test-signed-updates.mjs) 连接真实 Electron HTTP、`NsisUpdater`、Windows Authenticode 和构建后的协调器。四个场景通过：哈希正确但发布者错误时拒绝、哈希正确但未签名时拒绝、传输损坏先于验签被拒绝，以及显式重试后签名文件就绪并单独交接安装。被拒绝的可执行文件缓存为空，自动检查不发送重试请求，已准备的下载保持可用，原始输入的 SHA-512 不变。合成清单和测试应用适配器不证明已安装版本兼容性；不会启动安装器或 Host。

提供旧安装器和两个原始 blockmap 后，同一运行器还会验证单段 Range、多段 Range 重建、缺少旧 blockmap 时回退，以及 Range 被拒绝时回退。重建的可执行文件通过 SHA-512 和 Authenticode 检查。请求记录区分差分负载字节与全量下载；全量回退不能满足差分成功断言。这些回环结果不证明 CDN Range 支持或已安装应用的缓存可用。

<a id="verification-hosted"></a>

## 托管 runner 安装器与包验收

[cloga 发布工作流](../../../.github/workflows/desktop-fork-release.yml)仅在一次性的 GitHub 托管 Windows runner 上运行[安装器验收](windows-installer-upgrade.ps1)。选择经过评审的分支，设置 `rehearsal: true` 并填写精确的[发布计划版本](../release/cloga-windows-x64.json)；演练不能发布。驱动会拒绝已有的产品安装，并在调用真实交互式安装器前验证基线与候选版本的身份。它关闭自动启动，使用隔离数据启动已安装应用，检查自定义安装路径和重启，最后卸载。获取产物所用的凭据不会传给应用或原生辅助程序。

原生包交互 fixture 在启动前独占创建私有 home 及其真实的 `Desktop` 子目录。当 `USERPROFILE` 指向隔离 home 时，Windows Shell 文件夹选择需要该位置。已存在的包操作 home 和文件系统别名会被拒绝，不会被接纳；不会回退到真实用户 profile，也不修改全局已知文件夹或注册表。环境构建器仍保持纯函数。父级拥有的 home 清理只在进程静止后删除这个子目录。文件系统测试验证准备和隔离行为，不证明原生选择器的可访问性或成功选择；这些仍需托管场景验收。

首次无凭据提供方配置在点击设置之前，为精确匹配的官方 API-key 引导对话框及其公开的 `Configure later` 操作安装一次性定位器处理器。对话框可能在异步 Models 联合状态加载后出现，也可能合法地不出现；设置按钮可见或一次性未观察到对话框，都不表示启动配置完成。处理器沿用触发操作的原有时限和正常的遮罩隐藏等待。在真实自定义提供方持久化／就绪检查之后、键盘操作、原生选择器、模型菜单及重启阶段之前移除它。处理器清理错误不能覆盖主要失败，仅有清理错误也会使验收失败。不提供官方凭据、不强制点击、不移除遮罩，也不在重启时永久自动关闭提示；仍要求 Copilot 就绪且提供方请求数为零。

应用正在运行时的拒绝提示采用安装器的 `MB_OK` 确认操作，不依赖数字按钮 ID 或英文标题。点击前，原生辅助程序验证自有且存活的模态窗口、精确的本地化消息，以及唯一、直接隶属该窗口、可见且启用的普通或默认按压按钮；额外、嵌套、隐藏或禁用的按钮选项都会导致失败。驱动仍要求退出码为 2、基线文件与注册信息不变、基线应用保持存活，并且不存在事务目录。屏幕外的自有 Win32 回归检查选择与拒绝行为，不启动安装器；只有托管安装验收才能验证正常拒绝和清理。

安装升级与同版本包操作的观察器均使用[已安装运行时读取器](fixtures/windows-installed-runtime.mjs)。CDP 求值只返回运行中应用的身份字段；描述文件通过维护中的 `readPackagedDesktopRuntimeDescriptor` 载体在 CDP 之外读取。在以 Node 模式启动打包 Electron 之前，读取器重新检查自有安装中的可执行文件哈希，并将观察到的 resources 目录绑定到该安装。描述文件校验对原始 ASAR 字节计算哈希，不使用解析或重新序列化的 JSON。此检查仅针对一次性的托管安装，绝不针对操作者的 Desktop。

固定版本 [Playwright 1.61.1](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/electron/electron.ts) 在 Windows 上通过 `shell: true` 启动 Electron：`app.process()` 标识 CMD 启动载体，而非 Electron 主进程。自有 Electron 主进程内的求值提供实际 PID 和父 PID；基线就绪、原生窗口归属与 Host 进程族检查将该主进程绑定到精确可执行文件及其哈希。启动载体分别保留 PID、创建身份和存活证据，并要求精确且存活的 fixture → CMD → Electron 主进程链。宽松父进程匹配、进程名称匹配或接纳枚举得到的 PID 都不能证明归属。仅启动载体退出不证明 Electron 主进程或 Host 进程族已清理。

不可变的 `0.1.6-alpha.1.cloga.2` 基线使用 sequence 12 和 Copilot alpha.24；只有验证该安装的锁定身份后，才使用其[基线设置检查器](fixtures/baseline-copilot-settings-smoke.ts)。它保留该版本原有的只读模型角色与提供方目录检查，不要求后续版本的工作区或仅提供方 UI。候选及其重启使用针对 Copilot alpha.35 的严格 schema-3 [当前设置检查器](fixtures/copilot-settings-smoke.ts)，要求账户／搜索就绪且退役的 Model roles 不存在，而不是重新标记历史角色加载证据。基线检查不能作为候选检查失败时的回退；两种检查器都不发起认证、保存设置或执行模型／搜索调用。

注册验证和清理绑定自有目录中的确切 `Uninstall cloga-deepseek-harness.exe`：原版 NSIS 根据已验证的 `executableName` 派生这个文件名，而不是使用显示名称或安装目录名称。注册表命令必须是带引号的自有路径，随后为 `/currentuser`；`QuietUninstallString` 只能再追加确切的 ` /S`。其他可执行文件名、模式或尾随参数仍被拒绝；一致的 HKCU 注册表视图别名不会放宽源码、版本、可执行文件哈希或文件系统祖先检查。

启动器退出码为零不代表卸载完成：托管证据显示启动器以代码 0 退出时，其自有临时子进程仍存活，产品文件和注册表键仍存在。Worker 内部失败原因尚未证实。清理以独占创建方式将已验证的自有卸载器复制到自有临时根目录下、安装目录之外。复制前后的源文件与副本哈希必须一致；启动前再次检查注册信息、归属和进程静止状态。安装位置的源文件句柄会释放，让卸载器能够删除它；副本的读取保护持续到自有进程清理完成。

驱动只执行该副本，使用固定 `/currentuser /S`，并将不带引号的 `_?=<owned-install-root>` 放在参数末尾，绝不执行注册表提供的命令文本。它对实际执行句柄等待 120 秒，然后保留原有的 30 秒检查，要求产品可执行文件、注册信息和产品进程均不存在。不通过重试、原地回退、延长时限或手动删除来制造成功。失败时保留主要错误，并记录有界的副本、进程和窗口标量诊断，不将观察到的进程 ID 接纳为自有句柄。纯惰性文件与模拟进程测试不证明真实卸载行为通过验收；经过评审的最终源码须使用实际安装器重新运行托管验收。

[打包 skill canary](fixtures/packaged-skills-smoke.mjs) 从指定产物挂载最小 Cordis 服务，并读取其中真实的 ASAR preset 与 skill。其子进程仅接收明确的操作系统环境白名单，用户状态目录全部私有；它自己的清理保留主要失败，只有清理失败时也会判定失败。这些保证仅适用于该 canary，不适用于其他 runtime-smoke 子进程。它通过四次真实 skill 工具调用检查随附 skill 与合成用户 skill，不代表生产 Host 或 profile 验证。[纯 helper 回归](packaged-skills-smoke.test.mjs) 在产物构建前执行，不证明打包行为已通过。

[打包 Copilot 验收](fixtures/copilot-release-smoke.ts)在同一个自有且已配置插件的 profile 中完成 Copilot alpha.35 初次启动／重启检查、正向 renderer 用例及第三次原生 composer 阶段后，才写入临时的 schema-3 `functional-results.json`。正向用例仍位于重启 graph 检查之后、重启关闭之前；两条 route、应用恢复、清理及 `positive-usage.json` 独占发布必须成功。功能与普通验收 schema 3 增加两份精确的 schema-3 `settingsAcceptance` 观察和 `nativeComposer`，替代过时的角色加载／工作区标志。失败 schema 2、观察器 schema 3 和套件 schema 1 保留原有 scope 与哈希链接；旧功能 schema 2 不会被重新标记为此协议。观察器在三个阶段全部完成后运行一次，其异常经过所有者实际的非预期错误路径，不在局部接受标记。所有者将清理和诊断结果写入最终 `failure.json` 后传播原始错误。普通模式仅在清理及 receipt 操作成功后写入 `acceptance.json`；组合观察器 canary 模式必须让它保持不存在。初始化、诊断、清理或 receipt 失败均不能生成成功的套件证据。

跨仓库打包验收必须显式提供 `expectedCoreSource`，且只包含 `commit`、`tree`、`version`、`upstreamVersion`、`executableSha256`、`runtimeSha256` 和 `planSha256`。所有者先保存这些期望值的快照，再独立观察自己的源码检出、已评审计划和打包字节，并在创建 profile 或 UI 之前拒绝不一致。期望值不选择源码检出，也不替代观察值。调用方的 GitHub 环境与运行身份保持不变；Core 仓库调用即使提供显式期望值，也保留 `GITHUB_SHA` 检查。只有成功的显式调用才会在自有资源清理和普通验收记录发布之后返回冻结的观察事实。默认调用仍不返回值，失败保留原始错误。此 API 不改变正式组合证明格式。

正向记录只包含 `runtimeSha256`、`installedClientSha256`、`pluginSource`、`cases`、`originalSignedOutApplicationRestored` 和 `hostTransport`。它以合成额度与 Session 数据、在没有 Host transport 的情况下，对 `github-copilot` 和 `github-copilot-preview` 执行实际打包 renderer／Session／Slot 行为；登出缺席或忽略 selector 的 mock 不构成正向证明。`restart:positive-usage` 位于 `restart:packaged-graph` 之后、`restart:closed` 之前。所有者与验证器执行同一套经过评审的 alpha.35 来源／产物及原始 Client 字节策略，不提供生产 digest 覆盖。验证器通过 `inputs['packaged.positiveUsage']` 绑定有界的原始正向字节，并将 cases 与功能证据匹配。渲染、捕获、哈希、写入、恢复或清理失败均阻止验收。

原生 composer 阶段紧接 `restart:closed`，依次记录精确的 seeded、launch、application、observed 与 closed 事件；仅当实际进行了公开选择时，才允许在 application 之后立即记录 `native-composer:provider-deferred`。打包 Session 写入使用独占归属标记，只有句柄与 context 关闭后才报告成功；其有界 stdout 不是新增公开资产。临时 `native-composer-geometry.json` 包含完整共享源码／运行／产物身份、经过评审的插件来源及 Client hash、合成持久化历史／登出额度 scope、按顺序排列的 1280／400 几何、原生与 Copilot 对话框观察，以及空的检查错误列表。验证器要求它与嵌入的功能对象精确相等，符合封闭有限几何和实际原生对齐／样式规则，并通过 `inputs['packaged.nativeComposer']` 绑定原始字节。监听器移除会尝试两个注册，且不替换主要失败；错误在主动关闭前封存，而不是在检查期间被静默忽略。Session 写入、启动、检查、receipt、监听器、写文件、关闭或清理失败都会阻止完成。`combined-suite-v3` 是显式消费格式；历史 v1/v2 记录仍保持区别。

[观察器包装器](fixtures/copilot-observer-smoke.ts)要求精确的私有错误对象传播出来，最终失败证据中不存在诊断或清理错误，且自有 home、profile 和祖先 canary 均已删除。随后它写入 `observer-cleanup.json`，最后以原子且独占的方式发布 `packaged-suite.json`，作为套件提交标记。最后这个文件通过哈希及共享的源码／tree／运行／尝试／plan／产物身份绑定原始功能、失败和观察器 receipt，并明确不宣称普通验收完成。仅有临时功能观察不代表套件成功。合成所有者／包装器测试不证明真实托管运行、实时额度访问、OAuth、模型调用或搜索。

必需的只读[验收验证器](../scripts/verify-fork-qualification.ts)在真实安装升级之后、发布资产校验和封存及已验收产物上传之前运行。它将 receipt 关系与精确身份对照已定稿发布元数据、升级归属及已验证输入、候选／重启记录、独立同版本包验收和清理证据进行检查。仅用于 CI 的摘要不进入保持不变的六个公开资产。仅 rehearsal 使用的 `desktop-unqualified-candidate-*` artifact 在验收前保留内部诊断字节；它不是 publisher 输入、release 或验收证据。这些内部记录不扩大公开资产清单，也不将同版本插件选择提升为跨版本升级证明。未包含该真实安装升级通道的并行分支或 master workflow 不能证明此通道合格；集成后的 alpha2 源码必须完成自身完整运行。

独立的[包操作场景](fixtures/windows-packaged-package-acceptance.mjs)使用另一个私有 home，以及真实的 Plugin Manager 控件、标题栏菜单、shell 确认和替代 Host。它将现有的私有测试组合包原样归档。安装首先提升一个仍禁用该组合包的图；必须经过官方 Enable 开关和另一次正常重启，才能报告行状态为 Running。通过真实设置配置的自定义提供方使用回环测试端点；场景断言不发出模型请求。组合输入、仅附件和仅草稿输入都必须阻止激活，同时保留实时输入。Copilot 的禁用与移除选择在同版本重启后检查；确认移除后不存在时，还必须看到已正确加载的保留 fixture。

[原生 UI 辅助程序](windows-desktop-ui.ps1)将操作绑定到自有进程的具体实例及窗口。启动归属不明或未确认进程退出时，不能认证清理完成。报告和截图独立于已定稿的发布产物，报告写入失败不会替换先前的验收错误。纯 VM、合成 helper 和解析检查不证明真实安装器升级或托管 UI 验收成功。经过评审的最终源码仍须使用实际安装器完成托管 rehearsal。应读取每次运行中明确限定范围的标志：本流程不证明跨安装器升级的选择保持、退出后未发送草稿的持久化、提升失败回滚、成功升级后的降级，或已发布渠道的 managed-update 交接。当前本地 Desktop 不是默认测试目标。

<a id="verification-open"></a>

## 待验证事项

以下事项不是通过证据，review 时必须保持可见：

- Electron `capturePage()` 捕获单个窗口。Windows 交互观测包含合成弹窗和原生菜单选择，但跨平台 Figma／布局验收与完整录制仍未验证。自动化工作区运行器直接调用菜单处理器。
- 开发启动器在此 Windows 工作区遇到指向缺失目标的可选 Linux ARM64 依赖 junction；验收运行器直接链接已有依赖图，不验证该启动器的依赖投影。
- 本地 updater 的 fixture（测试前置数据）不执行安装器，不覆盖已安装应用，也不证明新版本成功启动。签名 Windows 和 macOS 发布渠道仍需已安装版本验收；独立的 cloga 托管流程不认证签名发布。
- 两个隔离 Windows 测试安装包通过签名包检查，包括内嵌清单配置。安装后启动、失败重试、自动重启和数据保留仍待操作者验证；文件检查不认证发布。
- 真实策略源站、网关行为、限流、批准的页面源站和已部署策略配置仍待后端联调。本地响应不能证明线上服务可用。
- 策略、updater 清单与下载停滞均达到真实截止时间并可恢复。下载写入的 `ENOSPC` 故障注入已覆盖；真实卷耗尽与已安装版本升级的磁盘压力仍未验证。差分下载和发布者拒绝已通过真实 Electron 下载验证，但尚未在新打包应用的已安装版本升级路径中验证。
- Windows 原生剪贴板写入通过。已尝试启动默认浏览器，但因自动化工具无法可靠识别当前 URL，目标地址验证停止。macOS 浏览器和剪贴板集成仍未验证。
- 强更与常规失败使用本地化摘要和折叠诊断；复制失败展示可选择的地址。常规错误悬停提示显示摘要，不展示原始诊断。Windows／macOS 安装包的图标提醒、通知权限与专注模式行为仍未验证。
- 完整 `doc-sync`（文档同步门禁）在文档站测试中遇到 Windows 文件符号链接 `EPERM`。这不是 updater 失败，也不代表完整文档门禁通过。
