# 插件导航分组交接

## 仓库、分支与目标

- 原始仓库：`/Users/zvf003/ZStack/oc-chan`；原目录在 `refactor/plugin-system-monitor` 上有用户已有的更新分发等未提交改动，本任务未覆盖。
- 实现工作目录：`/Users/zvf003/ZStack/oc-chan-plugin-navigation-20261110`。
- 实现分支：`feat/plugin-navigation-20261110`。已整合远端 `e0fcb5c` 的双语 README、提交规范与右键菜单修复；推送时发现并行街区布局提交 `cf47834`，随后无冲突 rebase。功能提交 `e23b7d9b91998641e509bac7233ee9bca00fe47b` 已正常推送 GitHub `main`，GitHub API 回读一致。
- 对照目录：`/Users/zvf003/ZStack/oc-chan-plugin-navigation-baseline-20261110`，保留原始行为，仅同步修复测量探针锚点。
- 用户需求：左侧增加一级「插件」模块，插件市场已安装的插件集中作为其子目录；系统监控移入；是否显示由市场安装状态决定。

## 已完成

- 共享插件元数据增加 `distribution: 'builtin' | 'marketplace'`。内置页面继续保留一级入口，市场插件根据插件 ID、section 和真实 installed 状态生成子菜单。
- 新增 `PluginNavigation.tsx`，提供「插件」分组、展开收起、安装空状态、加载和失败提示；目录项沿用页面选择与导航机制。
- 系统监控不再是独立一级菜单，入口变为「插件 → 系统监控」；插件市场仍保留独立入口。
- 停用采集仍保留已安装插件的目录；卸载移除目录。卸载正在查看的插件时跳转市场，并恢复标题焦点。
- 采样刷新保留折叠状态；主动进入插件页面展开目录；使用原生按钮支持 Enter/空格。面包屑增加插件层级。
- 更新导航样式和长标题换行；没有新增依赖或循环动效。
- 扩展已有真实市场验收，覆盖菜单安装状态、选择、折叠、停用、重启、卸载回退及焦点。
- 修复已有性能探针漂移：App/TrayView 的 snapshot 已是派生常量，注入应匹配 `const snapshot = ...`，不能继续匹配已删除的旧 state 声明。修改前后目录使用同一修复。
- 更新 `docs/features.md` 和 `DESIGN.md` 的导航规则。

## 修改文件

- `src/shared/plugin-catalog.ts`
- `src/plugins/system-monitor/manifest.ts`
- `src/renderer/src/PluginNavigation.tsx`
- `src/renderer/src/App.tsx`
- `src/renderer/src/styles.css`
- `scripts/smoke/marketplace-scenarios.mjs`
- `scripts/performance/vite-plugin.mjs`
- `docs/features.md`
- `DESIGN.md`
- `README.md`、`README.en.md`：同步说明插件分组、系统监控入口和安装状态联动。
- 本交接文件。

## 实际验证

1. `npm run typecheck`：通过。
2. `env PATH="/Users/zvf003/.cargo/bin:$PATH" npm run smoke:renderer -- --scenario marketplace --out /tmp/oc-chan-plugin-navigation-smoke-20261110`：通过，`complete: true`、`errors: []`。运行真实隔离 Tauri/WKWebView 应用、真实签名插件包和采集进程，非 DOM 模拟。
3. 修改前：`env PATH="/Users/zvf003/.cargo/bin:$PATH" node scripts/performance/run.mjs --mode smoke --scenario daily --out /tmp/oc-chan-plugin-navigation-baseline-fixed-20261110`：通过。
4. 修改后：相同命令及负载，输出改为 `/tmp/oc-chan-plugin-navigation-after-20261110`：通过。
5. 已查看安装后与未安装状态的真实截图，确认一级菜单和子目录层级。
6. Impeccable 定向检查提示现有 CSS 色值、圆角的设计规范 advisory；未为此改写无关样式。
7. 整合主分支的原生鼠标输入驱动更新后，再次运行 `env PATH="/Users/zvf003/.cargo/bin:$PATH" npm run smoke:renderer -- --scenario marketplace --out /tmp/oc-chan-plugin-navigation-main-smoke-20261110`：通过，`complete: true`、`errors: []`；实例和 fixture 均已退出并清理，资源 current 计数归零。
8. 已审阅并同步中英文 README；各检查 18 个本地引用路径，互相切换的语言链接及居中 Logo 均有效。后续交接提交只更新执行记录，无需再改 README 用户说明。最后 rebase 新增的是独立 3D 场景及相关说明，导航实现、市场、输入驱动和专项脚本未变化，已通过的导航验证继续适用，未重复运行。

市场专项覆盖：初始未安装、安装、菜单子项选中与面包屑、刷新不重置折叠、键盘展开、采集停用/启用、取消下载、更新、校验失败、激活失败、重启保留安装，以及卸载当前页后的市场回退与焦点。中英文、文字比例 2、内容区域 880×640、1024×768、1280×860、1600×1000 检查通过。没有运行全仓库测试。

### 性能对照

环境：Apple M4 Max、16 逻辑核、128 GiB 内存、macOS 27.2、arm64、交流电；相同 daily 场景，各一次。256 条事件均读取、发布、接收和提交，无缺失。

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 应用启动至可交互 | 5052.64 ms | 5095.58 ms |
| 事件至提交 p95 | 115.5 ms | 115.5 ms |
| IPC 至提交 p95 | 3 ms | 2 ms |
| 单次输入至下一提交 | 111 ms | 108 ms |
| 应用及实例关联进程观测 RSS 峰值 | 507.52 MiB | 509.42 MiB |
| 稳定主进程及 WK 关联进程 CPU，单核百分比 | 23.21% | 22.50% |

CPU 最后一项由原始 resources 记录的累积 `cpuNs` 差值计算：仅取主进程存活期间的 measured 资源样本，各 10 个样本，跨度分别 9.019 s 和 9.021 s；纳入全部样本均保持同一 PID 与 startId 的主进程和 4 个 WK 关联进程。该口径排除短生命周期采集/工作进程，不是完整应用进程树 CPU。原脚本完整应用 CPU 有效区间修改前为 0、修改后为 4，不能作为完整 CPU 前后对照。

单轮短采样不能证明稳定性能提升或退化。没有运行长时间 soak、并发突增或大输入压力测试；本次没有调整资源预算、缓存或插件运行时。

### 证据与清理

- 市场结果：`/tmp/oc-chan-plugin-navigation-smoke-20261110/result.json`。
- 市场逐项记录：`/tmp/oc-chan-plugin-navigation-smoke-20261110/evidence/samples-000.jsonl`。
- 已安装截图：`/tmp/oc-chan-plugin-navigation-smoke-20261110/03-first-marketplace-install-lifecycle.png`。
- 空状态截图：`/tmp/oc-chan-plugin-navigation-smoke-20261110/02-first-marketplace-starts-uninstalled.png`。
- 前后性能数据分别位于上述 baseline-fixed、after 目录的 `result.json` 和 `evidence/samples-000.jsonl`。
- 最新主分支整合验收：`/tmp/oc-chan-plugin-navigation-main-smoke-20261110/result.json`；对应目录保留逐项记录与截图。
- 市场运行与重启的 launcher/application 已退出；driver 已移除；保留给重启的 profile 随后已移除；fixture 进程已停，fixture 目录已删除。
- 两次性能日志均返回「已清理本实例」。shutdownReport 的 documents、requests 和 global.current 各资源计数均为 0。
- 实现和基线 worktree 保留，不自动删除。

## 已知限制与状态

- 初次性能运行因 PATH 不含 cargo 失败；补充本次命令 PATH 后解决，未修改全局配置。
- 随后暴露性能探针 snapshot 锚点漂移；已修复并完成前后重新测量。失败证据仍保留，未隐瞒或据失败结果作性能结论。
- 可见原生窗口、Dock/托盘焦点、硬件全屏/分屏、连续拖动缩放及实际屏幕刷新率表现未验收。所有自动验收窗口保持不可见，未打断用户工作。
- 功能已提交并推送 GitHub `main`，远端回读为 `e23b7d9b91998641e509bac7233ee9bca00fe47b`；未发布、未安装、未替换 `/Applications/OC Chan.app`。GitHub CI 状态与本地验收分开，尚未据推送成功宣称 CI 通过。
- 原仓库的 Electron 时代工作区与当前 main 的 Rust/Tauri 实现不同；继续时以目标分支实际源码、脚本和规则为准，不照搬旧工作区的启动命令。

## 用户限制

使用中文；保留原目录与并行任务的未提交改动；安装状态决定目录显示，停用采集不能等同卸载；不增加兼容路径；开发验收使用隔离不可见窗口。用户已明确授权本次提交到 GitHub main，未授权安装、发布或清理其他工作树。

## 下一步

1. 需要确认云端构建时，按本次功能提交查询 GitHub Actions；CI 未完成不能写成通过。
2. 用户要求安装或原生窗口交互验收时，使用当前 Rust 分支的既有流程，补验可见窗口、分屏/全屏与连续缩放；不要把本次无头验收写成已安装应用验收。
3. 后续任务继续修改前先 fetch 当前 main 并核对并行提交；保留原目录、实现目录及基线目录，没有单独清理授权不删除。

## 恢复提示

继续 OC Chan 插件导航任务。工作目录 `/Users/zvf003/ZStack/oc-chan-plugin-navigation-20261110`，分支 `feat/plugin-navigation-20261110`。功能已通过真实市场专项、类型检查、daily 性能对照及主分支输入驱动整合后的市场复测；功能提交 `e23b7d9b91998641e509bac7233ee9bca00fe47b` 已推送 GitHub main，API 回读一致。原目录 `/Users/zvf003/ZStack/oc-chan` 的用户未提交内容已保留；尚未发布或安装，不重复仍适用的验证。按用户下一条要求继续，查询远端当前状态后再做后续修改。

## GitHub 交付回执

- 目标：`https://github.com/Zixiaobowen/oc-chan` 的 `main`；GitHub 身份 `Zixiaobowen`，Git 作者 `bowen.sun <bowen.sun@zstack.io>`。
- 功能提交：[e23b7d9](https://github.com/Zixiaobowen/oc-chan/commit/e23b7d9b91998641e509bac7233ee9bca00fe47b)。本次功能范围为 11 个文件、116 行新增、11 行删除；本交接单独作为文档提交。
- 正常推送回执：`cf47834..e23b7d9 HEAD -> main`，随后 `gh api repos/Zixiaobowen/oc-chan/commits/main` 返回同一完整 SHA。
- 首次推送因并行提交触发 non-fast-forward 拒绝；已重新 fetch、无冲突 rebase、正常推送，全程未强推。
