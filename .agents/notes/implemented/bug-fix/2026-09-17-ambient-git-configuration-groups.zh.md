# Agent Note: 整组移除继承的 Git 临时配置

Status: implemented

[English](2026-09-17-ambient-git-configuration-groups.md) | 中文

## Problem

Git 的临时环境配置由计数及带索引的键值对组成。按凭据形状过滤变量名称会移除 `GIT_CONFIG_KEY_n`，却留下计数和值。子进程收到不完整配置组后，Git 会在执行所请求命令前拒绝它。留下的值还可能携带临时认证设置，而其变量名并不具有凭据形状。

## Decision

共享的 `scrubbedParentEnv` helper 按名称拒绝隐式继承的 `GIT_CONFIG_COUNT`、数字索引的 `GIT_CONFIG_KEY_n` 与 `GIT_CONFIG_VALUE_n`，以及旧的 `GIT_CONFIG_PARAMETERS` 形式。它先判断名称，再读取保留值。独立的 `GIT_CONFIG_GLOBAL`、`GIT_CONFIG_SYSTEM` 与 `GIT_CONFIG_NOSYSTEM` 设置继续可用。

这条规则仅适用于继承的环境项。调用方拥有的显式覆盖在其后合并，保留有意提供的完整 Git 配置、明确转发的凭据、Windows 大小写不敏感替换以及删除墓碑值。导出的敏感名称表达式保持不变；拥有独立远端环境策略的提供方不会被静默改写。

本地提供方对普通与终端启动环境使用该 helper。纯服务与环境测试进入正常 Windows 测试清单。既有 egress 套件仍单独排除 Windows，因为其代理测试依赖 POSIX 大小写敏感环境变量和进程行为。

## Alternatives considered

**保留 Git 键描述符以避免配置组损坏。** 这也会保留可能把认证值传入无关子进程的隐式配置。

**移除全部 `GIT_CONFIG_*` 设置。** 这会无谓丢弃独立的配置文件与系统配置选择。临时配置组具有精确的名称集合。

**过滤最终合并的环境。** 这会移除明确授权的进程级配置与凭据，而不只是限制隐式继承。

## Consequences

子进程不会继承不完整 Git 临时配置组，包括零计数、稀疏或孤儿条目。合成测试在不读取对应值的前提下验证全部被拒绝名称，并保留两种平台情况下的显式覆盖。隔离的真实 Git 配置查询以退出码 128 拒绝破损配置组，经过共享清除后以退出码 0 成功，且不读取用户配置或访问网络。这不是网络、代理、TLS、凭据获取或已安装 Git 路径的变更。调用方仍负责选择可执行文件并提供其明确授权的凭据。
