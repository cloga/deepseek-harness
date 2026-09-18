# Agent Note: Cordis preset skill 使用随附根目录

Status: implemented

[English](2026-09-18-cordis-bundled-skill-root.md) | 中文

## 问题

`cordis` preset 将部署自带的 skill（技能）归类为自定义文件系统根目录。在受影响的 Electron ASAR 运行时中，即使请求 bigint，文件系统元数据仍返回数字字段，导致本地提供方的 bigint 权限位掩码运算抛错。一个根目录失败就会中断文件系统 skill 提供方的发现流程，使用户 skill 和 preset 自带的 skill 一同不可见。

## 决策

[随附 preset](../../../../packages/preset/agent-presets/presets/cordis/agent.cordis.yml) 通过既有的 `bundledSkillDir` 选项注册相邻目录。Loader 相对于 preset 的 `baseUrl` 解析目录；skill 提供方通过宿主读取该根目录。项目、用户及自定义根目录保留文件系统服务检查。随附目录的排序优先级低于用户覆盖项。

## 考虑过的替代方案

**统一处理所有 Electron 文件系统 stat。** 完整的本地文件系统兼容性修改不仅要接受数字类型的权限字段，还必须保留版本新鲜度判断。正确分类 preset 自带资产不需要这项更广泛的修复，因此它不在本次修改范围内。

**让自定义根目录绕过文件系统服务。** 自定义根目录属于已配置的执行文件系统。将其一律视为受信任的宿主资产，会改变无关 skill 的访问行为。

**复制或编辑已安装的 preset。** 本地副本会偏离应用更新，而直接编辑随附安装内容会被升级覆盖。两者都没有修复应用源码。

## 后果

打包后的 preset skill 不再依赖本地文件系统对 ASAR 元数据的支持。此修改也移除了此前自定义根目录高于用户 skill 的优先级。它不会让通用文件系统工具兼容 ASAR，也不会改变提供方对其他根目录失败的处理。

验证覆盖经 Loader 加载的真实随附 YAML 行、相对于 preset 的路径解析、文件系统后端拒绝随附目录时用户与随附 skill 的加载、同名项优先级，以及自定义根目录仍受文件系统约束。发布 ASAR 检查还会针对指定应用中的真实 preset 和运行时执行[打包技能探针](../../../../apps/desktop/tests/fixtures/packaged-skills-smoke.mjs)，使用私有主目录与合成的用户技能。发布定稿前，它要求技能发现完整，且四次 skill 工具调用全部成功。
