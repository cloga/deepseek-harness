# Agent Note: 通过系统浏览器打开 Desktop 网页链接

Status: implemented

[English](2026-09-20-desktop-external-links.md) | 中文

## Problem

alpha1 维护版桌面壳曾同时拒绝两条网页打开路径。官方 alpha2 已将 HTTP(S) 分发至外部、拒绝弹窗、共享窗口创建，并允许自有窗口中的同源 HTTP 导航。剩余缺口是未保护的 URL 解析、分发原始而非规范化地址、未捕获的系统打开失败，以及缺少脱敏本地化建议。本适配保留这些官方已满足的行为，不安装第二套导航策略，也不恢复 alpha1 的恢复页面接线。

## Decision

[窗口导航](../../../../apps/desktop/src/window-navigation.ts)仅提取 alpha2 原有两个 handler，并补齐缺失保证。两条路径都安全解析目标并分发规范化 HTTP(S) URL。所有弹窗均被拒绝；HTTP(S) 弹窗请求即使同源也交给操作系统。同窗口导航严格保留内部 `dsh-app:` 及官方的“目标为 HTTP 且解析后的 origin 相同”判断；HTTPS 不享有该例外。辅助程序只读取所属 WebContents 的当前 URL，不接受可配置 origin 白名单。目标格式错误、当前 URL 格式错误或当前 URL 读取失败时，均失败关闭，不抛出异常，也不打开外部目标。

旧 `dsh-recovery:` URL 在两条路径上都被阻止，不执行动作。无用的恢复回调已退役；alpha2 既有的 `DesktopFatalRecovery`、上下文菜单、主窗口标题栏、sandbox 设置及更新归属保持不变。不引入渲染进程 IPC、任意协议打开、shell 命令或 Host 凭据。

系统打开器的同步异常与 Promise 拒绝共用脱敏回调。仅在来源窗口仍存活时，通过 `currentDesktopLocale()` 显示建议，包括所选 Windows 文档语言。报告器失败只记录固定消息，绝不记录目标或原始错误。当某个精确官方目标提供等价的安全规范化解析／分发、失败捕获、本地化脱敏报告，以及相同的弹窗、同源和窗口生命周期保证时，退役此 fork 辅助程序，并迁移测试而非保留并行包装器。

## Alternatives considered

**逐个把链接改成 `_self`。** 这会让 provider UI 与桌面壳行为耦合，且无法覆盖程序化打开或安全报告系统失败。

**允许 Electron 弹窗或任意同源 scheme。** 这会扩大官方导航约定。仅保留既有同窗口 HTTP 判断，弹窗绝不使用该例外。

**恢复 alpha1 恢复页面或替换维护版桌面壳。** 关闭已识别的 alpha2 缺口不需要这些动作，原生致命错误恢复仍由既有实现负责。

## Consequences

纯测试和模拟 main 的测试保留原有 alpha2 套件，检查规范化分发、拒绝弹窗、同源 HTTP 与 HTTPS／跨源差异、格式错误／当前文档不可用输入、阻止旧恢复协议、窗口独立操作及脱敏本地化失败。仅经批准的 CI 在冻结依赖安装后准备锁定版本的开发 Electron，并运行隔离 renderer fixture。其系统打开器是 spy；自有临时回环服务器用于验证真实同源 HTTP 导航，并在 teardown 时关闭。其他请求和权限仍被阻止，原有 fixture／进程截止时间不变。这不是已安装产品验收、真实默认浏览器页面加载证明或 OAuth 成功证明；更强的独立托管安装器流程仍然必需。
