<p align="center">
  <img src="resources/brand/oc-chan-icon.svg" width="112" height="112" alt="OC Chan" />
</p>

<h1 align="center">OC Chan</h1>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <strong>看清 Mac 上的 Agent、定时任务与系统状态。</strong>
</p>

<p align="center">macOS · Apple Silicon · 本地只读观察</p>

<p align="center">
  <a href="#功能">功能</a> ·
  <a href="#安装与体验">安装与体验</a> ·
  <a href="#支持范围">支持范围</a> ·
  <a href="#开发">开发</a> ·
  <a href="#文档">文档</a>
</p>

<p align="center">
  <img src="docs/images/agent-project-buildings.png" width="1100" height="620" alt="OC Chan 的 3D 协作拓扑：一栋建筑对应一个项目，每个任务独占一层，主 Agent 使用办公室，子 Agent 使用共享工位" />
</p>

<p align="center"><sub>真实 3D 场景渲染截图，使用合成演示数据。</sub></p>

同时开着多个 Agent 和后台任务时，OC Chan 提供一个集中查看的桌面窗口：找到对应的工作目录和会话，检查任务状态，再看机器的资源占用。

## 功能

### 看见 Agent 之间的协作关系

默认的 3D 视图中，一个项目对应一栋建筑，一个主会话任务及其子代理对应一层。主 Agent 使用独立办公室，子 Agent 坐开放共享长桌。选中任务楼层查看内部，点击员工打开详情，也可以切换到 2D 关系图，搜索、折叠分支和调整布局。父子关系来自实际采集证据，缺失或循环的分支会标为待归属。

<details>
<summary>查看 2D 协作视图</summary>

![OC Chan 的 2D 协作拓扑，连线展示主 Agent 与子代理的关系](docs/images/agent-topology.png)

同一批合成演示数据的 2D 视图，沿连线查看主 Agent 与子代理。

</details>

### 从 Agent 回到对应会话

右键已关联的 OMP 节点，可跳转到对应的 Tern 标签页；子代理沿已确认的父链定位主会话。跳转前重新核对目标身份，已关闭或变更的会话会明确提示。首次使用需完成 Tern 集成和 macOS 辅助功能权限设置，详见[跳转说明](docs/features.md#协作拓扑画布)。

### 查看定时任务，追查执行结果

集中查看 launchd、cron、OMP 和 Hermes 的任务，按类型、范围、状态或名称筛选。Hermes 任务可查看逐次执行历史、耗时和投递结果；确认的执行失败、投递失败，以及数据源持续不可用和恢复会进入本地事件列表。通知默认关闭，可按来源或任务订阅。

### 按需装上系统监控

从应用内「插件市场」安装官方系统监控插件，查看 CPU、内存和网络趋势，以及磁盘空间和 CPU／内存进程排行。菜单栏面板可组合展示 Agent、任务和系统摘要。

已安装插件统一显示在左侧「插件」分组下，系统监控从「插件 → 系统监控」进入。目录随安装状态更新：安装后显示，停用采集仍保留，卸载后移除。

系统监控首次运行不自动安装。应用附带的插件包可离线安装；在线检查与更新需要对应发布源可用。安装、卸载和更新的完整说明见[插件市场](docs/architecture.md#插件市场与独立插件包)。

界面支持中英文、浅色／深色和六套主题；macOS 26 及以上可使用原生 Liquid Glass，并遵循系统辅助功能设置。

红绿灯右侧按钮或 **⌃⌘S** 可收起侧栏，主导航和已安装插件移到顶栏，数据来源与设置保留在右侧。拖动分隔线超过最小宽度 64px 也可收起，再次展开恢复原宽度；布局偏好会保存。窄视口使用紧凑导航菜单，减少动态效果跟随系统设置。

## 支持范围

不同来源提供的证据不同。进程存在、正在工作和近期有调用分别显示，未知状态不会记成零。

| 来源 | 可以查看 | 主要边界 |
| --- | --- | --- |
| OMP / Tern | 会话、父子关系、主会话工作状态、近期调用及 Tern 跳转 | 暂不能准确统计正在执行的子代理总数 |
| Codex CLI / 桌面版 | 当前会话、工作目录、可确认的父子关系 | 不提供精确活动状态、近期调用或外部窗口跳转 |
| Claude Code / OpenCode CLI | 存活进程与可读取的元数据 | 只有进程证据时，不推断正在工作 |
| Hermes | 定时任务、执行状态、逐次历史及确认的异常事件 | 状态取决于数据库与进程证据；证据不足时保留未知 |
| launchd / cron | 任务配置、执行计划及可读取的状态 | 不提供统一的逐次执行历史，不推算下次运行时间 |

OC Chan 只读观察上游 Agent 和任务，不执行定时任务、不终止 Agent，也不修改父子关系。采集数据保留在本机，不上传会话正文；应用更新与插件更新会连接对应发布源。完整覆盖和隐私边界见[功能说明](docs/features.md#已知可见性边界)。

## 安装与体验

当前面向 **Apple Silicon Mac**，Intel 不在本期支持与验收范围。源码仓库公开。

推送到 `main` 后，GitHub Actions 自动构建，并在检查通过后发布 [预览 Release](https://github.com/Zixiaobowen/oc-chan/releases)，标签为 `preview-<运行编号>-<提交短 SHA>`。下载其中的 DMG 或 ZIP，使用 `SHA256SUMS.txt` 核对摘要；预览版不进入应用内稳定更新通道。[Build macOS 构建记录](https://github.com/Zixiaobowen/oc-chan/actions/workflows/build.yml)同时保留产物和验收证据，PR 只验证、不发布。具体步骤见[本地交付与手动升级](docs/distribution.md#本地交付与手动升级)。

本地和预览版采用 ad-hoc 签名，不等于 Developer ID 签名或 Apple 公证。正式版使用与包版本一致的 `vX.Y.Z` 标签，并要求 Apple 签名与公证密钥；正式签名、公证及签名版本的原地更新仍待验收。应用内更新仅适用于具备 Developer ID 签名的安装版。详见[发布与更新条件](docs/distribution.md#应用内更新)。

## 开发

使用 **Rust 1.99（仓库固定工具链）、Node.js 22.12+（建议 24）**、npm，以及包含 macOS 26 或更新 SDK 的 Xcode Command Line Tools。以下命令在仓库根目录执行；默认启动真实的无头 Tauri / WKWebView，不显示桌面窗口。自动化原生输入验收需要 macOS 26+：

```sh
npm ci
npm run dev
```

需要手动查看桌面界面时，改用：

```sh
npm run dev:window
```

开发实例使用独立配置、Cargo 构建目录和认证 Unix socket，不读取或改写正式应用的个人设置。按 Ctrl+C 退出并排空本实例。Node 仅用于构建和开发工具，生产后台由 Rust 执行。无头调试、定向验收和打包命令见[开发文档](docs/development.md)。

## 文档

- [功能、操作与数据边界](docs/features.md)：拓扑、任务历史、本地事件、通知和设置。
- [开发与验证](docs/development.md)：环境、无头调试、定向测试和性能验证。
- [安装、构建与发布](docs/distribution.md)：交付、升级、CI、签名更新和本机清理。
- [架构与插件](docs/architecture.md)：采集生命周期、独立插件包、IPC 和品牌资源。
- [性能基准](docs/performance-baseline.md)：已测负载、结果和未覆盖项。
- [产品约定](PRODUCT.md) · [设计规范](DESIGN.md) · [工程规则](AGENTS.md)。
