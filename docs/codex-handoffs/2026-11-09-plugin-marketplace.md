# OC Chan 插件市场与独立系统监控插件

- 日期：2026-11-09
- Repo：/Users/zixiaobowen/myProjects/oc-chan
- Branch：feat/plugin-marketplace-20261109
- 目标：将系统监控拆成可独立分发的插件，并完成市场、安装、卸载、更新、取消及重启恢复。
- 状态：实现与本轮无头验收完成；未提交、推送、发布，也未把本轮功能安装到正式应用。此前“更新 oc-chan”的本机安装已完成，见 2026-11-09-local-update.md。

## 已完成

系统监控源码位于 plugins/system-monitor，构建为 system@1.0.0 的独立 .ocplugin 包。系统采集实现不再编译进主程序；核心保留公开 SDK、动态注册表、生命周期、共享资源预算和有界市场事务。首次运行不自动安装，未安装时不创建系统采集器，相关页面提供市场入口。

市场提供搜索、已安装／可更新筛选、发布者与版本、能力与运行要求、安装、更新、取消、内联卸载确认和真实错误。概览、系统、来源、设置、托盘接入安装状态。卸载取消并排空采集，移除注册、安装文件及系统快照，保留采集偏好。

应用携带离线目录与插件包。在线目录固定为 https://raw.githubusercontent.com/Zixiaobowen/oc-chan/main/plugin-market/catalog.json 。生产路径不接受任意 URL 或第三方代码；只支持可信官方插件，模块白名单不是安全沙箱。2026-11-09 实际读取该 URL 返回 HTTP 404；本轮没有发布远端文件，不能将本地 HTTP 更新验收等同于官方服务可用。

包验证覆盖字节数、SHA-256、manifest、平台、宿主最低版本与 API 版本。目录最多 256 KiB／64 项；单包最多 2 MiB、代码最多 1 MiB；已安装最多 16 包／32 MiB；单一在途事务、30 秒限时。先验证新包再停止旧插件；激活失败恢复原版，回滚或清理失败保留诊断。取消等待响应流及事务清理完成。

发布产物位于 plugin-market/catalog.json 和 plugin-market/system-1.0.0.ocplugin。验收中使用的 1.1.0 版本与 [marketplace-update-proof] 标记只属于测试 HTTP 源，用来证明实际执行了更新后的代码；不是生产插件版本。

## 涉及文件

- plugins/system-monitor：独立采集器、清单及边界测试。
- src/main/marketplace：目录、包校验、安装事务、运行时加载及 SDK。
- src/main/plugins、src/main/monitor.ts：动态生命周期及系统分区管理。
- src/main/index.ts、src/preload、src/shared：启动、关闭、受限 IPC 与共享市场契约。
- src/renderer/src：市场页面、状态 provider 与各页安装入口。
- scripts/build-plugin-market.mjs、scripts/check-package.mjs、scripts/ci-tests.mjs、打包配置及 plugin-market：独立分发与门禁。
- scripts/smoke-renderer.mjs、scripts/smoke/marketplace-feed.mjs、scripts/smoke/marketplace-scenarios.mjs：真实下载、取消、回滚、重启与布局验收。
- README.md 与 AGENTS.md：当前架构、安装语义、分发、资源预算及验收方式。

## 可定位的验证证据

本记录列出最终验收阶段有独立结果文件的检查；未运行全仓测试。

### 真实 Electron 市场验收

命令：使用 Node 24.22.1 执行 node scripts/smoke-renderer.mjs --scenario marketplace。

结果：PASS，33.37 秒。证据目录：

/var/folders/sw/0g6s73xd04n89bg0lympw6_40000gn/T/oc-chan-smoke-evidence-SFWJWQ

result.json 的 complete 为 true。覆盖首次未安装、安装／卸载、真实系统采集、下载进度与取消、更新代码实际执行、篡改拒绝、激活失败回滚、重启保留已安装代码、最终卸载。重启使用首次进程真实保存的 settings.json 与安装包，未复用 localStorage。

布局覆盖 880×640、1024×768、1280×860、1600×1000 CSS 视口，中英文、200% 文字与卸载确认的焦点恢复。验收为无可见窗口的真实 Electron，不代表原生分屏／全屏、Dock、物理托盘或可见动效验收。

保存 10 张截图。主代理已查看 05-first-marketplace-download-and-update.png 与 10-restart-marketplace-final-uninstall.png。首次与重启进程均退出码 0，定时器 0、pendingSections 为空；命令、文件、socket、队列及计费字节均回到 0，开发进程与独立 profile 已释放。

验收中定位并修正了取消请求与旧请求结果的交错。另一次重启验证失败来自测试在 250 ms 窗口几何保存完成前读取设置；最终场景等待实际持久化的 1280×860 几何后再保存重启种子，完整场景随后通过。

### 生产包检查

命令：node scripts/check-package.mjs --app '/Users/zixiaobowen/myProjects/oc-chan/release/mac-arm64/OC Chan.app' --arch arm64 --output /tmp/oc-chan-marketplace-package-20261109.json

结果：budget=passed；app=271946785 字节，asar=2141070 字节，原生导航 helper=117744 字节。包内目录 998 字节，独立系统插件 15736 字节。该检查不是正式应用重装或启动验收。

通过 cleanupBuildApplication 精确回收本任务构建的 .app；回执 removed=true、registration=not-registered。随后 release/mac-arm64 与 .dev-instances 均为空。保留现有 ZIP／DMG、源码工作区与交付证据。

### 同负载性能与短时资源压力

硬件：Mac17,6，Apple M5 Max，18 逻辑 CPU，128 GiB RAM；Darwin 27.2.0。工具链 Node 24.22.1、Electron 45.2.1。

负载：32 个合成 Agent、固定调度／历史 fixture、真实系统采集；15 次快照调用，每次间隔约 1 秒；每 250 ms 采样整个开发应用进程树（包含开发启动器／构建进程）。启动时间从启动 launcher 到 renderer ready。快照耗时包含 DevTools 协议往返，不是单独的主进程 handler 执行时间。

| 单次短测指标 | 拆分前 | 拆分后 |
| --- | ---: | ---: |
| 启动就绪 ms | 2807.75 | 2112.79 |
| 全进程树峰值 RSS MiB | 1283.36 | 1299.30 |
| 进程 CPU 百分比之和的采样均值 | 26.83 | 24.47 |
| 快照往返均值 ms | 3.94 | 4.86 |
| 快照往返中位数 ms | 3.27 | 5.92 |

这是各一次约 18 秒和 17 秒的观测，不能宣称性能提升或没有退化。快照往返均值增加约 0.92 ms；当前样本未把应用 IPC、DevTools 和宿主调度分别测量，不据此断言稳定退化的原因。

压力段执行 30 次卸载／安装，首轮同时发起 20 个安装请求：1 个成功、19 个明确拒绝；每轮验证卸载清空数据、安装恢复真实系统数据。压力段持续 60.16 秒，整个测量约 77 秒；全进程树峰值 RSS 1420.97 MiB，低于本轮 2 GiB 上限。运行 60 秒之后的 RSS 区间 1328.20–1343.75 MiB，最终 1341.50 MiB。未发生 OOM；该证据只覆盖这段负载与时长，不代表长时间稳定性。

对应结果：

- /var/folders/sw/0g6s73xd04n89bg0lympw6_40000gn/T/oc-chan-market-baseline-h3Hl90/result.json
- /var/folders/sw/0g6s73xd04n89bg0lympw6_40000gn/T/oc-chan-market-after-TsAI4q/result.json
- /var/folders/sw/0g6s73xd04n89bg0lympw6_40000gn/T/oc-chan-market-stress-1qmZBR/result.json
- 压力退出报告位于最后一个目录的 exit.json：timers=0、pending=0、资源计数归零。

一次性测量脚本 /tmp/oc-chan-marketplace-measure.mjs 在取得结果后已删除。三个测量进程退出码均为 0，remainingProcesses 为空，instanceRemoved=true。

## 当前安装、限制与保护范围

正式应用仍为 /Applications/OC Chan.app，版本 0.1.0。本轮末现场进程查询确认主 PID 41742，子进程 PID 41750、41751、41754、46217；没有本仓库 .dev-instances 下的进程。此应用来自前段本机更新，不包含本轮插件市场代码。

未执行 Git commit、push、发布或本轮功能的正式安装。当前线上目录 HTTP 404 是尚未发布的事实；离线安装与本地 HTTP 更新路径已通过验收。未覆盖 x64、真实可见窗口交互、物理托盘／Dock、120 Hz 帧率或长期运行。

保留进入本任务前的单一正式安装生命周期改动与交接文件，尤其 scripts/local-app-lifecycle.mjs、scripts/push-main.mjs 及其测试和已有 README／AGENTS 修改块。保留并行任务的 readme-review、release-publishing、push-update-audit 等交接文件。不能全量暂存或重置工作区。

## 后续动作

本轮功能实现与上述验收已完成。后续操作须按用户当轮授权执行：

1. 提交时逐块纳入插件市场改动，区分此前已有生命周期改动和并行文档；不要使用全量暂存。
2. 若要求合并并推送 main，使用 npm run push:main，核对远端提交，再现场检查官方 catalog 与包 HTTP 200、字节数及 SHA-256。
3. 若要求把新功能装到本机，执行 npm run install:local，获取该版本真实 renderer／IPC／采集／历史就绪回执，并确认临时 .app 回收。
4. 若要求原生交互专项，遵循用户授权使用 dev:window，补齐真实窗口分屏／全屏、物理托盘及动效；若要作性能结论，补做能区分 IPC 与 DevTools 开销的重复对照测量。

## 恢复提示

继续 OC Chan 插件市场任务。读取本文件与 README 的“插件市场与独立插件包”。当前分支 feat/plugin-marketplace-20261109，系统监控已独立为 .ocplugin，市场安装／卸载／更新／取消／回滚／重启已通过真实无头 Electron 验收，arm64 包门禁通过，30 次生命周期与 20 并发请求短压测通过。临时应用和实例均回收，正式应用 PID 41742 仍是此前安装版本。源码未提交、推送或安装；官方目录实测 404。保留既有生命周期和并行文档改动。已通过检查不要例行重跑；按用户新授权执行提交、发布或安装，不能把本地 HTTP 验收当作线上可用。
