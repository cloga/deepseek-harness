# Agent Note：Desktop 插件 slash command

状态：已实现

[English](2026-09-20-desktop-plugin-slash-command.md) | 中文

## 问题

Desktop 独占 `$DSH_HOME/profiles/desktop`。插件窗口可以调用已验证事务，但 Session 中的用户必须切换窗口，才能列出或准备插件变更。普通 CLI 有意拒绝保留 profile，也无法观察正在运行的 Electron Host、renderer 草稿、事务锁、归属 receipt 或原生中断确认。

## 决策

打包的 Desktop Host 注册一个内置 `/desktop-plugin` 命令。它支持 `list`、`install npm <spec>`、`install github <owner/repo[#ref]>`、`install release <verified-release-json>`、`remove`、精确版本 `update`、`enable`、`disable` 和 `disable-all`。slash 安装不接受本地路径或任意 URL，因为 Session 工作目录不是稳定的 Electron 包解析基准；这些来源继续使用插件窗口。

命令不会修改 profile，也不直接调用 pnpm。它通过现有 Node 子进程 IPC，把有界、封闭的操作发送给精确的活动 `DesktopHostProcess`。Electron 校验 wire 消息，重新运行权威来源解析器，并把操作交给 `DesktopProjectManager`。没有新增 preload、loopback endpoint、文件系统能力、任意包管理器参数或 CLI 例外。

### 自重启落盘握手

获批的插件事务会停止正在执行命令的 Host，因此 Electron 在该 Host 存活时启动准备。到达 `beforeChange` 时，Electron 只返回带类型的 `prepared` 结果，并等待匹配的 `command/done` 事件完成结算。Desktop Host 观察该事件，等待 `sessions.flush(session)` 成功后，才发送同时带 request id 和 command id 的 settlement acknowledgement。仅观察事件并不代表它已经落盘；生命周期观察器不可用或落盘失败时，发送取消而不是确认。随后 Electron 读取最新 Host/renderer 影响并显示现有默认取消的原生确认框；只有用户批准后才能停止 Host。取消、断线、过期ID、settlement超时或影响不可用都会保留活动 Host/profile。

列表只返回包名、版本和启用状态。变更失败只通过小型错误码 allowlist 穿过 IPC；失败提示使用固定文案，不回显任意 manager、subprocess、network、路径、包或输入诊断。用户输入的命令仍按普通 `command/run` 机制记录。中断后的内部 startup diagnostics 继续走现有产品路径。

## 考虑过的替代方案

**允许 `dsh plugin --profile desktop`。** 这会绕过运行中的 Electron owner，无法保留影响确认、事务互斥、receipt、staged health check 或 rollback。

**通过 application preload 暴露变更。** 应用文档和 Client 插件不应获得 Desktop 包变更权限；shell-only 边界保持不变。

**增加 loopback 控制服务。** 它新增认证、生命周期和端口归属，而现有精确子进程 IPC 已经具备所需身份。

**返回 `prepared` 后立即停止。** 时间延迟或观察到事件都不能证明 `command/done` 已落盘到 Session log；显式 settlement acknowledgement 仅在成功落盘后发送，把重启绑定到对应生命周期记录。

## 后果

该桥接把协议提升为版本4，并让 Desktop Host 直接依赖 commands registry。每次变更仍执行 acquisition、staging、health check、影响审查、原生确认、Host重启和rollback。命令报告的是准备完成，而非安装成功；重启后的最终激活仍由 Desktop 状态和库存证明。

## 必需验证

语法测试覆盖 npm 名称、scope spec、dist-tag、比较器与 hyphen range、GitHub ref、verified JSON 语法、精确更新版本、输入边界、本地/协议/凭据拒绝和安全输出。Electron startup 测试覆盖操作映射、当前子进程与单调请求身份、停止前错误脱敏、结算确认与原生确认前 Session 成功落盘、观察器不可用或落盘失败时取消、超时、busy 状态和过期请求。Host-process 测试传输真实子进程 IPC request/response/settled 消息。打包演练必须证明命令已注册、重启前存在配对的 `command/run`/`command/done`、原生默认取消行为，以及最终库存仍经过插件窗口使用的同一事务。

[独立的打包命令验收 fixture](../../../../apps/desktop/tests/fixtures/desktop-plugin-command-smoke.ts) 创建一个合成 Session，通过受支持的 RPC 验证命令发现、列表、无效 Release 拒绝及原生取消。检查进程使用该 fixture 的私有环境与临时目录。应用在恢复执行前加入不允许脱离的 Windows Job；清理必须同时观察到根进程退出和 Job 活动进程数为零。启动归属未知或 helper 异常完成时保留私有 home，而不报告已全部退出。纯验证器拒绝不完整审计记录和超时后才成功的响应；这些测试不能替代托管 Windows 的原生对话框验收。独立的 Copilot smoke 保持不变，仍不创建 Session。

Recorded-session snapshot 豁免：该命令只由私有 Desktop Host 注册，并要求其精确 Electron parent IPC owner。snapshot harness 必须从公开 CLI 启动，不能新增隐藏 Desktop driver；若强行覆盖该边界会违反 `snapshots/AGENTS.md`。该命令不发送模型请求，也不增加 model-visible input。因此由语法、真实子进程IPC、Session生命周期、Electron startup 与打包Desktop验收共同承担验证。
