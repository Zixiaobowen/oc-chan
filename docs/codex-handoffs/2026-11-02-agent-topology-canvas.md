# OC Chan Agent 拓扑画布交接

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`feat/agent-topology-canvas`
- 目标：将 Agent 与子代理页改为可交互拓扑画布，保留真实本机只读数据与现有桌面界面。
- 前一阶段基础监控交接：`docs/codex-handoffs/2026-11-02-desktop-monitor.md`。其中服务/PID属于前一阶段，不是当前运行状态。

## 已完成

- 使用 `@xyflow/react` 承担缩放、平移、拖动和键盘节点交互，`@dagrejs/dagre` 排列父子分支。仅真实 `parentId` 建边，相同 PID 不自动建立关系。
- 搜索名称/运行时/目录/模型/PID，主/子代理筛选；保留匹配节点祖先和后代作为关联上下文。缺失父节点、未知关系和环明确提示，不生成虚构 Agent。
- 分支收起/展开，筛选期间展开命中分支，清除后恢复折叠。首次聚焦一个真实关系分支，“适应全部”查看整个图。
- 手动拖动位置与视口跨采样保持，“重新布局”显式清除手动位置。收起/展开保留父节点原位。
- 点击或 Enter/空格打开详情；宽窗口右侧、窄窗口下方，关闭返回原节点焦点。打开详情/画布尺寸变化只按需平移选中节点，保留 zoom 和 16px 边距，不因普通采样平移。
- 概览保留简短 Agent 表格；Agent 专页改用拓扑。README 和 PRODUCT 已记录交互与真实数据限制。
- 最终源码已构建并打包为 `release/mac-arm64/OC Chan.app`。独立复核与无调试端口交付实例状态见本文后续回执。

## 主要文件

- `src/renderer/src/agent-topology.ts`：投影、上下文、折叠、关系警告、布局和结构键。
- `src/renderer/src/agent-topology.test.ts`：10个行为测试。
- `src/renderer/src/AgentTopology.tsx`：React Flow节点、控件、位置保留、局部选中节点避让。
- `src/renderer/src/agent-topology.css`：拓扑节点与画布样式。
- `src/renderer/src/AgentsView.tsx`：筛选、画布与详情布局。
- `src/renderer/src/styles.css`：拓扑容器和960px以下详情重排；其他共享样式保留。
- `package.json` / `package-lock.json`：React Flow、Dagre依赖与拓扑测试命令。
- `README.md`、`PRODUCT.md`、`.impeccable/surfaces/src-renderer-src-agentsview-tsx.md`。
- `.impeccable/review/topology-{desktop,detail,empty,narrow,narrow-detail}.png`：最终bundle真实截图，未纳入版本控制。

## 本轮实际验证

- `npm run build`：类型检查及 main/preload/renderer 构建通过。之后未修改应用源码。
- `node --import tsx --test src/renderer/src/agent-topology.test.ts`：10/10通过，覆盖真实parentId、多级边、搜索上下文、未知父关系、折叠与筛选、状态变化不改结构、环及不重叠布局。
- `node_modules/.bin/electron-builder --mac --dir --publish never`：成功生成 arm64 app，未签名/公证。
- 实际bundle URL为 `OC Chan.app/Contents/Resources/app.asar/out/renderer/index.html`；不是开发服务器或浏览器demo。
- 父子关系：真实14节点/1边，收起后13节点/0边且父位置不变；展开恢复。已完成的子代理退出采集后，刷新删除对应节点和边，剩余13节点。
- 缩放按钮100→120→100%；滚轮100→72%；空白拖动平移和实际节点拖动通过。
- 主节点手动位置 `translate(667px, 686px)` 与视口 `translate(-247.5px, -458px) scale(1)` 跨真实采样时间推进保持；重新布局恢复 `translate(0px, 0px)`。
- 选中子节点打开右侧详情：zoom仍为100%，节点完整处于缩窄后的画布内；关闭返回原节点焦点。
- 搜索无结果保留画布但隐藏控件，提供清除筛选且恢复成功；880×640无页面水平溢出，详情置于画布下方并获得焦点。
- 先前同一源码界面检查已覆盖搜索保留父链/子节点、筛选期间折叠按钮禁用、Enter打开详情；最后一轮renderer errors=[]。
- 设计探测实际返回已有共享样式与拓扑的颜色/字号/圆角advisory，以及共享样式SF Mono未在DESIGN frontmatter声明的warning；不宣称探测零问题。DESIGN正文明确进程指标采用等宽字。本轮是既有界面的扩展，未借机重写全局设计系统。
- 未运行全仓测试；采集器未在本轮变更，前一交接中的相应验证继续适用。

## 自动化限制与已解决的验收问题

Electron窗口被系统视为hidden/遮挡时，`mouse.wheel` 和分步pointer移动会等不到compositor回执；普通读DOM和截图可用。已向工具QA报告。强制截图产生paint后，实际wheel与pointer拖动成功；最终主节点刷新保留检查还使用真实renderer的MouseEvent路径。未修改产品代码或用吞错/兜底掩盖行为。

一次刷新断言失败由目标子代理自然退出引起，节点已不在最新采样；改用仍存活的主节点后验证通过。此事实不能被解释为“已完成子代理还在运行”。

## 已知产品边界

精确正在执行的OMP子代理总数仍缺上游可读生命周期接口。持有session/lease只能证明驻留，不证明执行中；UI保留unknown/`—`。本轮完成的是拓扑扩展，不宣称解决原始产品的精确活动计数缺口。

模型字段来自初始会话头部，其他profile、自定义session目录、其他用户crontab、容器/任意第三方调度不在现有覆盖内。此处沿用原始采集边界。

位置仅保存在当前页面实例，不写配置；导航离开再进入会重新布局。截图中的数字均为当时真实快照。

## 用户偏好与限制

中文沟通；desktop形态；仅真实本机只读观察。不改全局模型/OMP配置、技能、聊天日志或其他会话。不得把驻留数冒充活动数。不执行定时任务，不发送消息。不自动commit/push、安装到Applications、签名、公证、发布或部署。无关未提交修改保留。

## 后续具体动作

1. 新需求开始时先读本文件与README，核对当前应用服务，不重复已通过且仍适用的检查。
2. 若改拓扑，针对实际受影响行为运行本测试文件并验收真实bundle；重新打包前只停止本任务应用实例。
3. 若继续精确活动子代理统计，先取得上游正式registry/生命周期接口，再验证创建、执行、完成、取消、park和退出；不得用历史文件或CPU猜测。
4. 只有新授权需要安装或分发时再处理Applications、签名、公证与发布。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan` 的 `feat/agent-topology-canvas`。Agent专页已替换为只读交互拓扑，React Flow+Dagre；概览仍是表格。先读本交接末尾最终回执和README。不要重做设计或重复检查。继续保留活动子代理未知边界、用户未提交改动和其他会话。任何后续改动须验收真实Electron路径，不能只凭typecheck或截图推断交互成功。

## 最终应用回执

- 最终源码构建后完成打包，调试实例 `oc-chan-topology-final` 与其CDP句柄已关闭。
- 交付实例：持久服务 `oc-chan-canvas-delivery`，PID `88007`，启动时移除工具注入的 `NODE_OPTIONS`，没有传入调试端口。
- AppKit/CoreGraphics实际核对：bundle绝对路径为 `/Users/zvf003/ZStack/oc-chan/release/mac-arm64/OC Chan.app`，`finishedLaunching=true`，`visibleWindows=1`。
- 未commit/push、未安装到Applications、未签名/公证、未发布或部署。用户可直接使用当前打开的本地应用包。
- 独立 `TopologyFinish` reviewer 返回 `disposition: ship`：五张最终截图有效，当前拓扑扩展范围内无实质阻断项。当前运行时没有impeccable专用评审角色，使用独立reviewer按相同finish-review合约替代；未继承旧应用评审结论。
- reviewer结论覆盖截图与源码，动态交互由主代理上述真实bundle操作回执支持。设计系统的既有frontmatter声明差异已披露并保留，精确活动子代理统计缺口仍未解决。
