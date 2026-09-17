# Agent Note: 内置 Desktop 运行时并保留外部插件

Status: implemented

[English](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) | 中文

插件修改与恢复遵循[验证 Release 事务决策](2026-09-15-desktop-verified-release-plugin-transactions.zh.md)。[Profile 解析代际决策](2026-09-09-profile-resolution-generations.zh.md)取代本记录中上游 Node、物理资源目录和 profile 链接的执行选择；内置核心包归属与外部插件隔离仍然有效。

## 问题

Desktop 初始化时安装核心依赖图，会重复发布构建器已经完成的工作。离线 store 消除了下载，但仍有解压、包管理器启动和安装成本。用户需要应用在生产依赖已就绪时启动，同时保留普通 npm 插件安装能力，以及跨应用升级的插件状态。

分离的包目录可能加载重复的 Cordis 或服务模块。仅保留插件文件也不能证明它与新的宿主 API 或 Node 运行时兼容。

## 决策

[运行时准备](../../../../apps/desktop/scripts/prepare-dsh.ts)在构建时物化一次生产依赖图。打包应用将其放在 `resources/app.asar/dsh`，原生可执行入口位于 `app.asar.unpacked`。Electron 可执行文件以 Node 模式运行私有 Desktop Host，并通过运行时解析代际从 `$DSH_HOME/profiles/desktop` 加载已启用插件。

本记录取代 [Desktop 打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)中的核心 seed 安装和单项目依赖归属部分。该记录继续负责发布身份、签名、无端口传输、进程归属和仅限 Electron 的插件授权。未发布的 seed profile 没有读取器或迁移；旧包解析链接继续供旧启动方式和回滚使用，但不参与仅运行时解析。

## 包归属

资源描述文件记录精确发布版本、Node 版本、平台、架构、共享包版本和最终文件哈希。构建准备复制普通文件，不保留指回 pnpm 构建 store 的链接，先规范化打包元数据并签名原生 Mach-O 文件，然后才记录清单。原生产物、完整 Host 与浏览器 smoke 使用经过规范化并封存的依赖树。打包将该依赖树放入 ASAR，并解包原生可执行入口；应用签名器保留预先签名的原生字节。明确的 `dsh/node_modules` 文件映射绕过 electron-builder 对根 `node_modules` 的排除。打包清单验证在封装后和 macOS 签名后运行，使用归档中的字节与可执行标志，以及精确的物理解包文件集合与模式；Electron 在一次性验证副本上运行未修改的验证器。

即使通过自定义文件映射传入，锁定版本的 builder 仍会转换嵌套 `node_modules` 包的 manifest。因此，封存原始 npm 元数据会记录与打包结果不同的字节。[元数据规范化](../../../../apps/desktop/scripts/runtime-package-metadata.mjs)在签名或封存之前调用 `app-builder-lib` 26.15.3 的同一个内部 `createTransformer`。准备与打包共享显式的 `removePackageScripts: true` 和 `removePackageKeywords: true` 设置。转换器使用 shell 应用目录来判定主 manifest，不向运行时包传入 fork `extraMetadata`。规范化拒绝已经封存的根目录和文件系统链接；它只修改独占的生产副本，绝不修改工作区依赖或用户 profile。

转换保留包名和版本、`type`、`main`、`exports`、`imports`、dependency 与 peer 声明及 `dsh` 元数据等运行时声明。它删除 scripts、keywords 以及锁定版本 builder 选定的开发或发布元数据；由于运行时代码可以读取自己的 manifest，这些删除并非在所有情况下都不影响语义。精确的内部 API 与序列化行为存在版本耦合：更换 builder 版本需要评审并重新验证，而不是静默 fallback。描述文件字节与打包后清单相等检查保持严格。不会为适应转换后的字节而在打包后重新封存、扩大文件排除范围或跳过运行时构建。

维护中的 [ASAR canary](../../../../apps/desktop/tests/fixtures/packaged-runtime-smoke.mjs)在 Electron 44 下执行真实 builder 转换和归档流水线。负向对照拒绝在规范化之前封存的清单；正向对照验证规范化后的打包及 smart-unpacked manifest 字节与未改变的描述文件，同时检查保留文件与篡改。这一小型 fixture（测试前置数据）不能证明完整生产依赖图的兼容性或安装包验证成功；完整规范化产物与打包 Desktop 的演练仍是独立的发布要求。清单失配诊断报告计数及最多五个相对路径样本，每个路径最多 160 个字符，并附带大小、hash 和适用的可执行标志，绝不输出文件内容。

[桌面文件规则](../../../../apps/desktop/scripts/runtime-file-policy.ts)在生产 npm 依赖安装之后、原生签名或描述文件生成之前执行。npm 发布列表服务于库的使用者，可以包含声明、map、测试和原生构建输入，不能直接表示桌面进程需要哪些文件。桌面副本排除声明和已识别的 source map，因为 Host 执行 JavaScript 和生成的 Typert 产物，清除继承的 `NODE_OPTIONS`，且不开启源码映射。经过审核的插件生命周期构建面向原生依赖，不执行任意 TypeScript 编译。已发布的 npm 包和外部插件目录保留各自的文件。源码调试导航由开发包提供。

包专用排除项包括 Domino 测试、fs-ext 编译产物、Koffi 的 Windows 导入库，以及非目标平台的 node-pty 预构建文件和调试符号。规则保留原生可执行依赖、node-pty 的 ConPTY 源分发内容、许可证和未知资源；宽泛排除 `src`、`test`、`.ts` 或 `.map` 可能移除可执行代码或运行时数据。复制测试保留哨兵资源并封存过滤后的清单；内置 Node 的[产物 smoke](../../../../apps/desktop/tests/fixtures/runtime-payload-smoke.mjs)验证 PTY 输出、原生文件定位、FFI、图像转换和 HTML 解析。运行时准备仍会验证每个保留字节，并携带外部插件启动完整 Host。

dsh 与私有 Host 生产闭包中的每个第一方包都共享。Host 在 profile 行挂载前安装运行时解析代际，因此共享包查找不需要 symlink 或 Windows junction。不同的 ESM 与 CommonJS 条件导出仍是不同入口；选择同一个包目录不能合并包的两套实现。

外部插件把共享宿主包声明为 peer。普通依赖由插件拥有，可以不同于 dsh 使用的版本。运行时模式根据打包清单检查已启用的共享 peer，并拒绝私有包链接及解析到 profile 之外的必需私有依赖。仅在祖先目录找到的可选非宿主 peer 被视为缺失。链接模式还会拒绝共享包的重复副本或别名。如果第三方包需要宿主范围的实例身份，必须明确加入运行时共享清单；版本号相同并不足够。

Profile manifest 分别记录精确的已安装插件依赖和已启用 bundle 列表。停用插件会保留其包、锁文件条目和用户配置。运行时模式的准备记录发布身份与锁文件哈希，不创建、刷新或退役旧宿主链接。仅链接模式的调用方保留单独记录的链接归属。

## 事务与升级

首次启动创建 profile 元数据，不安装核心包，也不创建宿主链接。运行时变化先暂存元数据与保留的外部插件，再验证 peer 并激活最终位置的 Host。仅运行时启动不改动旧解析链接；包事务和原生重建与解析代际安装相互独立。

共享包目录使用原生规范路径识别。Windows 启动器可能改变路径大小写而不移动应用；字符串相等判断会触发不必要的 profile 准备。profile 清理在移除真实目录前，显式解除每一个嵌套目录链接。Windows 夹具在 Electron 44 下复现了递归 `fs.rmSync` 沿嵌套 junction 删除目标文件，而内置上游 Node 24.17 会保留它们。因此清理验收包含真实 Electron 运行时；仅在 Node 下测试不能证明目标文件会保留。

依赖修改先禁用脚本安装，验证插件依赖图和共享 peer 兼容性，运行经过审查的待执行生命周期构建，再次验证。`allowBuilds` 策略保持明确；不受支持且需要构建的依赖会使事务失败。内置上游 Node 运行 pnpm 与复制的更新器 helper；ASAR 中的 Host 则使用 Electron 的 Node 模式。

Desktop 在交换活动 profile 前验证包修改与 staged Host。[验证 Release 事务决策](2026-09-15-desktop-verified-release-plugin-transactions.zh.md)负责激活回滚、receipt 证明与包管理器隔离。保留的宿主链接记录用于识别旧链接归属，与仅运行时包解析相互独立。

[立即显示窗口决策](2026-09-09-desktop-immediate-window-and-direct-start.zh.md)规定实际 Host 启动和主窗口恢复。用户可以更新、删除、禁用或重新启用插件并重试启动。不兼容插件不会被静默删除或自动降级。每次后端启动都要求当前运行时标识。

## 考虑过的替代方案

完整运行时验证属于打包流程。启动读取描述文件，检查共享包记录和必要的 Host 入口，并使用记录的运行时身份复用 profile。[发布验证决策](2026-09-09-desktop-build-release-validation.zh.md)把发布与目标兼容性检查交给打包流程。首次启动和升级后启动都不枚举已安装运行时文件或计算其哈希。在后端加载前读取每个文件，会增加与分发体积成正比的启动 I/O。因此，启动不会通过校验和比较检测已安装内容的变化；不可用模块在加载时失败。构建时验证仍按记录的清单拒绝内容变化、缺失、多余或链接文件。

- **启动时安装内置离线 seed。** 这保留普通 pnpm 安装流程，但会在每台受影响机器上重复核心解压与安装。物化资源消除了这部分工作，代价是更多应用文件和发布构建器责任。
- **把所有宿主依赖链接给插件。** 这会让普通插件依赖与宿主产生不必要的耦合。原链接设计仅共享明确的清单；私有包保留独立版本。
- **使用硬链接。** 它不能表示目录，可能无法跨卷，共享可写字节，并在应用替换后保留旧 inode。这些约束使保留的仅链接模式采用 symlink 和 Windows junction，并不要求运行时模式写入磁盘。
- **使用 `NODE_PATH` 或保留软链接路径。** 它们不能提供统一的 ESM 解析或共享模块身份。保留的链接模式与运行时解析代际都继续由 Node 选择包导出。
- **把核心包留在 ASAR。** 原上游 Node 载体无法读取 Electron 修改过的文件系统，因此加载和子进程路径需要物理资源。后续解析代际决策改用 Electron Node 模式与解包的可执行入口；拒绝 ASAR 的理由不再适用。

## 影响

首次启动和兼容升级不安装核心包。元数据检查和后端加载仍需要启动时间；没有测量前，不声称发布启动延迟或下载体积改善。插件保留以宿主 API 和原生运行时兼容为条件，条件不满足时提供可见的恢复入口。

[Desktop README](../../../../apps/desktop/README.zh.md)负责操作说明。定向测试覆盖真实 pnpm 安装与已批准构建、共享 ESM 实例身份、私有依赖版本、应用移动、停用插件、原生重建选择、激活失败和事务锁。签名安装产物升级、macOS 公证、Windows junction 与原生行为、发布体积与启动基准，以及真实模型 GUI 录制仍是发布环境验收要求；单元夹具不能替代这些验证。
