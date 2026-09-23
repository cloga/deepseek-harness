---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-21-auto-model-routing

[English](2026-09-21-auto-model-routing.md) | 中文

## 概述

新增显式 Auto 意图、分类器请求与结果审计、已确认对话路由决策、独立子级委派偏好，以及解析后的原生子级选型事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-auto-model-routing
baseline: false
changes:
  - root: "event:model/auto-selection"
    previous: null
    after: "dfbe37452791c72e41816096643f1d0fe7cdfcb416b9dac8c740789aacf6d220"
    decision: same-version
  - root: "event:model/delegation-auto"
    previous: null
    after: "461046735139728f1163b3f602502c2a1c708cc258bd5bf799bf4523dc53bf2e"
    decision: same-version
  - root: "event:model/routing-decision"
    previous: null
    after: "a33ebc4f7d89c44c1d5d8a126ea879d60d8aec21542f071a3e171e3d592f9eec"
    decision: same-version
  - root: "event:model/routing-request"
    previous: null
    after: "552783b494452ece9ff0b444318d0e65f26566357784859435e1f5509dd8bcc7"
    decision: same-version
  - root: "event:model/routing-result"
    previous: null
    after: "448e11a7f21a52ee38d0df164f0ebb66c0cb92d2155cf7bc7f70c86467d9850e"
    decision: same-version
  - root: "event:subagent/model-selection"
    previous: null
    after: "9d7a8cfe9d981c8fae6424d3d6e6bf66a5eeb20dc553565818c9d6954e774c8c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这些都是普通的附加日志事件。现有版本 3 的请求头、事件信封、消息表面、手动选择及已捕获的子模型权限记录保持不变。没有 Auto 记录的 Session 仍使用手动或继承路由。Auto 意图与委派偏好是读取所必需的：不认识这些事件类型的旧构建会拒绝日志，而不是静默采用不同路由恢复。已安装的当前读取器使用重新生成的已知事件集合，不修改已发布编解码器或历史代次。折叠行为变化时，投影缓存修订号独立更新。

<a id="verification"></a>
## 验证

定向路由运行时套件通过 54 个测试，覆盖手动与异步选型、已捕获委派、隔离、取消和清理。真实 Loader 与正式 AgentLoop 的组合测试校验提示词、模型、强度和决策的一致性。回放套件通过 175 个测试，包括通过当前格式读取器的文件级分类器回放，以及对格式错误或无法重建审计的显式拒绝。API 测试通过 28 个用例；原生子级选型和持久生命周期测试另行覆盖授权、描述符一致性及恢复不重新选型。完整产品资格验证仍是单独的必需步骤。

<a id="dev-note"></a>
## 开发备注

无。
