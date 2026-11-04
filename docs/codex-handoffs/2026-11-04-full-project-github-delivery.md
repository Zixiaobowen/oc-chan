# OC Chan 完整项目 GitHub 交付 · 2026-11-04

## 仓库、分支与目标

- Repo：`/Users/zvf003/ZStack/oc-chan`。
- Branch：`master`，此前为尚无提交的 `fix/settings-accessibility-recovery`。
- 远端：`https://github.com/Zixiaobowen/oc-chan`，GitHub 私有仓库；`origin/master` 为交付分支。
- 用户明确要求将整个 OC Chan 项目提交并推送到 master。此前误将范围理解为 Hermes 任务迁移，仅推送了独立的 `hermes-personal-tasks`；本次补齐完整应用仓库，二者保持独立。

## 完成范围

- 纳入完整 Electron 主进程、preload、React/TypeScript 界面、Agent/子代理与系统/任务采集器、设置、Tern 跳转和原生 Swift helper 源码。
- 纳入全部现有测试、npm 锁文件、Vite/TypeScript/打包配置、构建与 smoke 脚本、图标、Tern 插件源文件、设计规范、产品说明、工程规则及阶段性交接。
- 按现有 `.gitignore` 排除 `node_modules/`、`out/`、`release/`、`.DS_Store`、`.impeccable/review/` 和可重新编译的 `resources/tern-navigation/present-window`。
- 更新 README 的源码地址和安装包分发说明；新增本交接。没有修改应用行为，没有重新安装或发布应用安装包，没有清理用户数据或其它项目。

## 验证依据

本次仅整理既有完整项目的 Git 交付，沿用已通过且仍适用的构建、定向测试和原生应用验收，没有重复运行全仓测试、构建或业务任务。

- 最新 select/桌面模块交接：`2026-11-03-select-arrow-spacing.md`。其中记录 `npm run build`、10 项设置测试、macOS 打包、5 处下拉框跨尺寸/主题/语言验收，以及安装后原生窗口验证。
- 设置平铺交接：`2026-11-03-flat-settings.md`，记录八项设置保存、键盘操作、冷启动、真实保存失败恢复及 200% 重排。
- 2026-11-04 Hermes 迁移时再次使用已安装 `/Applications/OC Chan.app` 验证任务页，确认九项迁移任务可见。该次验收没有修改 OC Chan 源码。
- 本轮 Git 交付核对完整纳入文件、暂存内容的空白错误、私有可见性、默认分支及远端 master SHA。最终提交与推送结果以 Git 回执为准。

## 限制及禁改边界

- 这是完整源码交付，不等同于已签名、公证或分发安装包；本机安装包继续保留原位。
- 既有 OMP 活动子代理统计和 Hermes 任务运行状态可见性限制仍以 README 为准，没有在此次提交中虚构运行状态或扩大产品功能。
- Hermes 个人任务脚本的独立仓库为 `https://github.com/Zixiaobowen/hermes-personal-tasks`，不是 OC Chan 主项目的替代品；不删除该仓库或回滚已完成的任务迁移。
- 不重置、强推或清理其它项目。用户本次授权范围为完整 OC Chan 项目的提交和推送，不包含新的部署或安装包发布。

## 恢复后的检查顺序

1. 在本仓库核对 `origin/master` 与最新本地提交；不要依据旧交接的“尚无提交”重复初始化或新建远端。
2. 后续应用修改按受影响模块运行定向验证，并使用真实 macOS 应用核对界面行为。
3. 如用户另行要求分发安装包，再处理构建、签名、公证和 Release；不把源码已推送当作安装包已发布。

## 恢复提示

> 继续 `/Users/zvf003/ZStack/oc-chan`，主分支 master，私有远端 https://github.com/Zixiaobowen/oc-chan。用户已明确要求完整项目提交推送，不是只推 Hermes 个人任务脚本。本次纳入全部应用源码、测试、配置、锁文件、资源、插件和项目文档，构建产物/依赖/原始验收资料沿用 gitignore。此前产品验收记录见各阶段交接；本次无应用行为改动，无需重跑全仓测试。先核对最新 Git 现场，保留其它仓库和用户数据。
