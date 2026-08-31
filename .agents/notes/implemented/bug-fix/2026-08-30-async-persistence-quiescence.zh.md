# Agent Note: 异步持久化静止状态

Status: implemented

[English](2026-08-30-async-persistence-quiescence.md) | 中文

## Problem

持久存储与恢复工作可在启动它的同步事件之后继续处于 pending 状态。通过固定间隔等待的测试可能在 coverage 负载下检查到旧持久记录，或遗漏延迟到达的警告。Agent Teams 恢复也在运行时所跟踪的操作之外排队，因此服务 dispose 时可能在恢复仍使用持久化上下文的情况下释放该上下文。

## Decision

projection-cache 测试与其拥有的操作同步：直接写入与阈值触发写入会等待确切的 write promise；无法持有操作句柄的测试则等待其需要观察的确切存储行或警告。测试不再根据经过的挂钟时间推断写入完成。

Agent Teams 在延迟回调能够运行之前登记每个已调度的恢复 promise。dispose 先关闭准入并等待这些恢复 promise，再等待创建与 mailbox 操作，随后释放实时子 agent。截止点之后的调度不会创建操作。

生命周期测试保持一项恢复为未完成状态，并证明 dispose 在该恢复完成前维持 pending。持久化恢复测试继续使用现有断言与 timeout；静止状态的 dispose 通过消除跨实例重叠解决问题，而不是延长时间预算。

## Alternatives considered

**增加 sleep 或测试 timeout。** 更长延时仍然是在猜测文件系统与 coverage runner 的调度情况。它会掩盖缺失的所有权，并可能在更高负载下再次失败。

**让 Session 事件监听器等待检查点写入。** projection cache 有意使用 fail-soft write-behind。为了修复测试观察问题而让事件分发等待可选派生状态的持久性，会增加延迟并改变运行时 API。

**依赖嵌套的创建与 mailbox 跟踪。** 恢复可能在任何嵌套操作存在之前排队。dispose 必须持有顶层恢复 promise 才能消除该间隙。

## Consequences

coverage 测试在读取持久状态前等待其拥有的操作；其他测试在不削弱断言的情况下与确切可观察结果同步。Team dispose 最多可按配置的 disposal timeout 等待恢复，且任何恢复都不能比服务的持久化依赖存活更久。
