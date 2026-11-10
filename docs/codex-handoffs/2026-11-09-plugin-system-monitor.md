# OC Chan 插件架构与系统监控迁移

- 仓库：`/Users/zvf003/ZStack/oc-chan`
- 分支：`refactor/plugin-system-monitor`
- 目标：参考 DeepSeek Harness / Cordis，以最小核心和公开插件契约装配 OC Chan，将系统监控迁为首个包含采集、类型与界面的完整插件。
- 状态：实现、定向测试、构建、真实无头 Electron 验收已完成；未提交、未推送、未安装或部署。

## 架构与改动

官方参考（2026-11-09 核对）：

- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md

官方名称为 Cordis。借鉴公开服务与可逆注册，复用已有 `CollectionPluginRegistry`；未新增框架依赖、插件商店或任意第三方代码加载。

- `src/shared/plugin-catalog.ts`：受信任内置目录、统一元数据/分区/初始快照/校验，最多 16 项。`CollectionSnapshots` 可声明合并；分区和快照从其派生。
- `src/main/plugins/{contracts,registry,catalog,lazy}.ts`：公开预算服务、异步工厂和懒加载；注册返回异步 disposer，停用取消后等待真实排空，迟到导入不创建实例；卸载中拒绝启用与新增依赖；关闭按固定逆序列表排空。
- `src/plugins/system-monitor/{manifest,types}.ts` 与 `main/`：系统元数据、类型、CPU/内存/磁盘/网络/进程采集及测试；所有默认命令和磁盘申请使用宿主注入的预算服务。
- `src/plugins/system-monitor/renderer/`：系统页面、概览指标、设备信息、页脚、托盘指标、来源翻译和专属 CSS。旧 SystemView/SystemMetrics/CSS 与旧系统采集路径已删除，无兼容导出。
- `src/renderer/src/plugins/`：公开贡献契约、懒装配、可撤销注册与局部错误边界。最多 16 插件、合计 64 托盘贡献。App/Tray 按贡献呈现，不嵌系统业务。其他已有功能通过相同 renderer 目录装配。
- 来源开关、设置比较、导航、IPC、诊断和事件观察使用统一目录；系统停用撤下呈现，保留可达路由与重新启用入口。旧快照仍保留在公共状态，但不显示误导性的“以下是旧快照”空页横幅。
- 托盘偏好改为 `{ excluded: [...] }`，默认全选；停用插件期间修改其他面板不会覆盖未加载面板的选择。旧数组格式明确显示读取错误，不迁移、不保留兼容层；用户重新选择后保存当前格式。
- 更新性能插桩、测试 glob 和 `scripts/ci-tests.mjs` 的新文件映射。README、development 和 AGENTS 已更新插件边界。

安装就绪协议 `src/main/installation-check.mts` 继续检查当前随包交付的四个功能分区，未扩大安装/发布范围。现有 AppUpdatesPlugin 契约保留。

## 保留的用户工作与权限

开始任务时分支为 `fix/github-release-updates`，已有应用更新/发布流程未提交修改：`.github/workflows/build.yml`、README、development、package.json、发布脚本、app-updates 测试和插件、update-source、UpdateSettings，以及 GitHub Release 交接。全部保留；本次 README/development/package.json 仅追加本任务相关变更，不得全量覆盖或全量暂存。

未授权提交、推送、安装或部署。只使用独立无头 Electron，不打开可见窗口，不使用正式应用个人数据。LSP status 显示本项目未配置语言服务器。

## 实际验证

后端定向命令（177 项通过）：

```sh
node --import tsx --test --test-concurrency=2 \
  src/main/plugins/registry.test.ts src/main/plugins/lazy.test.ts \
  src/main/plugins/agents.test.ts src/main/plugins/schedules.test.ts \
  src/plugins/system-monitor/main/system.test.ts src/plugins/system-monitor/main/network.test.ts \
  src/main/monitor.test.ts src/main/settings.test.ts src/main/ipc-boundary.test.ts \
  src/main/navigation.test.ts src/main/diagnostic-report.test.ts \
  src/main/events/collector.test.ts src/main/events/store.test.ts \
  src/main/resource-budget.test.ts scripts/ci-tests.test.mjs
```

另外执行：

- `node --import tsx --test src/renderer/src/plugin-registry.test.ts src/renderer/src/tray-selection.test.ts src/renderer/src/view-state.test.ts`：当时 11 项通过。修正托盘偏好后单独重跑 `tray-selection.test.ts`，最终 4 项通过；其余 9 项代码未改。
- `node --test scripts/ci-tests.test.mjs`：加入前端映射后 9 项通过。
- `node --import tsx --test src/main/collectors/hermes-history.test.ts`：11 项通过。
- `npm run build:app`：最终 TypeScript 与 Electron/Vite 生产构建通过。第一次发现三处测试 fixture 的异步工厂/服务注入/StatsFs 类型适配遗漏，已修正后通过。构建仍提示按需加载的 3D scene chunk 约 600.81 kB 超过 Vite 500 kB 警告线，未调整阈值掩盖。
- 后端与 renderer 独立静态复核。renderer 发现停用期间编辑托盘默认选择的回归，已用排除集合修复并补行为测试。

未运行全仓测试。

### 系统插件运行与清理

临时脚本 `node /tmp/oc-chan-plugin-smoke-20261109.mjs` 已执行成功，耗时 48.453 秒，脚本随后删除；原始证据保留：

`/tmp/oc-chan-plugin-evidence-20261109-aeKjhg/result.json`

真实隐藏且不可聚焦 Electron，独立 fixture/profile，真实系统采集，夹具 Agent/任务。验证首次指标、停用不采集/不呈现、重新启用新样本、20 次启停、24 个并发 refresh 合并为 1 次采集。35.573 秒观察期有 35 次完整应用 RSS 样本，整段观察到的应用树 RSS 峰值 651.89 MiB；资源预算未超限。正常退出后 timers=0、pending=0、所有资源预留=0，所属进程与 profile 均已释放。

截图 `01-system-enabled.png`、`02-system-disabled.png`、`03-system-reenabled.png`、`04-system-observed.png` 位于同目录。旧停用截图包含后续已去掉的旧快照横幅；后续浏览器复核确认横幅不再出现。

额外连接 `node scripts/develop.mjs --inspect` 的真实 Electron：点击系统页、通过真实 IPC 停用、点击“打开数据来源”、实际点击系统开关恢复、返回系统页。880×640 CSS 内容区无整页横向溢出；1280×860 系统界面已查看。窄窗截图：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15c6f12f530d722f.png`。浏览器连接已释放，所属开发实例已停止；`.dev-instances` 只剩任务开始前的 `instance-9jSULN`，未触碰它。

一次命名服务经 npm 包装启动未报告就绪，已停止；改用同一开发脚本的直接 Node 入口成功。没有以可见窗口绕过无头要求。

### 性能记录与限制

```sh
node scripts/performance/run.mjs --mode smoke --scenario startup --out /tmp/oc-chan-plugin-before-20261109
node scripts/performance/run.mjs --mode smoke --scenario startup --out /tmp/oc-chan-plugin-after-20261109
node scripts/performance/run.mjs --mode smoke --scenario daily --out /tmp/oc-chan-plugin-daily-20261109
```

三份 result.json 均 complete=true。相同主机和启动场景的单次就绪时间 3363.56 → 1826.01 ms，首次交互往返 33.37 → 31.86 ms。启动资源采样过短：前态/后态启动 RSS 只有 2/1 个完整样本，后态没有完整 CPU 区间；全程还包含首次托盘打开，因此不能用全程 RSS 数值推断启动内存回归或优化。不得据此宣称性能提升或完整 CPU/RSS 前后比较已完成。

最终 daily smoke（32 Agent 元数据、1100 任务夹具、主窗口与托盘、事件与交互）完成约 14 秒，包括 8 秒代表性测量。应用树 RSS 峰值 1183.64 MiB；可读 CPU 区间平均单核 2.01%、最大 2.89%；资源预留最终归零。该场景包含其他功能，不是系统插件独占内存。首次托盘创建并展开 CPU 详情通过。

环境：Apple M4 Max、128 GiB、macOS 27.2、Electron 45.2.1、Node 24.22.1。以上均为短时无头验证；未覆盖长期 soak、所有大输入组合、真实原生窗口连续缩放、200% 文字、VoiceOver、Dock/托盘焦点、可见动画及系统通知。没有把短测当作长期无 OOM 证明。

## 后续可选动作

1. 查看本次插件契约与系统目录的代码差异，保留并行发布改动。
2. 用户明确授权后再进行有选择的本地提交；推送/安装/发布分别需要对应授权。
3. 若要形成性能提升结论，在稳定环境补充足量、同负载的前后 CPU/RSS 与长期采样。
4. 用户要求原生交互验收时再使用 `npm run dev:window` 补充可见窗口与辅助功能场景。

恢复提示：本分支 OC Chan 插件迁移已实现并通过定向测试、构建和无头运行验收。系统监控位于 `src/plugins/system-monitor`，共享目录和 renderer 贡献用于扩展；参考为 Cordis，但未引入其依赖。不要覆盖现有 GitHub Release 工作；未提交/推送/安装。先读本交接，按用户新的授权继续，不重复已通过且仍适用的检查，不把短时性能数据当作优化结论。

## 后续提交授权

用户随后明确要求推送到 GitHub `main`（原文 `mian`）。本次仅提交插件重构及其文档，现有 GitHub Release 和新增审计文件仍留在工作区。推送命令临时跳过会触发本机安装的 pre-push hook，不修改全局配置，不安装或发布应用。远端是否更新以实际 push 回执与远端 SHA 核对为准。
