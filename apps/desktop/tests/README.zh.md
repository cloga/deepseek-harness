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

[导航策略测试](window-navigation.spec.ts)与模拟 main 启动测试保留官方 alpha2 同源 HTTP 导航，同时要求规范化外部分发、拒绝弹窗、阻止旧恢复协议及本地化脱敏失败处理。[开发 Electron fixture](window-navigation-electron.spec.ts)是独立且仅限 CI 的 renderer 流程，在 Windows 测试前从冻结依赖准备。它使用替代的系统打开器、自有临时回环 HTTP 服务器、被阻止的非自有请求和私有数据根目录；观察真实同源导航与同源弹窗拒绝，再要求窗口／服务器 teardown。原有 fixture45秒／进程60秒／外层90秒边界不变。它既不是已安装 Desktop 验收，也不证明真实默认浏览器或 OAuth 成功，不替代下述更强的安装器流程。

[标题栏菜单观测器](fixtures/desktop-version-menu-smoke.ts)在真实点击预加载层的 Application 按钮后，检查已构造的 Electron 菜单。Electron 将省略的菜单项 role 规范化为 `null`；观测器要求该确切值、经过评审的完整 Desktop 版本，以及恰好一次 About 分派。模板层的 `undefined` 或基于 role 的动作不能满足此检查。拦截会恢复自有方法并完成弹出菜单回调，不打开原生弹出菜单或 About 对话框；这属于菜单模型与分派证据，不是原生渲染验收。

[cloga 发布工作流](../../../.github/workflows/desktop-fork-release.yml)仅在一次性的 GitHub 托管 Windows runner 上运行[安装器验收](windows-installer-upgrade.ps1)。选择经过评审的分支，设置 `rehearsal: true` 并填写精确的[发布计划版本](../release/cloga-windows-x64.json)；演练不能发布。驱动会拒绝已有的产品安装，并在调用真实交互式安装器前验证基线与候选版本的身份。它关闭自动启动，使用隔离数据启动已安装应用，检查自定义安装路径和重启，最后卸载。获取产物所用的凭据不会传给应用或原生辅助程序。

运行中应用的拒绝提示使用专用的自有模态确认解析器，不猜测 MessageBox 返回值。它要求存活的自有安装器中只有一个可见且启用的 `#32770` 根窗口，匹配已捕获的安装器标题（仅忽略末尾标题填充空格）、精确的本地化拒绝文本，以及唯一可见且启用的普通 Button ID2，并带有明确的英语或简体中文 OK 文案。隐藏父窗口中的 Cancel／Next、其他动作、歧义或变化的句柄均被拒绝，点击前再次验证。范围限于支持的安装器及已观察模态，不适用于任意操作系统对话框或语言；600 秒提示等待、退出码 2 和安装内容不变的断言保持原样。

若驱动失败时，保留的基线 monitor 仍在等待拒绝验收完成，独立的[中止协议](fixtures/baseline-abort.mjs)只授权该 owner／run／source／phase。请求以原子方式发布，不覆盖已有控制文件，并验证普通自有文件及精确字节。无效或过期控制不授予关闭权限。fixture 经既有 close／finally 路径失败退出，不写成功或拒绝验收 receipt，仅在 app.close 完成后确认。父进程原有的每句柄十秒清理预算从写请求前开始，最多给予五秒正常退出时间，仅用剩余时间执行保留句柄的停止后备步骤；第二次回收不重置预算。及时验证的退出／ACK 仅缓存同一保留句柄及具体进程实例的终态，因此后续无关清理不会为已完成句柄追加虚假超时或新等待。缺少确认时保持失败关闭，保留主要失败，正常 finish 请求和 120／30 秒门禁仍独立且不变。

安装升级与同版本包操作的观察器均使用[已安装运行时读取器](fixtures/windows-installed-runtime.mjs)。CDP 求值只返回运行中应用的身份字段；描述文件通过维护中的 `readPackagedDesktopRuntimeDescriptor` 载体在 CDP 之外读取。在以 Node 模式启动打包 Electron 之前，读取器重新检查自有安装中的可执行文件哈希，并将观察到的 resources 目录绑定到该安装。描述文件校验对原始 ASAR 字节计算哈希，不使用解析或重新序列化的 JSON。此检查仅针对一次性的托管安装，绝不针对操作者的 Desktop。

固定版本 [Playwright 1.61.1](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/electron/electron.ts) 在 Windows 上通过 `shell: true` 启动 Electron：`app.process()` 标识 CMD 启动载体，而非 Electron 主进程。自有主进程求值提供正安全整数 PID 和父 PID。主进程与保留的启动载体身份都必须有效；基线就绪和原生窗口归属使用主 PID，原生包辅助程序则验证直接 fixture → 主进程关系，或精确且存活的 fixture → 系统 CMD → 主进程关系，并匹配创建身份与会话。进程名称搜索或接纳枚举 PID 都不能证明归属。清理分别要求启动载体退出，以及经过验证的主进程／Host 进程族退出。

驱动将该精确主 PID 绑定到存活的普通物理可执行文件，其规范化安装目录、固定文件名、普通祖先与已验证 SHA-256 必须匹配，并在哈希计算前后检查存活状态。路径字面拼写仍仅作诊断。失败时只保留有界的相等性、可用性、退出与可读性叶字段，然后重抛原始错误；物理守卫允许合法大小写／分隔符规范化，不选择替代进程。

不可变的 `0.1.6-alpha.1.cloga.2` 基线使用 sequence 12 和 Copilot alpha.24；只有验证该安装的锁定身份后，才使用其[基线设置检查器](fixtures/baseline-copilot-settings-smoke.ts)。它保留该版本原有的只读模型角色与提供方目录检查，不要求后续版本的工作区或仅提供方 UI。候选及其重启仍使用针对 Copilot alpha.33 的严格[当前设置检查器](fixtures/copilot-settings-smoke.ts)。基线检查不能作为候选检查失败时的回退；两种检查器都不发起认证、保存设置或执行模型／搜索调用。

安装轮次失败后，[启动诊断](fixtures/installed-startup-diagnostics.ts)在关闭自有应用之前运行，写入独立的 round-startup 记录。自包含回调只读取已识别的文档类别、DOM 状态标志和现有只读 backend status。消息前缀最多检查 4096 个字符，转换为固定类别；未知仍记为未知。不保留原始后端文本、URL、私有路径、profile 或 stdout。桥接与外层传输观察分别采用一秒和两秒预算，不改变就绪、恢复或原始失败。当前候选缺少该桥接时仍记为不可用，而非就绪；不恢复已移除的 IPC 或恢复动作。这项隐私规则适用于新增记录，不代表旧版通用错误格式化器具备同样保证。

注册验证和清理绑定自有目录中的确切 `Uninstall cloga-deepseek-harness.exe`：原版 NSIS 根据已验证的 `executableName` 派生这个文件名，而不是使用显示名称或安装目录名称。注册表命令必须是带引号的自有路径，随后为 `/currentuser`；`QuietUninstallString` 只能再追加确切的 ` /S`。其他可执行文件名、模式或尾随参数仍被拒绝；一致的 HKCU 注册表视图别名不会放宽源码、版本、可执行文件哈希或文件系统祖先检查。

启动器退出码为零不代表卸载完成：托管证据显示启动器以代码 0 退出时，其自有临时子进程仍存活，产品文件和注册表键仍存在。Worker 内部失败原因尚未证实。清理以独占创建方式将已验证的自有卸载器复制到自有临时根目录下、安装目录之外。复制前后的源文件与副本哈希必须一致；启动前再次检查注册信息、归属和进程静止状态。安装位置的源文件句柄会释放，让卸载器能够删除它；副本的读取保护持续到自有进程清理完成。

驱动只执行该副本，使用固定 `/currentuser /S`，并将不带引号的 `_?=<owned-install-root>` 放在参数末尾，绝不执行注册表提供的命令文本。它对实际执行句柄等待 120 秒，然后保留原有的 30 秒检查，要求产品可执行文件、注册信息和产品进程均不存在。不通过重试、原地回退、延长时限或手动删除来制造成功。失败时保留主要错误，并记录有界的副本和进程标量诊断，不将观察到的进程 ID 接纳为自有句柄。纯惰性文件与模拟进程测试不证明真实卸载行为通过验收；经过评审的最终源码须使用实际安装器重新运行托管验收。

仅在失败后执行的[副本 worker 观察](fixtures/windows-uninstall-observation.ps1)只使用调用方保留的执行句柄和已验证副本描述。采样前后重新检查进程具体实例、精确启动参数、受保护的原始字节与自有临时目录的普通祖先；已退出句柄仍由调用方拥有，不是发现后接纳的 PID。不确定或变化的身份记为未知，并丢弃状态叶字段。旧的迁移子进程发现路径已移除：该辅助程序不执行 CIM、HWND、窗口文本、类或控件枚举，也不等待、释放或操作保留的句柄。两秒软准入预算在读取前检查剩余时间；本地元数据读取不可取消，因此不是严格的墙钟截止时间。既有收集器的独立进程快照不套用该预算。执行／删除门禁与原始失败保持不变。

打包监督器测试先检查阶段结束日志，再检查后代进程是否还能执行。文件内私有判断只将进程不存在或 Linux `/proc` 僵尸状态视为停止；活动／暂停状态、不可读取或格式错误的观察不能变成成功。测试判断不增加重试或延迟，后代 fixture 保持不变。生产 POSIX 终止另行发送一次进程组 SIGKILL，最多等待十秒，每 25 毫秒探测负进程组 ID 是否已被内核移除；只有 ESRCH 证明不存在，权限错误或截止时间耗尽仍记录 terminationError。这比直接子进程关闭或识别僵尸的测试判断更严格，不证明历史失败 PID 的状态，也不是已证实的僵尸问题修复。不单独识别 PID 复用。

[打包 skill canary](fixtures/packaged-skills-smoke.mjs) 从指定产物挂载最小 Cordis 服务，并读取其中真实的 ASAR preset 与 skill。其子进程仅接收明确的操作系统环境白名单，用户状态目录全部私有；它自己的清理保留主要失败，只有清理失败时也会判定失败。这些保证仅适用于该 canary，不适用于其他 runtime-smoke 子进程。它通过四次真实 skill 工具调用检查随附 skill 与合成用户 skill，不代表生产 Host 或 profile 验证。[纯 helper 回归](packaged-skills-smoke.test.mjs) 在产物构建前执行，不证明打包行为已通过。

[打包 Copilot 验收](fixtures/copilot-release-smoke.ts)在同一个已配置插件的 profile 中完成初次启动／重启 Copilot alpha.35 断言及第三个合成持久化 Session 的 native-composer 阶段后，才写入 schema-3 临时 `functional-results.json` 观察记录。必需的正向渲染、应用恢复、capture 清理、原始 Client 字节检查及独占发布 `positive-usage.json` 必须先成功。三个自有应用阶段均须在唯一观察器之前关闭。当前功能和继承的普通验收使用 schema 3；失败 schema 2、观察器 schema 3、套件 schema 1 的范围与哈希链接保持不变。随后观察器针对真实 profile 运行一次，其异常经过实际验收所有者的非预期错误路径；所有者不会局部处理所谓预期标记。它先将清理与诊断结果写入最终的 `failure.json`，再传播原始错误。普通模式仅在清理和 receipt 操作成功后写入 `acceptance.json`；组合观察器 canary 模式必须让该文件保持不存在。初始化、诊断、清理或 receipt 失败均不能生成成功的套件证据。

[观察器包装器](fixtures/copilot-observer-smoke.ts)要求精确的私有错误对象传播出来，最终失败证据中不存在诊断或清理错误，且自有 home、profile 和祖先 canary 均已删除。随后它写入 `observer-cleanup.json`，最后以原子且独占的方式发布 `packaged-suite.json`，作为套件提交标记。最后这个文件通过哈希及共享的源码／tree／运行／尝试／plan／产物身份绑定原始功能、失败和观察器 receipt，并明确不宣称普通验收完成。仅有临时功能观察不代表套件成功。合成所有者／包装器测试不证明真实托管运行、实时额度访问、OAuth、模型调用或搜索。

必需的只读[验收验证器](../scripts/verify-fork-qualification.ts)在真实安装升级之后、发布资产校验和封存及已验收产物上传之前运行。它将 receipt 关系与精确身份对照已定稿发布元数据、升级归属及已验证输入、候选／重启记录、独立同版本包验收和清理证据进行检查。仅用于 CI 的摘要不进入保持不变的六个公开资产。仅 rehearsal 使用的 `desktop-unqualified-candidate-*` artifact 在验收前保留内部诊断字节；它不是 publisher 输入、release 或验收证据。这些内部记录不扩大公开资产清单，也不将同版本插件选择提升为跨版本升级证明。

工作流保留两次完整且必需的插件配置：先在 `dist/desktop-copilot-acceptance` 完成普通验收，再以 `copilot-release-smoke.ts --observer-cleanup-canary` 在 `dist/desktop-copilot-observer-canary` 运行 canary。仅导出函数的 observer 模块不是 CLI。验收要求 `--ordinary-evidence` 和 `--packaged-evidence`：从第一个目录读取原始 helper 和已完成的普通 receipt，从第二个目录读取失败／canary 套件，不复制或改标证据。普通验收要求功能、正常验收和清理标志全部为真；共享的源码／tree／运行／尝试／plan／runtime／可执行文件／provisioning／capability 身份必须一致，而各自的证据 UUID 独立验证有效。canary 目录不得存在普通验收 receipt。两个原始目录均保持只读。

每次运行还在重启 graph 检查之后、收集 receipt 与执行观察器之前运行[用量正向 fixture](fixtures/copilot-usage-positive-smoke.ts)。真实打包 renderer 与已发布 alpha.35 Client 仅针对标准和 preview 两条 route 渲染合成 Session／quota 数据；这不验收实时账户访问。验证器独立计算每个原始 `positive-usage.json` 的哈希，记录为 `ordinary.positiveUsage` 和 `packaged.positiveUsage`，要求恰好六个根字段和两个有序的二十一字段 case，并与该轮普通或功能 receipt 匹配。每条 route 要求十四个生命周期观察为真、恰好四次合成 quota 读取、有界的 `7 used` 与 `13 left` 文本，以及零 selector 错误和禁止的 Remote 调用。测试覆盖缺席／继承／显式 undefined binding、删除／关闭 Session 后恢复、提供方恢复及可见 Client 的释放；四个 observable 与 Slot 注册必须全部释放。所有者在正向验收前后通过身份检查的描述符读取有界普通已安装 `client.js` 文件字节。两次运行都执行固定的已评审 alpha.35 source／Client 策略（alpha.33 仅保留为历史允许列表证据）并检查跨目录 digest 相等；没有 digest 覆盖入口，Client digest 也不是插件 tarball 哈希。Capture 使用锁定 Playwright 的可释放 init-script API，在原子发布正向证据前恢复 globals。两条时间线只允许在对应 application 事件紧后出现一次可选 deferred 事件。缺失正向产物、未知字段、未通过的观察或时间线漂移都会阻止验收。原有 cloga.2／sequence12 安装器基线保持不变；本流程不证明从当前 cloga.17／sequence28 或其间每个版本升级通过。缺少该真实安装升级流程的其他工作流不能验收整合后的源码。

当前双运行验收使用 summary schema 2，绑定恰好 51 个原始输入哈希：原有 45 条关系，加上 `ordinary.initial.settings`、`ordinary.restart.settings`、`ordinary.nativeComposer`、`ordinary.nativeComposerSeed`、`packaged.nativeComposer` 和 `packaged.nativeComposerSeed`。新增设置文件为 `initial-settings-readonly.json` 和 `restart-settings-readonly.json`；两目录的 native 文件均为 `native-composer-geometry.json` 和 `native-composer-seed.json`。每个 native schema-2 记录绑定其自身完整证明身份、精确评审的 Client／source、原始六字段 seed 哈希、有序的 1280／400 有限测量矩形、水平／垂直容器约束、字体样式、弹层／Escape／焦点观察、零退役部分与 renderer 错误，以及为假的实时模型／OAuth 声明。[共享验证器](fixtures/native-composer-proof.ts)检查生产和消费两侧语义，不仅检查产物存在。每个记录必须等于自身功能／普通 receipt 内嵌观察；独立运行无需相同几何、路径、时间戳或 evidence UUID。当前设置 schema 3 要求账户／搜索明确就绪及退役角色缺席，安装候选／重启也使用它；不可变 cloga.2 基线保留独立的旧设置契约。Alpha35 不能回退为可选字段、summary1／45 或 functional2／native1。历史证明族及原始字节不重写。Renderer 错误在第三个应用关闭前封存，关闭／seed／检查／receipt 失败均阻止功能、观察器和普通成功。这些检查不替代 Windows UIA 或真实安装器验收。

跨仓库导入必须提供 `expectedCoreSource`，包含 `commit`、`tree`、`version`、`upstreamVersion`、`executableSha256`、`runtimeSha256` 和 `planSha256`。应用／观察器工作之前，检查真实 Core checkout、发布 plan 字节、打包 runtime 描述、可执行文件字节及版本元数据；调用成功后返回实际观察到的 Core 事实。Ops 分别从 `desktop.source.commit/tree`、`desktop.version`、`desktop.releaseChannel.upstreamVersion`、`desktop.installedExecutable.sha256`、`desktop.installedRuntimeDescriptor.sha256` 和 `desktop.releaseChannel.build.planSha256`（发布 plan，而非原生 provisioning plan）映射这些字段。绝不改写调用方真实的仓库、GitHub SHA 或运行环境。同 Core 调用和普通 CLI 即使传入显式预期，也必须匹配真实 `GITHUB_SHA`。不假定存在未提供的内嵌 source 元数据。在第一次 await 之前，所有者验证并冻结私有快照，要求恰好七个自有、可枚举、字符串数据属性，拒绝访问器且不调用 getter，并拒绝 Symbol、不可枚举字段及继承的额外字段。调用方在 runtime 验证期间的修改不能修复或破坏已捕获的预期。描述文件版本必须等于已评审的 upstream 版本；runtime 验证前后的可执行文件哈希必须一致，之后独立的 PE 元数据／哈希检查仍然必需。统一的 `Promise<ExpectedCoreSource>` API 对普通／默认和显式调用均返回独立观察、冻结的七字段事实，绝不返回传入对象或 `undefined`。普通验收发布之前，在处理失败的块内检查观察事实不变量；成功后不再执行文件系统操作。测试验证观察器、诊断、清理及 receipt 失败均保留原始异常，包括抛出的 `undefined`。这些惰性边界测试不证明真实打包或安装验收通过。

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
