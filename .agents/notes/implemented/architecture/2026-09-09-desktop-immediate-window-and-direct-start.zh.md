# Agent Note: Show the Desktop window before starting the Host

Status: implemented

[English](2026-09-09-desktop-immediate-window-and-direct-start.md) | 中文

插件管理和原生恢复遵循[共享 Web 薄壳决策](2026-09-10-desktop-web-wrapper.zh.md)。

## 问题

等待后端就绪会让用户在准备 profile 和加载模块期间看不到窗口。完整的 staging 健康检查进程会在应用启动服务进程前重复启动后端，而插件在实际服务进程中仍然可能启动失败。

## 决策

Electron 在 profile 校准或 Host 启动前创建带打包 Web 加载页的主窗口。Web 入口先显示启动页，再等待 Host 就绪。自有 preload 交付结构化启动注入，现有文档应用注入后激活客户端插件；启动失败时显示诊断和可用恢复操作。加载期间关闭窗口会取消后续启动工作，并等待正在启动的子进程退出。

致命错误展示遵循[原生 Desktop 恢复](2026-09-15-desktop-native-fatal-recovery.zh.md)，而非以前的启动页或不依赖 preload 的应急重置页。[用户清单决策](../bug-fix/2026-09-19-desktop-user-inventory-guards.zh.md)负责保留的重置后端所需的破坏性操作确认与经过验证的私有副本；这些保护不向共享 Web 薄壳添加重置操作。共享产品数据和 Harness-home 环境文件仍不属于 profile 恢复范围。

Desktop 通过[共享 Web runner](2026-09-10-desktop-web-wrapper.zh.md)启动实际 Host。就绪信息提供认证后的 Host URL 和启动注入。桌面壳用该 URL 换取 Host cookie，转发应用 HTTP 请求，并仅为所属应用源认证直接 WebSocket 请求。此承载适配保留 Web 路由和流语义，同时允许静态 HTML 在 Host 就绪前显示。

[验证 Release 事务决策](2026-09-15-desktop-verified-release-plugin-transactions.zh.md)负责暂存包准备、健康检查与可恢复激活，取代本文此前的原地准备和不回滚行为。窗口展示时机和关闭所有权仍由本文规定。可见的启动进度不会绕过用户清单检查，也不授权替换 profile。

本决策部分取代[打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)和[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)中延迟创建主窗口的行为。这两份记录仍保留发布、签名、传输与资源归属的理由。完整运行时文件验证仍属于打包操作。

## 考虑过的替代方案

**在显示任何窗口前要求完整 staging 健康检查。** 它可以在激活前拒绝部分启动失败，但会执行两次插件初始化，也不能保证服务进程能够启动。事务健康检查保留自身所有者，无需因此推迟可见的启动进度。

**在就绪前隐藏主窗口。** 这避免显示加载页，但后端加载期间用户看不到进度，也无法交互。壳拥有的页面可以在 Host 启动失败时继续使用。

## 后果

用户可以在产品 UI 可用前看到启动进度并从失败中恢复。窗口能够响应不代表后端已经就绪，启动延迟仍需通过已安装产物测量。事务失败遵循清单验证与回滚，而不是赋予丢弃 profile 修改或用户包的权限。

验证覆盖 Host 延迟时可见的加载页、新 profile 仅启动一次服务、同一窗口中的失败与重试、原生恢复，以及子进程启动时关闭。安装后 GUI 证据补充生命周期测试。
