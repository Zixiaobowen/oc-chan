# Agent 活跃状态筛选交接 · 2026-11-03

- Repo：`/Users/zvf003/ZStack/oc-chan`
- 当前 branch：`fix/settings-accessibility-recovery`，交付时读取 `.git/HEAD`。共享工作区有其他会话的设置修复；较早交接的 `fix/tern-native-navigation` 已不是当前分支。
- 目标：在 Agent 页面添加全部、活跃、不活跃筛选，并与主/子 Agent 类型、搜索和现有拓扑交互组合。
- 状态：实现、定向测试、真实应用验收、正常运行实例启动及文档更新完成。未执行提交、推送、安装到 Applications、签名、公证或发布。

## 已完成与修改范围

- `src/renderer/src/agent-topology.ts`：新增 `AgentActivityFilter`；投影接口显式接收活跃状态。活跃为 `state === 'working'` 或存在经时效处理的调用事件；不活跃为明确 `idle` 且无近期事件。仅进程存活或未知状态不归入不活跃。
- 活跃筛选仅补齐命中节点的必要父链，不带入未命中的后代。关联节点不计入匹配数。筛选时暂时展开原折叠分支，清除后恢复折叠集合。
- `src/renderer/src/AgentsView.tsx`：原生下拉框、可访问名称和说明，筛选键包含类型/活跃状态/搜索，空结果可清除三项条件。复用 `useRecentAgents` 的 6 秒事件时效与暂停时刻；近期调用不表示仍在执行。
- `src/renderer/src/styles.css`：筛选组及搜索在窄窗换行，限制输入宽度，保持已有视觉样式。
- `src/renderer/src/agent-topology.test.ts`：迁移旧调用的显式 `all` 参数，增加状态分类、未知状态、类型/搜索组合、父链保留、状态变化和折叠恢复的行为覆盖。
- `README.md`、`DESIGN.md`：同步筛选口径、父链、匹配数量和窄窗行为。
- 没有增加依赖或修改采集端状态契约。保留共享工作区其他任务的修改。

## 实际运行的检查

- `node --import tsx --test src/renderer/src/agent-topology.test.ts`：13/13 通过。
- `npm run package -- --config.directories.output=release/activity-filter`：通过，包含 TypeScript 检查、原生 helper 构建、Electron Vite 构建和 arm64 目录打包。产物未签名。
- `impeccable detect --json --scope layout src/renderer/src/AgentsView.tsx src/renderer/src/AgentTopology.tsx src/renderer/src/styles.css`：返回 `[]`。
- 未运行全仓测试。

## 真实 Electron 验收

使用已打包应用 `release/activity-filter/mac-arm64/OC Chan.app`，隔离 profile 为 `/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/occhan-activity-verify-659i5hvt`。数据来自本机真实快照。

- 冻结快照有 19 个 Agent：活跃 6、不活跃 12；另 1 个仅有进程存活证据，保留在全部中。逐项比较渲染节点 ID 和原快照状态，三种筛选均符合口径。这是验收时快照，不是持续不变的运行数量。
- 实际操作活跃状态、子代理类型、无匹配搜索，空结果的清除按钮恢复类型=全部、活跃状态=全部、空搜索。
- 已验收中文和英文名称、说明以及浅色/深色主题；恢复实时显示后 renderer 错误列表为空。
- 通过 Electron 原生 BrowserWindow 修改实际内容尺寸：880×640，959/961/1119/1121×860，1280×860，1280×1320，2560×1320，以及原生全屏 2560×1440。筛选框可见、根页面无横向溢出；尺寸变化保留画布变换。
- 880×640 下临时将 `--font-scale` 设为 2，筛选栏仍可见、无横向溢出；随后恢复。此检查仅针对本次筛选栏，不等同于整个应用 200% 页面缩放或全部节点文字无障碍通过。
- 原生下拉框可聚焦，选择 helper 能更新值；CDP 与 Electron `sendInputEvent` 的方向键/确认键序列均未提交选项。未获得有效的键盘选择回执，不能宣称该项已通过，也未据此认定原生控件存在产品缺陷。
- 冻结快照无父子边，因此父链组合的确定性证据来自定向测试；不将该帧冒充实际父子关系的交互验收。
- 全屏、双倍字号和深色截图分别在系统临时目录：`omp-sshots-15bf1e0fd1119146.webp`、`omp-sshots-15bf1e726f119148.webp`、`omp-sshots-15bf1e72a9919149.webp`。不保证临时截图长期保留。

## 性能记录

同样 40 节点、5000 次投影，修改前 P50/P95 为 0.018042/0.029583 ms，修改后为 0.018583/0.028417 ms；累计 CPU 为 140.450/140.138 ms。两次在独立 Node 进程执行，差异包含测量波动，不代表整个应用的性能改善；没有进行长时间整进程压力测试。

## 本机交付与占用

- 正常运行服务：`occhan-activity-filter-delivery`，持久模式，启动 PID `89619`。
- 可执行文件：`/Users/zvf003/ZStack/oc-chan/release/activity-filter/mac-arm64/OC Chan.app/Contents/MacOS/OC Chan`。实际进程无 inspector、remote-debugging 或隔离 profile 参数；启动时移除了工具环境的 `NODE_OPTIONS`。
- 使用现有正常应用设置，交付前只读核对为浅色、中文、大字号、系统字体、托盘小面板、Dock 可见、防休眠关闭；没有改写该设置文件。
- AppKit 回执：bundle 路径正确，`finishedLaunching=true`、`hidden=false`、`terminated=false`、激活成功。CoreGraphics 主窗口 `9824` 在屏幕上；原生窗口截图可读并显示实时本机概览。
- 交付截图：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/occhan-activity-verify-659i5hvt/activity-delivery.png`。
- 本会话旧服务 `occhan-root-row-delivery` 已停止。本轮隔离服务 `occhan-activity-filter-verify` 已停止，浏览器接管已释放。
- 另一会话的设置验收进程 `59119` 当时仍使用 `release/mac-arm64/OC Chan.app`，并带独立 profile `/tmp/oc-settings-priority-lGzx32/revised`。未停止它，未覆盖它使用的应用包。本轮交付以 `release/activity-filter/mac-arm64/OC Chan.app` 为准。

## 用户偏好、限制与后续动作

中文沟通；保留用户和并行任务改动；只显示真实采集数据；不改 OMP 全局配置、模型、聊天日志或技能；不自动安装、发布、提交或推送。

1. 日常试用打开本轮独立应用包，进入“Agent 与子代理”，使用“活跃状态”下拉框；仅进程存活的节点在“全部”中查看。
2. 若之后统一打包目录，先核对另一会话是否仍占用原包并协调产物，不覆盖运行中的验收实例。
3. 若需要补充键盘或屏幕阅读器验收，使用真实原生交互取得选择变化回执；不要将本轮远程键盘尝试写成已通过。
4. 新改动仅运行受影响的定向检查和真实应用场景；提交、推送、安装与发布需各自明确授权。

## 可粘贴恢复提示

继续 `/Users/zvf003/ZStack/oc-chan`。Agent 页面已添加全部/活跃/不活跃筛选，与类型、搜索、父链上下文和折叠恢复组合。13 项定向测试、独立应用打包及真实窗口筛选/多尺寸检查通过；原生下拉键盘提交未取得有效回执。当前分支为 `fix/settings-accessibility-recovery`，保留其他设置会话的改动。正常实例服务 `occhan-activity-filter-delivery` 使用 `release/activity-filter/mac-arm64/OC Chan.app`，不要误把旧 `release/mac-arm64` 包当成本轮产物，也不要停止其他会话的设置验收。未提交、推送、安装或发布；已通过且仍适用的检查无需重复。
