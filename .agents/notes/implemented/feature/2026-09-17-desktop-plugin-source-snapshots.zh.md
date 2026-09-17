# Agent Note: Desktop 插件来源快照

Status: implemented

[English](2026-09-17-desktop-plugin-source-snapshots.md) | 中文

## 问题

预构建插件可能通过公开 GitHub 仓库或本地包提供，既未发布到 npm，也没有不可变 Release 证明。可变 checkout、移动分支或仅有包版本都不足以在重启后重现已安装字节。把这些输入直接交给包管理器，还会引入安装操作未授权的来源准备、仓库配置与包管理器选择。

## 决策

Desktop 在仅支持 registry 的 `npmRegistry` 与带证明的 `githubRelease` 来源之外，提供通用 `packageSpec` 来源。[Desktop README](../../../../apps/desktop/README.zh.md)负责支持的输入矩阵与用户恢复方式。本决策补充[验证 Release 事务决策](../architecture/2026-09-15-desktop-verified-release-plugin-transactions.zh.md)：来源快照复用其 profile 事务，但不宣称具备其不可变 Release 或发布者证据。[内置运行时决策](../architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)继续负责应用包与共享模块身份。本决策不取代这两个决策。

[输入解析器](../../../../apps/desktop/src/plugin-install-spec.ts)接受刻意收窄的语法，而不是转发 pnpm 的完整传输语法。GitHub 获取通过无凭据的公开 API 请求把一个 ref 解析为完整 commit，再下载该 commit 的归档。它不调用 Git、不使用私有 GitHub 凭据，也不接受 SSH 与任意 Git 主机。省略 GitHub ref 时，仅在显式获取期间选择仓库默认 HEAD。

### 来源准备与输出

[获取模块](../../../../apps/desktop/src/plugin-package-artifact.ts)在安装前将包身份、声明的预构建输出与归档内容作为数据验证。目录与 GitHub 输入在打包前以及打包后分别验证。Web `dsh.client` 声明要求运行时实际支持的 `./client` 导出形式：字符串，或具有字符串 `default` 的对象。Host 条件导出保留 Node 遇到终止性 null 的语义。两个验证步骤都不导入插件。

打包通过内置的上游 Node 调用内置 pnpm 的 `pm pack` 命令，并使用隔离环境与 Desktop 拥有的包管理器状态。`--pm-on-fail=ignore` 阻止下载由来源选择的包管理器；`--ignore-workspace` 阻止工作区发现；`--config.ignore-pnpmfile=true` 与 `--config.ignore-scripts=true` 禁用包管理器钩子和来源生命周期准备。来源中名为 `pack` 的脚本不能替换内置命令。打包不会向来源目录写入 Desktop 元数据。打包前，`publishConfig.directory` 必须在词法路径检查与 realpath 检查下都保持在选定来源目录内；已打包 tarball 中的发布元数据不生效，也不会被重新求值。

不支持根包的 `preinstall`、`install` 与 `postinstall` 声明、根目录 `binding.gyp`，以及非空捆绑依赖声明。直接运行时依赖与可选依赖必须使用真实名称的 registry 版本、tag 或 semver 范围；peer 使用 semver 范围。只有已具备预构建输出时，才允许保留不执行的构建与打包脚本。这些限制防止来源根包仅凭声明获准包名就继承原生构建许可。它们不替代现有经过评审的 registry 原生依赖构建策略，也不证明每个传递包的来源。

### 持久身份与替换

[来源 lock 存储](../../../../apps/desktop/src/plugin-package-lock.ts)在 `desktop-plugin-package-locks.json` 中记录原始请求 spec、解析后的 URL、可选 GitHub commit、真实包名与版本、SHA-256 及 SHA-512 integrity。每个 profile 拥有的归档使用依赖 spec `file:.desktop-plugin-artifacts/<sha256>.tgz`。[项目管理器](../../../../apps/desktop/src/project-manager.ts)在冻结迁移前规范 manifest（元数据清单）与 lockfile，使两者一致。Hash 标识的是快照，而非经过验证的 Release receipt。再次从来源安装可以改变 commit 或字节，而无需改变包版本。

首次冻结安装前，仅在 staging 中运行的[产物 lock 规范化器](../../../../apps/desktop/src/plugin-lock-normalization.ts)处理 importer specifier 仅存在 Windows 分隔符差异的保留 lock。候选项必须与规范 manifest 项精确匹配，并由已验证的 source lock 或验证 receipt 支持，随后还必须核对归档 SHA-256。辅助函数只改变该 importer specifier 的分隔符表示；包解析结果、版本、integrity 与冻结安装标志都保持不变。无效 UTF-8、不安全文件与损坏产物会在不重写 lock 的情况下失败。未知 schema、多个 importer 与无关差异保持原样，交由冻结安装验证；这不是通用 lock 迁移。

重启与冻结重建使用保留的快照，不重新获取原始来源。Registry、快照与经过验证的 Release 之间的替换会移除过时的来源归属。精确 plan 替换在可选验证候选失败时也会移除被替换的 source lock，避免未安装的来源留下保留产物前提。来源重装仍是显式输入操作；验证更新路径不会静默改用保证更弱的来源。

快照缺失或损坏时仍可显示并删除。删除会先排除目标，再验证和重建保留的依赖。其他损坏的保留归档会在 Host 中断前停止事务。这样可以先删除再安装以恢复，而不把禁用全部插件或直接重装当作修复路径。激活与回滚继续遵循共享事务；成功应用会重启 Host，并在运行时执行选定插件。

## 考虑过的替代方案

**把任意 Git 与目录 spec 转发给 pnpm。** 这会将来源获取与 Git 可用性、仓库钩子、包管理器自动选择和可变工作目录耦合。受限解析器与仅处理数据的快照获取将这些输入排除在安装授权之外。

**保留实时目录链接，或在重启时解析分支。** 这些方式避免复制字节，却允许来源编辑或分支移动在没有新安装决策的情况下改变下次启动。Profile 拥有的归档以存储空间换取稳定重建。

**要求每个插件都提供经过验证的 Release 证明。** 这会排除预构建本地包与仅存在于仓库中的包。将快照单独处理，可以保留有用的来源安装能力，而不削弱现有验证通道的保证。

**禁用所有原生依赖构建。** 这会破坏经过评审的 registry 原生依赖路径。因此拒绝来源根包钩子、隐式根包构建、捆绑依赖和直接非 registry 依赖；现有 registry 构建策略保留自身适用范围。

**丢弃或重新解析存在差异的 lockfile。** 为了纠正拼写差异，这种方式可能刷新无关依赖或削弱冻结安装保证。以 receipt 为依据的分隔符规范化保留已选包依赖图，并拒绝无关修复。

## 影响

安装时编译、依赖私有或通用 Git 传输，或者包含不可移植直接依赖的来源包，需要重新打包为具备预构建输出与 registry 依赖的包。快照存储与私有事务副本占用磁盘空间。保存的快照不受原始 checkout 丢失影响，但 profile 归档丢失后需要显式恢复。内容 hash 与获取成功不证明运行时兼容性、认证可用性或插件行为安全。

## 必需验证

[解析器测试](../../../../apps/desktop/tests/plugin-install-spec.spec.ts)与[获取测试](../../../../apps/desktop/tests/plugin-package-artifact.spec.ts)固定支持的语法、输出选择、生命周期拒绝、依赖限制、归档路径约束与有界下载。[真实 pnpm 测试](../../../../apps/desktop/tests/plugin-source-pnpm.spec.ts)针对恶意脚本、配置钩子与包管理器选择器验证实际发布的包管理器调用方式；归档场景必须携带可执行哨兵载荷，而不只是 manifest 中对它的引用。

[Lock 规范化测试](../../../../apps/desktop/tests/plugin-lock-normalization.spec.ts)保留无关解析数据与无需变更时的原始字节，拒绝不安全或损坏的输入，并要求写入前验证全部候选项。[真实 pnpm 规范化回归](../../../../apps/desktop/tests/plugin-lock-normalization-pnpm.spec.ts)在普通添加、切换启用状态与删除操作前植入现有 receipt 支持的分隔符差异；捕获到的首次冻结 pnpm 调用输入必须仅包含获准的 specifier 修正，manifest 与已选解析结果保持不变。

[事务测试](../../../../apps/desktop/tests/project-manager.spec.ts)要求验证冻结迁移、保留来源重建、同版本字节替换、另一类来源依据清理、可选替换失败、损坏快照删除，以及保留快照损坏时在停止 Host 前失败。[插件窗口测试](../../../../apps/desktop/tests/plugin-manager.spec.ts)覆盖来源重装与验证通道保留。目标平台 Desktop 验收还要求验证实际插件窗口、最终位置 Host 启动与回滚行为；源码测试不构成特定外部插件运行时或认证后模型使用的验收。
