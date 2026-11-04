# OC Chan 自动更新与调用态验收交接

- Repo：`/Users/zvf003/ZStack/oc-chan`
- 当前 branch：`feat/agent-live-flow`（现场读取 `.git/HEAD`）。
- 本轮目标：默认自动更新主／子 Agent 状态，提供调用态节点与父子连线反馈，完成真实桌面验收。
- 前序基础和拓扑说明：`2026-11-02-desktop-monitor.md`、`2026-11-02-agent-topology-canvas.md`。

## 已完成

- 本轮首先接入默认采样反馈、工作态与近期调用显示、六秒调用窗口、全 Tern 窗口状态读取，以及暂停／隐藏／减少动态效果下的停动。
- 近期调用仅输出种类、名称、时间。会话读取有容量上限、增量缓存、半行处理和错误报告；完成、取消、错误及过期清除，保持未知状态与活动总数未知的边界。
- 修正采样时钟竞争：不在 `enrichSessionActivity` 入口固定当前时间；`SessionActivityReader` 在异步读取完成后取得默认时间，避免刚写入的合法调用被当作未来记录永久丢弃。真实临时文件回归覆盖首次读取与随后未变化文件。
- 修正暂停跨页：App 统一保存 `pausedAt`，各页面按相同时间投影调用证据，替代组件局部缓存。旧实现已在原生窗口复现，修复后旧版与当前事件订阅版都验证通过。
- README 补充暂停跨页保证及多窗口关联，保留并行会话新写入的事件订阅、粒子连线等说明。

## 并行变化与证据范围

验收期间发现另一个本机会话正在推进同一仓库。它将 Agent 更新改为会话文件事件订阅、按分区 IPC 更新，并把连线改为持续向父→子方向流动的粒子。本轮保留这些变化，没有恢复旧的三秒 Agent 轮询。当前源码 `monitor.ts` 与 `types.ts` 显示：Agent 进程／资源／归属每 2 秒发现，系统 2 秒、调度 30 秒；近期调用窗口仍为 6 秒。

并行会话以 PID 18955、调试端口 9469 运行同一路径的应用（当时快照，不能当作未来固定 PID）。本轮旧验收实例正常退出，后续新实例因 Electron 单实例锁立即退出。没有停止那个实例；最后改用本轮创建的独立临时 userData，通过 Electron 加载当前 `out/main/index.js` 验收。该实例、CDP 接管与临时入口／profile 均已清理。

## 涉及文件

- `src/main/collectors/agent-activity.ts`：结构化调用解析、增量读取、时钟修复。
- `src/main/collectors/agents.ts`、`agents.test.ts`：全窗口采样、会话调用关联与行为测试。
- `src/shared/types.ts`：调用元数据与共享时间窗口；当前间隔定义包含并行会话改动。
- `src/renderer/src/App.tsx`、`components.tsx`、`AgentsView.tsx`：自动更新反馈、统一暂停时间与调用显示。
- `src/renderer/src/AgentTopology.tsx`、`agent-topology.css`、`styles.css`：节点／连线状态与动效控制；当前粒子实现包含并行会话改动。
- 已读取当前 `src/main/monitor.ts`，确认它已由并行会话改为 `LiveAgents` 与按分区事件更新；不是本轮独立完成的最终实现。
- `README.md` 与本交接。

## 实际运行的检查

- `node --import tsx --test src/main/collectors/agents.test.ts src/renderer/src/agent-topology.test.ts`：最初 35/35 通过。
- 构建最初发现测试中 `assert.equal` 导致 TypeScript 保留过时类型收窄；改为按 sessionId 重新取得对象后，单项回归通过。
- 时钟竞争回归加入后，`node --import tsx --test src/main/collectors/agents.test.ts`：26/26 通过。之前的 10 项拓扑投影测试仍是独立通过记录，没有重复运行。
- `npm run build`：类型检查及 main/preload/renderer 构建通过。
- `node_modules/.bin/electron-builder --mac --dir --publish never`：arm64 应用包生成成功，未签名／公证。
- 上述构建和打包记录属于并行事件订阅切换前的本轮修复。不能把它们宣称为对后来所有并行改动的完整构建验证；后来当前产物的实际原生 smoke 见下一节。
- 未运行全仓测试。未提交、推送、安装到 Applications、发布或部署。

## 原生窗口与当前产物验收

前段实际运行 `release/mac-arm64/OC Chan.app` 的 ASAR renderer：

- 连续收到约三秒一次的 Agent 样本，无需点击刷新。
- 工作态标记的 transform 在相隔 300ms 的读取中实际变化。
- 暂停后界面时间保持，后台快照时间继续推进；等待超过六秒并切换页面后调用文字保持，恢复后显示新数据。

后段运行当前 `out/main/index.js`／`out/renderer/index.html` 的独立原生 Electron 窗口：

- 界面明确显示“会话事件订阅”；使用当前 `MonitorUpdate` 分区协议观察。
- 真实 `ActivityEvidenceReview` 子代理执行一次 `bash sleep 9`，页面捕获 `kind=tool/name=bash`，子节点与关系增强出现。调用证据随后清除；全过程子节点 `state=unknown`，`activeSubagentCount=null`。
- 当前粒子路径是 `.topology-flow`，不是背景 `.react-flow__edge-path`。相隔 350ms 的 `stroke-dashoffset` 从 `-24.7308px` 变为 `-5.7288px`，证明连续流动。
- 原生 pointer 拖动主节点后位置为 `translate(30px, 20px)`；跨两次 Agent 自动更新仍保持，视口同样保持 `translate(206.5px, 178px) scale(1)`。
- 当前粒子在 reduced-motion 下 `animation-name=none`；原生窗口被遮挡时全局 motion 与路径 playState 都为 paused。
- 当前事件订阅版再次验证暂停超过六秒、跨页后 `aria-pressed=true` 且同一调用文字保留。
- 最终截图：`.impeccable/review/agent-activity-verified-20261102.png`。真实子代理调用时截图还存在本轮工具输出中；最终 PNG 用于留存渲染状态，不替代上述动态读取证据。

自动化限制：本机 Electron 默认执行上下文会在窗口遮挡时报告 hidden，即使截图和 DOM 可读取。验证可见分支时使用 CDP `Emulation.setFocusEmulationEnabled`；关闭该设置验证原生 hidden 分支。未改产品代码来绕过可见性，接管已释放。

## 限制与保留事项

- 精确活动子代理数量仍缺 OMP 上游可读生命周期接口，不能用驻留、历史或近期调用数量代替。
- 六秒窗口表示近期落盘证据，不能证明长调用持续在执行；方向粒子本身也不能证明活动。
- 自动采样期间如果某个节点退出／park，会从实际数据中消失；不能把查不到原节点当作位置保持失败。手动位置仅在当前页面实例内保留。
- 并行会话仍可能继续变更源码、产物和 README。已有测试与截图按本文件的具体阶段理解，后续交接不能混用。
- 中文沟通；不改 OMP 全局配置、模型、聊天／会话日志、技能或其他会话。保护用户及并行改动，不全量暂存、重置或清理。

## 下一步

1. 新线程先读本交接、README 及并行会话的后续交接，核对最新源码和应用实例归属。
2. 若再改采集或暂停语义，运行对应定向测试，并用独立临时 profile 做原生验收，避免停止其他会话的应用。
3. 若验收打包产物，先确认对应源码版本；前段 `.app` 记录与后段当前 `out/` 记录不能互相替代。
4. 精确活动计数需求须先取得上游生命周期接口；安装、签名、公证、发布仍需对应授权。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan`，当前记录分支 `feat/agent-live-flow`。本轮自动更新／调用态和两项边界修复已有定向测试及原生验收；并行会话已升级成事件订阅和粒子连线，必须保留。先读本文件的阶段证据和并行变化，不恢复旧轮询，不把 unknown/null 误改成精确活动统计。不要停止其他会话的应用；本轮临时实例和 profile 已清理。后续只按实际新改动补充验证。
