---
description: "仅本地的自适应路由证据、归属 profile 的存储与有界任务工作量核算。"
kind: "package-library"
---

# @deepseek-ai/dsh-model-routing-learning

[English](README.md) | 中文

## 概述

本库在显式 profile 所有权下保存封闭的本地路由证据，并核算已测得的任务工作量，不虚构缺失成本或成功标签。存储入口是 `openLearningStore(ctx, config)`。版本与 epoch 检查保护排队更新，覆盖整个生命周期的所有权锁排除竞争进程。这些基础组件本身不挂载插件、不收集用户历史、不提供浏览器 API，也不会激活学习策略。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

从[模块入口](src/index.ts)导入本库的 Host 所有者必须已拥有 [storage-domain](../../storage/storage-domain/README.zh.md) 能力。提供部署拥有的 `profileKey`、绝对 `ownershipLockPath`、获取锁的等待预算和明确的账本限制。使用同一 profile／domain 的所有进程必须使用同一个所有权路径。环境变量或当前目录不会被视为 profile 身份依据。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { openLearningStore } from '@deepseek-ai/dsh-model-routing-learning'
import type { LearningStoreConfig } from '@deepseek-ai/dsh-model-routing-learning/types'

declare const ctx: Pick<Context, 'storageDomain'>
declare const config: LearningStoreConfig

const opened = await openLearningStore(ctx, config)
if (opened.available) {
  try {
    const snapshot = opened.store.read()
    // Use snapshot.revision and snapshot.epoch for an owned transaction.
  } finally {
    await opened.store.close()
  }
}
```

租约不可用会返回显式结果；持久数据格式错误会拒绝打开，而不是重置历史。关闭会先停止写入准入，再排空 domain，最后释放所有权。清除会推进 epoch，使清除前的异步工作不能凭过期权限重新填入记录。它不写 Session 日志、全局设置或授权反馈上传的事件。

`LearningController` 接收封闭的 ID 与账本版本戳，用于评估、批准、回滚、禁用和清除。它从服务端拥有的已封存记录重建证据，并重新检查当前配置、可比较组、上下文版本、候选资格、源记录版本及有效期。支持提案的可比较组发生变化时，仅保留提案还不够；活动权重会安全退回基础策略，直到重新评估。版本是稳定人工基础策略上的有界覆盖，不是叠加的自我修改。浏览器不能提交观测或权重作为授权依据。

`TaskWorkAccounting` 是有界算术与生命周期辅助工具，不是自动收集器。生产者所有者在 await 前保留操作租约，核算每次实际尝试，并按固定的明确指标版本提供严格归一化的完整调用 token 总数。失败调用不等于免费。缺失用量、未知路由、未结束工作、不受支持的覆盖范围或中断观测，都会使工作量不完整。封存不提供任务成功判定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部说明 — 点击展开</summary>

每个 profile 的单一账本保存有界的作用域、任务事实、不可变提案与不可变版本。更新会校验封闭 schema，并在持久化优先的存储队列内比较版本和 epoch。活动版本必须保留其匹配提案。提案的配置与上下文版本戳可防止内容相等的配置变化悄悄复用过期权限。

| 源码 | 职责 |
|---|---|
| [类型](src/types.ts) | 不含提示、代码或任意诊断文本的封闭本地记录。 |
| [Schema](src/schema.ts) | 身份、引用、条数与字节限制。 |
| [存储](src/store.ts) | 生命周期独占租约与排队的持久 CAS 操作。 |
| [工作量核算](src/work-accounting.ts) | 完整覆盖要求与有界的加权 token 算术。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [路由策略](../model-routing/README.zh.md) — 严格候选选择与独立的证据评估器。
- [LLM 运行时](../llm/README.zh.md) — 实际适配器尝试观测及其限制。
- [Storage-domain](../../storage/storage-domain/README.zh.md) — 持久化优先的事务，而不是跨进程 CAS。

<a id="model-experience"></a>
## 模型体验

无，因为本库不注册提示、工具、模型调用或模型可见的 Session 事件。

#### KV Cache 影响

无直接影响：本库不组装或发送模型请求。消费方负责后续路由变化及其缓存影响。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **尚非已安装的学习产品** — 可信的生产者归属、本地结果 API、定期评估与设置 UI 需要上层运行时所有者。
- **显式部署隔离** — 必须提供 profile key 和一致的所有权锁位置；不会悄悄抢占陈旧锁。
- **不完整证据保持未知** — 普通回合结束、模型自述、手动选择模型以及沉默，都不是经过验证的成功标签。
- **没有节省保证** — 工作量指标是明确的比较权重，而非货币；观测证据不证明因果上的质量或成本改善。

<a id="dev-note"></a>
### 开发备注

将本地结果与授权遥测的反馈事件分开。不要为了让策略提案出现而弱化所有权、CAS、不可变证据或完整性检查。路由器保持为底层依赖：本包可以消费路由能力，但路由包不能反向导入这个上层证据所有者。
