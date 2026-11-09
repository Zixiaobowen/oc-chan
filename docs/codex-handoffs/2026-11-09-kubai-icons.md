# Kubai Icons 替换

- Repo: `/Users/zvf003/ZStack/oc-chan`
- Branch: `feat/kubai-icons`
- 目标：接入 https://icons.kubai.design/ 并替换现有业务图标。

## 已完成

35 种 Lucide 图标、12 个 TSX 文件、78 处调用已改用 Kubai 0.2.1 的默认 deep import。移除 lucide-react；新增 kubai-icons-react 及其精确传递依赖 kubai-icons，均 MIT。图标使用 trigger="none"，沿用真实请求驱动的刷新旋转，不新增 hover/toggle。保留 Logo、菜单栏品牌、图表和拓扑状态/关系。深色主题用官方 --ki-e/--ki-w 变量增强内部符号区分；托盘防休眠图标用 title 提供可访问名称。

修改文件：`src/renderer/src/{App,components,AgentsView,AgentTopology,AgentTopology3D,AgentContextMenu,SchedulesView,ScheduleHistory,EventsView,SystemView,SystemMetrics,TrayView}.tsx`、`styles.css`、package manifest/lock、README、DESIGN、dependency-review-policy，以及打包门禁 `scripts/check-package.mjs` 和对应测试。门禁的直接依赖要求改为 kubai-icons-react；kubai-icons 仍通过实际 bundle 清单校验。

## 已有验证证据

- `npm run build:app`：类型检查和生产构建通过；主 renderer JS 从744.11 kB到876.93 kB。保留既有大chunk警告，未调高阈值。
- `node scripts/dist.mjs --dir`：arm64目录包构建通过；未安装、发布或推送。
- `node --test scripts/check-package.test.mjs`：最终45/45通过。
- `node scripts/check-package.mjs --app 'release/mac-arm64/OC Chan.app' --arch arm64 --output /tmp/oc-chan-kubai-package-20261109.json`：通过，app 272011231 B、ASAR 2222784 B、helper 117744 B，冻结预算未改。
- `npm run audit:dependencies -- --output /tmp/oc-chan-kubai-dependencies-20261109.json`：verified，现有6个受影响依赖节点，不声称无漏洞。
- Impeccable扫描12个TSX：无报告；新增CSS扫描仅advisory。黑色混色端点已在DESIGN说明，其余为既有圆角提示，未扩展修改。
- 独立无头真实Electron页面人工检查：1280×860与880×640，概览、系统监控、设置，浅色与深色，无图标缺失/页面横向溢出；最终深色暂停符号可见，browser errors为空。原生可见窗口未验收。
- 首轮性能daily前后数据：`/tmp/oc-chan-kubai-before-ready-20261109/result.json`、`/tmp/oc-chan-kubai-after-20261109/result.json`；单轮且宿主负载高、并行任务活动，不能从首轮推断性能改善或稳定回归。

## 环境问题和边界

最初缺少Electron二进制，执行`node node_modules/electron/install.js`后恢复。前两轮smoke被main watch重建中断：第一轮主代理修改package格式，第二轮并行应用更新源码变更。没有当作业务用例通过。

为避免共享源码热重载，在`/tmp/oc-chan-kubai-validation-20261109`复制源码及依赖运行最终验收；最初node_modules symlink被许可证路径校验拒绝，随后改用APFS clone复制依赖。旧版隔离对照位于`/tmp/oc-chan-lucide-baseline-20261109`。临时快照不是worktree，未改变正式应用数据。

并行用户任务修改了`src/main/app-updates.test.ts`、`src/main/plugins/{app-updates,update-controller}.ts`、`src/renderer/src/UpdateSettings.tsx`和README其它内容，必须保留，不归为本任务成果。原有未跟踪handoff `2026-11-09-local-update.md`未改。

## 最终验收与性能限制

最终smoke `/tmp/oc-chan-kubai-smoke-final-20261109/result.json` 已PASS，212.17秒；完整renderer场景、设置持久化与重启通过。两个实例均processesGone=true、profileRemoved=true，退出后采集计时器与资源保留均为0。其后仅新增紧凑图标禁用滤镜的CSS；最终浅/深色、1280×860/880×640、暂停/继续、图标filter实际为none、页面无横向溢出与browser errors为空均经真实无头Electron复核。无可见原生窗口验收。

隔离顺序daily短测，Apple M4 Max、128GB、L1 32 Agent、相同seed，宿主load约15，非长期稳定性结论：

| 指标 | Lucide | Kubai原始滤镜 | Kubai禁用滤镜（最终） |
| --- | ---: | ---: | ---: |
| 启动可交互 ms | 6102 | 3848 | 4214 |
| 应用进程树峰值RSS MiB | 1125.84 | 1272.33 | 1188.55 |
| 应用CPU均值（单核%） | 1.43 | 1.18 | 1.12 |
| 首次交互往返 ms（单次） | 198.92 | 351.78 | 325.39 |

证据依次为`/tmp/oc-chan-kubai-control-before-ready-20261109`、`/tmp/oc-chan-kubai-control-after-ready-20261109`、`/tmp/oc-chan-kubai-filter-control-20261109`的result.json。滤镜对照支持移除每图标离屏模糊开销的决定，但剩余约63MiB峰值增量和单次交互差值仍是限制，不能声称性能无退化或改善。未执行长期soak、原生60/120Hz可见动效或全仓测试。

最终CSS后重新构建目录包并通过门禁：`/tmp/oc-chan-kubai-package-final-20261109.json`，app=272018244 B、ASAR=2229797 B。该产物同时包含当时并行更新功能最新代码（main=607.32kB、renderer主JS=882.08kB），不能把相对早先产物的全部增量归因于图标；本任务renderer完整smoke针对上述固定快照。

## 后续动作

1. 用户要求提交时只暂存本任务改动块，保留更新功能并行修改。
2. 用户要求安装时重新构建目标版本并按项目安装流程验收，不把目录包构建等同安装完成。
3. 若继续压缩图库开销，以实际图标层数/DOM及高密度视图为依据，保留真实SVG来源与主题适配；不提高资源预算掩盖增长。

恢复提示：OC Chan Kubai图标替换已实现，完整renderer、定向包测试、实际无头视觉与目录包门禁已有证据。先读本handoff，保留应用更新并行修改。未提交、安装、发布；性能短测有剩余开销，勿宣称零退化。
