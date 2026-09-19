# Agent Note: 隐藏 Windows 命令的初始窗口

Status: implemented

[English](2026-09-19-windows-hidden-command-windows.md) | 中文

## 问题

普通 Windows Job 路径在创建私有 runner 和原生目标进程时，没有设置启动可见性标志。因此，从无窗口的 Electron Host 启动 PowerShell 命令可能会弹出控制台窗口，打断用户输入。回退路径已经要求隐藏窗口，但它的行为不能证明原生 Job 路径也正确。

## 决策

[Windows runner 启动器](../../../../packages/subprocess/subprocess-local/src/windows-job.ts) 设置 `windowsHide: true`。[共享 Win32 进程原语](../../../../packages/subprocess/win32-process/src/process.ts) 为普通目标进程和 restricted-token（受限令牌）目标进程，在 `STARTF_USESTDHANDLES` 之外同时设置 `STARTF_USESHOWWINDOW` 与 `SW_HIDE`。现有 `STARTUPINFOW` 布局已经包含可见性字段；类型化输入现在暴露该字段，而不改变 ABI 布局。这沿用官方 `dsh-v0.1.6-alpha.2` 的启动行为，不升级 Core 或依赖图。

进程创建标志、控制台继承、标准句柄与控制句柄、挂起创建、Job 分配、线程恢复顺序、取消以及句柄清理均保持不变。PTY 终端会话保留独立启动路径。该设置控制初始可见性，不限制程序随后主动打开窗口。

## 考虑过的替代方案

**使用 `CREATE_NO_WINDOW`。** 禁止分配控制台可能破坏受限令牌进程的 DLL 初始化。隐藏启动窗口可以保留现有普通进程和沙箱路径所需的控制台语义。

**修改 Windows Terminal 默认设置或终止全部 PowerShell 进程。** 这些操作会影响用户的无关工作，也没有修复进程启动器。

**升级整个 Core。** 可见性修正独立于更广泛的 Desktop 和插件管理改动。定点回移可以避免无关的兼容性工作。

## 后果

后台命令请求隐藏初始窗口，同时保留原有输出、退出和进程归属行为。绑定测试同时断言启动可见性与未改变的创建标志；runner 测试固定 Node 启动选项。发布流程要求在打包前通过原生 Job 和受限令牌回归套件。打包验证在发布资产定稿前观察真实目标进程的启动信息、流和自有进程清理，而不是把模拟选项当作运行时验收。

控制台可见性观测存在限制：Windows Terminal 可能暴露仅用于消息的控制台 HWND，控制台界面也可能属于另一个宿主进程。仅凭目标 HWND 隐藏或不存在，不能证明整个桌面的可见性或焦点行为。交互式焦点验收与启动标志、生命周期验证分开；把发布版安装到用户正在使用的 Desktop 需要另行确认。
