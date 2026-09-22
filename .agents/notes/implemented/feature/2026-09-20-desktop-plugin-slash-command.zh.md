# Agent Note：Desktop 插件 slash command

状态：已实现

[English](2026-09-20-desktop-plugin-slash-command.md) | 中文

## 问题

Desktop 独占 `$DSH_HOME/profiles/desktop`。共享插件页面可以准备经过验证的事务，但在 Session 中工作的用户也需要会话内入口。普通 CLI 有意拒绝保留 profile，无法观察活动 Electron Host、renderer 草稿、事务锁、归属 receipt 或原生中断确认。

## 决策

打包的 Desktop Host 注册一个内置 `/desktop-plugin` 命令。它支持 `list`、`install npm <spec>`、`install github <owner/repo[#ref]>`、`install release <verified-release-json>`、`remove`、精确版本 `update`、`enable`、`disable` 和 `disable-all`。slash 安装排除本地路径和任意 URL，因为 Session 工作目录不是稳定的 Electron 包解析基准。受支持的非命令来源仍通过共享插件页面操作。Registry 更新要求目标已通过 registry 安装；来源安装的包不会被静默转换为 registry 包。

命令处理器不修改 profile，也不调用 pnpm。有界且封闭的操作通过 Node 子进程 IPC，从精确的活动 Desktop Host 发送到 Electron。Electron 校验操作、重新进行权威来源解析，并使用 alpha2 上既有的 fork 启动器持有的 profile 暂存／激活所有者。基于 Web 的 `runProfile`、ready URL／注入、更新任务控制及关闭协议保持不变；不恢复 framed 传输或独立插件窗口，也不新增 preload 变更 API、额外 loopback 服务、任意包管理器参数或 CLI 例外。

仅选择状态的变更保留包字节、依赖解析、来源锁、receipt、provisioning 和归属。它只改变候选组合包选择，不是安装。Disable-all 在 profile lease 内准备一个规范且非空的目标集合，使用一个候选和一次确认；空集合会失败，而不是虚构包名。Registry 目标资格和原有选择状态在同一 lease 内检查，不依赖单独的预检查。

普通安装／移除暂存保留旧有五字段结果。待处理／状态／列表查询额外展示带版本的选择记录及全部实际目标，但不授予激活权。共享记录定义由 [boot 子系统](../../../../docs/subsystems/boot.zh.md)维护。Host 与 Client 必须一起构建和验收；不承诺旧客户端支持新的选择变体。

### 自重启落盘握手

获批事务会停止执行命令的 Host，因此准备阶段在该 Host 存活时运行：既有私有候选先通过冻结锁重建保留的依赖图，再单独解析获准安装／更新的目标。两类操作都使用生产依赖，并忽略包脚本及 pnpmfile；patch 表达式保持不执行。准备可能访问网络，但不会执行候选 Host。Electron 只返回带类型的 `prepared` 结果。Host 观察匹配的 `command/done`，等待 `sessions.flush(session)` 成功后，才发送 request id／command id 确认。观察器不可用、落盘失败或发送回调失败均不能授予结算完成状态。

命令来源与规范化意图通过带版本的私有准备日志，绑定到 Electron 创建的 Host generation、请求、命令和事务。所有尚未写入激活日志的激活入口，都在命令专用原生确认前后检查匹配的活动授权。普通 Web 审阅不能激活命令准备，也不能借用其他命令的就绪状态。重启后的孤立准备仍可读取和丢弃，不会自动激活。既有、已获准激活的恢复仍保留日志、原生确认、准入、健康检查与回滚要求。

原生命令确认默认取消。只有批准后继续通过既有输入、生命周期及准入检查，才能停止 Host 并执行候选以验证最终健康状态。在获准写入激活日志前，取消、断线、过期身份、结算超时或落盘失败均保持活动 profile 不变，并在准备工作停止后请求仅丢弃该命令自己的候选。清理失败时保留自有数据，不能报告成功。获准后，其余生命周期由激活及日志恢复负责；主动断开旧 Host 不代表取消。普通 Web“稍后”保留其准备。原生取消不追加第二条命令完成记录。解锁或清理状态不确定时保留安全限制，而不是报告成功。

列表响应仅包含包名、实际安装版本和选择的启用状态。错误通过小型固定错误码 allowlist 穿过 IPC，而不是回传任意 manager、子进程、网络、路径、包或输入诊断。用户输入保留普通 `command/run` 日志。中断后的内部启动诊断仍使用既有产品路径。

GitHub 传输失败保留 HTTP 状态、固定请求类别及有界的数字限额／重试响应头，不包含 URL、响应正文、请求 ID、Cookie 或任意响应头值。不自动重试拒绝响应；仅有状态403不能证明限流，验收也不向应用注入凭据。

## 考虑过的替代方案

**允许 `dsh plugin --profile desktop`。** 这会绕过活动 Electron 所有者，无法保留确认、事务互斥、receipt、健康检查或回滚。

**通过 preload 暴露变更。** 应用文档和 Client 插件不得获得直接修改 Desktop 包的权限。

**增加 loopback 控制服务。** 它重复引入了精确子进程 IPC 已经提供的认证、生命周期和端口归属管理。

**返回 `prepared` 后立即停止。** 延时或观察到事件均不能证明命令完成已写入持久化 Session 存储。

**复用安装来改变组合包选择。** 安装可能重新获取产物并替换归属证据，不能准确实现启用／禁用操作。

**仅在内存保存命令来源。** 恢复的准备记录可能借普通 Web 审阅绕过命令结算或原生确认。

## 后果

Host 直接依赖 commands registry，命令贡献由 effect 管理，并在报告就绪前安装。命令消息与 alpha2 IPC 生命周期并存；既有元数据版本号不代表与已退役 framed 协议兼容。命令报告准备完成，而非安装完成或激活健康。选择操作不获得新的 verified-release receipt，新启用目标需要实际健康检查。生成的待处理查询 codec 与 UI 描述同一源码版本的公开联合类型；严格业务解析与 codec 规范化仍是不同检查。

## 必需验证

语法测试覆盖受支持来源、精确更新输入、边界和安全输出。实际 registry／Session 生命周期及子进程 IPC 测试验证唯一完成记录、确认前成功落盘、发送失败、释放、取消、超时、busy 状态及过期请求。事务测试保留旧日志，并拒绝混合待处理记录、伪造来源、基线／目标漂移、重新计算哈希后的语义篡改，以及普通 Web 激活孤立命令记录。选择测试验证原子目标、不变的产物／归属证据及不新增 receipt；registry 资格在 lease 内验证。Main 测试覆盖实际清单解析／lease、授权、原生弹窗配置、健康目标，以及准入明确失败后有界地恢复窗口。

[独立打包命令 fixture](../../../../apps/desktop/tests/fixtures/desktop-plugin-command-smoke.ts)创建合成 Session，通过受支持的 RPC 验证发现、列表、无效 Release 拒绝及原生 Cancel。Shell 创建新 profile；fixture 等待实际 Client 就绪，并绑定源码／tree／运行／尝试、plan／lock 及打包产物身份。取消检查实际 alpha2 准备／丢弃记录及不变的活动元数据／产物字节，不伪造旧审计文件。PREPARED 比较保留解析后的身份／字段，不宣称原始日志字节相等。

应用在恢复执行前加入不允许脱离的 Windows Job。清理必须观察根进程退出、Job 活动进程数为零，并关闭自有连接／句柄后才能写入最终成功。启动归属未知或 helper 异常完成时保留私有 home。原始失败（包括 undefined）不会被诊断或清理错误替换。窗口发现采用有界 Win32 枚举及精确进程、root-owner、HWND、标题和控件身份；可见性或枚举顺序不是身份。访问控件前注册标准 UIA provider。只调用重新验证后的自有 Cancel 控件；helper 证据不宣称验证默认键盘焦点。纯 provider／验证器／错误记录测试不是实际原生验收，也不是对完整所有者执行的故障注入。

独立命令阶段是发布 workflow 的必需检查，与组合 Copilot／原生 composer 套件及其封闭证据格式分离。其内部产物不是第七项公开发布资产，也不代表既有聚合解析器消费了该产物。完整发布验收仍要求实际托管原生运行、完整清理以及其余安装器／发布检查。

Recorded-session snapshot 豁免：该命令属于私有 Desktop Host 及其精确 Electron 父进程。公开 CLI snapshot harness 若添加隐藏 Desktop driver，会违反 `snapshots/AGENTS.md`。该命令不发送模型请求，也不增加 model-visible input，因此由语法、真实子进程 IPC、Session 生命周期、源码组件和打包 Desktop 验收承担验证。
