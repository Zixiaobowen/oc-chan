# Agent 根节点同排与纵向展开交接

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`fix/tern-native-navigation`
- 目标：父上子下；所有根级 Agent 在同一水平线上横向平铺；“适应全部”能够展示本次真实快照的整排节点。
- 本文是最新布局阶段记录；较早的 `2026-11-02-agent-topology-canvas.md` 中分支、服务和 PID 属于历史阶段。

## 已完成

- `src/renderer/src/agent-topology.ts`：Dagre 使用 `TB`；各关系组件只沿 X 轴排列，取消三列网格和按分支高度换行。每个组件按完整宽度留 48px 间距，根节点 Y=0，后代向下展开；删除不再使用的高度计算和分行状态。
- `src/renderer/src/AgentTopology.tsx`：父节点底部出线、子节点顶部入线；最小缩放从 20% 改为 5%，最大缩放仍为 180%。调整前真实快照在“适应全部”时两端被 20% 下限裁切；调整后已验证全部节点进入画布。
- `src/renderer/src/agent-topology.test.ts`：更新已有行为测试，覆盖 18 个独立根节点同排、大小不同的分支同排、多级父子上下关系、缺失父节点的可见根节点及无重叠。
- `DESIGN.md`：同步当前排列方式和缩放范围。
- 未新增依赖，未修改采集口径、调度或活动状态判定。

## 实际检查

- `node --import tsx --test src/renderer/src/agent-topology.test.ts`：10/10 通过。其后布局算法与测试未再修改，最后只降低画布缩放下限。
- 最终 `npm run package` 通过，包含 TypeScript 检查、原生辅助程序构建、Electron Vite 构建和 arm64 目录打包。最终 renderer 为 `index-D9sSsWA4.js`。
- Impeccable 最终局部扫描：`impeccable detect --json --scope layout src/renderer/src/AgentTopology.tsx src/renderer/src/agent-topology.ts src/renderer/src/agent-topology.css` 返回 `[]`。
- 未运行全仓测试。

## 实际 Electron 界面证据

使用的是 `release/mac-arm64/OC Chan.app/Contents/Resources/app.asar/out/renderer/index.html`，不是浏览器模拟页。

- 纵向布局阶段：真实快照 25 节点、7 条关系，已检查 SVG 路径终点 Y 大于起点 Y；所有已渲染连接点为 top/bottom。收起 4 个后代后边数为 3；展开经实际 paint 后恢复 7 条。被遮挡窗口中立即计数和等待 compositor 会超时，不应据此声称边丢失。
- 根节点同排阶段、缩放下限调整前：真实快照 20 节点、2 条关系，已渲染根节点全部 Y=0，两条关系向下；20% 下限造成两端裁切，因此降低下限。
- 最终包：快照已变为 19 个根节点、0 条父子关系，19 个节点均 Y=0；“适应全部”为约 14.56%，逐节点检查 bounding rect 均在画布内。最终没有活跃可见子节点，不能将这一帧当作父子连线的复验证据；前述连线实现和布局算法在最后缩放调整中未变。
- 最终搜索无结果、清空恢复、32 字符真实工作标题筛选均已操作。无匹配时页面宽度仍为 1280px，没有根页面横向溢出。
- 最终根节点全览截图：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15be4278a50016bc.webp`，属于临时系统目录，不保证长期保留。

## 性能核对

独立 Node 进程的前后结果存在启动、GC 与分配器波动，因此又在同一进程内交替运行原分行算法和当前同排算法。负载相同：40 节点、32 条边，预热后 8 轮，每个版本合计 480 次；原分行代码在内存中重建，没有改动仓库文件。

| 指标 | 原分行 | 根节点同排 |
| --- | ---: | ---: |
| 单次 P50 | 2.650 ms | 2.627 ms |
| 单次 P95 | 3.779 ms | 3.617 ms |
| 480 次累计 CPU | 1885.227 ms | 1868.949 ms |
| GC 后 JS 堆 | 17,774,720 B | 17,745,256 B |

这是布局函数的受控对比，没有把小幅差异宣称为整个应用的性能提升，也未进行长时间整进程树压力测试。

## 已知限制与本机设置修复

- 200% 文字检查：将现有 `--font-scale` 临时加倍后，固定高度节点中的标题、路径和指标行发生重叠。已恢复 CSS 变量；此问题位于未修改的卡片字号/固定行高设计，不在本次根节点排列改动中修复。不能宣称 200% 文字无障碍验收通过。截图：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15be42e1398016c2.webp`。
- 在本轮较早的纵向布局阶段，实际原生窗口已检查 880×640、959/961/1119/1121×860、1280×860、半屏内容 1280×1319、全屏 2560×1440；当时没有页面横向溢出，手动节点位置和画布视口跨尺寸变化保持。最终同排包再次尝试原生缩放时，System Events 未暴露窗口，返回 `window 1` 无效索引；未将旧阶段检查冒充最终包的完整尺寸矩阵验收。未完成连续原生拖动缩放或新的错误状态矩阵。
- 启动验收时发现 `/Users/zvf003/Library/Application Support/OC Chan/settings.json` 中 `codeFont` 为不支持的 `sf-mono`，严格校验导致启动失败。仅将该项改为支持的 `system`（系统等宽），其余设置保留；没有增加兼容值、迁移或兜底路径。该无效值的写入来源未确认。

## 正常运行实例

- 验收服务 `occhan-root-row-final-check` 及其浏览器接管已结束。
- 持久服务：`occhan-root-row-delivery`；启动 PID：`77154`。
- 进程命令仅为 `/Users/zvf003/ZStack/oc-chan/release/mac-arm64/OC Chan.app/Contents/MacOS/OC Chan`，未带调试或验收参数；启动时移除了工具环境的 `NODE_OPTIONS`。
- AppKit 核对：bundle 路径正确，`finishedLaunching=true`、`hidden=false`。CoreGraphics 找到主窗口 8179，但它没有出现在 on-screen 列表；激活指定 PID 后仍如此。Dock 定位也未得到唯一同名图标，因此不能宣称主窗口正在当前桌面可见。应用进程已启动，不应把这个显示限制误报为打包或布局失败。
- 未安装到 Applications，未 commit/push，未签名、公证、发布或部署。

## 用户限制与下一步

中文沟通；保留其他未提交工作；只显示真实采集数据，不用临时假 Agent 填充生产画布。不改全局 OMP、模型、聊天日志或技能；没有新的安装、发布或部署授权。

1. 后续若继续布局，保留根节点同排、父上子下和真实 parentId 建边，不恢复网格或按分支换行。
2. 若处理 200% 文字，统一节点实际高度、文本行高和 Dagre 尺寸契约，再在真实应用中检查，不能只放大字体或只调画布坐标。
3. 若补最终原生尺寸矩阵，先让应用出现在当前 macOS 桌面并确认实际窗口/PID可访问，再操作该窗口；不要循环猜同名进程或把模拟 viewport 当成原生窗口。
4. 只有新增授权时再进行提交、推送、安装或分发。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan` 的 `fix/tern-native-navigation`。根节点现在沿 X 轴同排，Dagre TB 向下展开，连接点为 bottom→top，最小缩放 5%。10 项定向测试和最终打包通过，真实快照 19 个根节点已完整进入全览。先读本交接的已知限制和正常运行实例，不重复已通过且仍适用的检查。200% 文字有既有卡片行高重叠问题，最终原生尺寸矩阵未完整补验；不要将其描述为全部 UI 无障碍或 SOTA 验收通过。保留用户和并行任务的其他修改。
