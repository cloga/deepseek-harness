# Agent Note: 原生菜单中的运行中 Desktop 版本

Status: implemented

[English](2026-09-20-desktop-running-version-menu.md) | 中文

## 问题

内置 Core 版本无法标识正在运行的 fork Desktop 安装包。可用更新标识的是另一个发行版，而且在 Web 界面中查找这两种信息都依赖 Host 启动。用户需要明确的运行中 Desktop 版本，且无需更改应用或访问网络。

## 决策

原生“应用”菜单的第一项使用本地化的“关于 Desktop”文案显示完整的 `app.getVersion()` 值，包括预发布和 fork 后缀。选择该项会调用 Electron 原生的 `app.showAboutPanel()`。面板中的应用名称标识 Desktop，应用版本使用同一个运行中版本值。这些由外壳负责的信息不依赖 Host 就绪状态、恢复页面或更新发现；它不新增渲染进程 IPC 或包管理操作。

[持久 Desktop 更新提示](2026-09-17-persistent-desktop-update-notice.zh.md)仍然标识可用的替换版本，而不是正在运行的应用。其发现、确认和安装行为保持不变。

## 考虑过的替代方案

**Core 包元数据或更新候选版本**可能与运行中的 Desktop 二进制版本不同。因此，显示的标识以 Electron 应用版本为准。

**仅在 Web 设置中提供入口**依赖健康的 Host 和渲染进程。原生菜单在启动或恢复期间仍可使用，无需另设 IPC 接口。

## 影响

现有“关于”条目由同一个菜单所有者重新标注运行中版本，不新增重复条目；原生关于面板仍由平台负责。读取版本不会检查更新、下载制品、修改设置或重启 Host。版本显示不代表托管更新已成功完成，也不代表插件已通过验收。

Desktop 本地测试覆盖语言文案、完整版本保留、原生关于面板选项和调用，以及现有菜单操作。Windows 打包验收在初次启动和重启时，均先点击由 preload 拥有的真实“应用”顶栏控件，再等待 Host 就绪。它临时拦截 `Menu.prototype.popup`，检查由此产生的 Electron 菜单模型和运行中版本，并拦截 `app.showAboutPanel`，验证真实“关于”回调的分派；完成或失败时均恢复这两个方法。验收记录包含 `nativePopupOpened: false` 和 `nativeModalOpened: false`：这些检查验证顶栏触发的菜单模型与回调分派，不验证渲染后的原生弹出菜单或模态窗口。该外壳行为不涉及录制 Session（会话）的往返重放，因此预期观察结果归 Desktop 测试所有，而不放入 CLI（命令行界面）Session 快照。验收只使用一次性的打包应用和配置目录，不接触操作者正在使用的安装。
