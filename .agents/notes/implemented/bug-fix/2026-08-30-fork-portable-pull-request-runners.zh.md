# Agent Note: 仓库 Fork 中可移植的拉取请求运行器

Status: implemented

[English](2026-08-30-fork-portable-pull-request-runners.md) | 中文

## 问题

拉取请求工作流为主要 Linux 作业、原生 Windows 作业、聚合判定和预览选择仅限本仓库使用的大型运行器标签。GitHub Fork 会复制这些标签字符串，却不会继承上游仓库的运行器访问权或 Cloudflare 凭据。标准托管的矩阵作业可以完成，但每个主要作业都因没有匹配运行器而持续排队，因此 Fork 永远无法产出 `all checks passed`。

## 决策

拉取请求运行器选择会检查 `github.repository`。`deepseek-harness/deepseek-harness` 保留经过测量的大型运行器和自托管故障切换选择。仓库 Fork 在 `ubuntu-latest` 上运行主要 Linux 作业与聚合判定，在 `windows-2025` 上运行原生 Windows 作业。Fork 作业还会按标准运行器容量降低外层 gate、snapshot、浏览器、lint 和包校验的并发。覆盖率检查使用一个 Vitest 进程和一个 worker，因为并行的完整测试进程会耗尽托管运行器资源，使真实 shell 和生命周期探针失败。保留 16 核 fan-out 会使有界生命周期与持久化测试超时，或在文件系统发布时发生争用。Cloudflare 预览是仅限上游的作业，因为 Fork 无法发布到上游部署项目。

工作流在 Fork 中保留每个必需作业及其命令，只改变运行器容量。因此，Fork 会执行完整的必需证据，而不是跳过检查或依赖仓库外部运行器配置。

本决策部分取代[可移植拉取请求 CI 决策](../process/2026-07-23-portable-required-pull-request-ci.zh.md)中“没有自动后备”的条款，以及[原生 Windows 拉取请求 CI 决策](../process/2026-08-08-native-windows-pull-request-ci.zh.md)中“仅使用组织运行器”的条款。这些记录继续负责上游运行器拓扑、实测并发、必需聚合判定和 Wine／原生双通道覆盖。

## 曾考虑的替代方案

**让 Fork 作业保持排队并依赖本地检查。** 不采用：分支保护使用 GitHub 检查结果，本地证据无法创建缺失的必需聚合判定。

**在 Fork 中跳过主要作业。** 不采用：绿色聚合判定将缺少必需的静态、覆盖率、快照、构建和原生进程证据。

**为 Fork 配置同名自定义运行器。** 不采用：GitHub Fork 中的正确性不应要求复制私有运行器或部署基础设施。

## 后果

Fork 拉取请求可以在可移植的 GitHub 托管容量上完成必需 CI，但执行速度慢于上游的大型运行器路径。上游拉取请求保留既有性能、实测并发与故障切换行为。工作流测试锁定每个运行器选择器的两个分支、Fork 并发上限，以及仅限上游的预览条件。
