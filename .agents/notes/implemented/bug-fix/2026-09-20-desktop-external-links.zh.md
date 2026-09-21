# Agent Note: 接住 Desktop 外部链接失败

Status: implemented

[English](2026-09-20-desktop-external-links.md) | 中文

## Problem

官方 `0.1.6-alpha.2` 已将外部 HTTP 和 HTTPS 链接交给系统浏览器，并允许自有 Host HTTP 文档的同源导航。保留的缺口是格式错误目标的处理，以及同步打开器失败或异步拒绝的收敛，而非缺少外部链接支持。失败诊断不得暴露可能携带授权数据的 URL，也不得替换自有应用文档。

## Decision

[窗口导航](../../../../apps/desktop/src/window-navigation.ts)保留官方对自有应用窗口的导航策略。同窗口 `dsh-app:` 导航及到当前自有 Host HTTP origin 的导航保留在内部；外部 HTTP 和 HTTPS 目标经解析后以规范化形式交接，同时仍拒绝创建 Electron 弹出窗口。格式错误的目标和其他外部 URI scheme 被阻止。不引入 shell 命令或新的渲染进程 IPC。

原生致命恢复仍由 alpha2 主进程所有者负责。共享 PluginManager、preload 拥有的顶栏菜单及现有上下文菜单保留原有归属；此加固不重新引入插件窗口、启动 HTML 或恢复 URL 操作路径。Web 客户端的可选 iframe 预览和文件链接路由保持不变。

浏览器打开操作的异步拒绝和同步失败使用同一个脱敏回调。所属窗口仅在仍存活时显示本地化建议。报告失败也会被接住，不记录原始错误或目标。成功交给操作系统不证明页面已加载或授权已成功。

## Alternatives considered

**逐个把链接改成 `_self`。** 修改 anchor 不能接住格式错误的 URL 或打开器失败，并且会让 provider UI 与桌面壳的特定行为耦合。

**允许 Electron 弹窗或让产品窗口跳离应用。** 两种做法都会扩大渲染进程能力，并可能替换或分离应用自有 UI。

**把官方打开策略当作不存在而予以替换。** Alpha2 已提供打开与同源规则。应只保留缺失的失败处理，而非恢复旧壳的插件窗口或恢复路由。

## Consequences

此加固保留官方的两条打开路径、内部 Host 导航、preload 协议及 sandbox 设置。不支持的 URI scheme 继续不可用，不会启动任意已注册应用。定向测试覆盖格式错误的目标、同步／异步打开器失败、窗口生命周期与脱敏报告；主入口覆盖保留原生致命恢复和菜单归属。必需的 CI 开发版 Electron fixture 使用私有且自有的协议／HTTP 文档和注入的操作系统打开器，观察真实 renderer 分发。它不打开系统浏览器，也不证明 OAuth、安装升级或完整进程树已静止。该 fixture 是候选现有真实安装升级与 v2 验收通道的补充；合成或并行分支结果不能证明集成后的 alpha2 源码合格。
