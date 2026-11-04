# Agent 连续流动与会话事件订阅交接

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`feat/agent-live-flow`（实际读取 `.git/HEAD` 确认）
- 当前目标：父子连线连续流动，消除三秒整批刷新感；保留真实数据、交互位置与已有统计边界。
- 前置交接：`2026-11-02-agent-topology-canvas.md`、`2026-11-02-desktop-monitor.md`。其中旧进程/PID不是当前交付状态。

## 已完成

- `LiveAgents` 通过 `fs.watch` 订阅当前归属的 OMP 会话文件。90ms 固定窗口合并，每文件独立增量读取，不在文件回调中运行 ps/lsof/Tern。
- 进程、资源、归属每 2 秒独立发现；系统每 2 秒、调度每 30 秒采样。发现单飞；慢文件不阻塞其他文件，读取期间新增事件保留到下一轮。
- 文件替换和 watch/read 错误明确显示；正常发现重新挂接 watcher，没有轮询兜底。stop 关闭订阅并阻止所有尾部发布。
- IPC 切换为 `MonitorUpdate` 分区更新。忽略仅采样时间变化的重复更新；自动采集不切换 loading。前端先订阅再取初始快照，防止较旧快照覆盖已收到的分区事件；Agent 页面 memo 化，保持未变分区引用。
- SVG 实线保留关系，圆头粒子沿父 → 子方向连续移动，1.3s 线性循环。状态变化只改变强调色，不重启动画，不使用 RAF 驱动 React 状态。
- 暂停显示、窗口隐藏、离屏与减少动态效果路径控制动画；工作状态和近期调用仍有静态文字。调用提示使用 6 秒窗口，不把文件持有、粒子运动或近期调用冒充正在执行。
- README 已更新订阅机制、动画语义、隐私与来源边界、模块和验证入口。package.json 的 test 入口已包含 `src/main/*.test.ts`。
- 最终源码已构建和打包；用户可见的普通启动实例已打开，未携带调试端口。

## 调查或修改文件

- `src/main/live-agents.ts`、`src/main/live-agents.test.ts`：文件订阅与并发/错误/退出行为。
- `src/main/monitor.ts`、`src/main/monitor.test.ts`：分区更新、去重、自动与手动刷新。
- `src/main/collectors/agents.ts`：拆分 `discoverAgents()` 与一次性 `collectAgents()`，复用归属判断。
- `src/main/collectors/agent-activity.ts`、`src/main/collectors/agents.test.ts`：结构化调用元数据读取及边界。
- `src/shared/types.ts`、`src/preload/index.ts`、`src/main/index.ts`：共享契约和 IPC 消费方。
- `src/renderer/src/App.tsx`、`AgentsView.tsx`、`AgentTopology.tsx`、`components.tsx`、`agent-topology.css`：分区订阅、稳定视图、流动连线和动效可见性。
- `package.json`、`README.md`。
- 本轮截图：`.impeccable/review/flow-desktop.png`、`flow-frame.png`、`flow-narrow.png`；仅为当时真实状态，图中的已完成子代理随后退出。

## 实际验证结果

- `node --import tsx --test src/main/live-agents.test.ts src/main/monitor.test.ts src/main/collectors/agents.test.ts src/renderer/src/agent-topology.test.ts`：45/45 通过。覆盖真实文件追加、连续写入的最终事件、读取中再次写入、慢文件隔离、新发现结果合并、stop、watch/read 错误、inode 替换后重新挂接、分区去重及拓扑边界。
- `npm run build`：TypeScript 检查与 main/preload/renderer 构建通过。之后没有修改应用源码。
- `node_modules/.bin/electron-builder --mac --dir --publish never`：成功打包 `release/mac-arm64/OC Chan.app`。未签名/公证，未上传发布。
- 临时脚本运行真实 `Monitor` 12 秒：Agent 更新 15 次，其中 8 次发生在相同进程采样时间内；系统更新 7 次、调度更新 2 次。观察到 17 个 Agent、3 条关系、16/16 个当前归属 OMP 会话已监听。3 次调用首次送达距事件时间分别 409、90、90ms；这些是当次观测，不是延迟保证。临时脚本已删除。
- 真实 app.asar 页面 CDP 验收：原生窗口获得焦点后 visibility=visible，流动动画 running。801.4ms 内观察到 1 次 Agent IPC 更新，连线 DOM、动画实例和 viewport 均保持不变，dash offset 从 -24.0116px 变为 -14.0396px。
- 暂停显示后动画阶段在 350ms 观察窗口内变化 0；恢复操作已成功，实时显示状态恢复。第二次尝试量化恢复阶段时，真实子代理已退出，图中无边；未将该次无边检查计为连续阶段验证。
- 减少动态效果为 true 时，连线保留静态形式，offset 在 250ms 内保持 0px；恢复 no-preference 后动画 running。
- 880×640 渲染视口：document scrollWidth=880，无页面水平溢出；画布保持既有缩放，节点可通过平移或“适应全部”查看。1280×860 和窄窗口截图已实际查看。
- CDP 接管期间渲染器 errors=[]。工具与真实用户都可操作原生窗口，一次检查期间页面切换到定时任务；后续按当前页面重新定位。
- 未运行全仓测试；本轮没有重跑未变的调度、系统采集测试。

## 自动化限制

- CDP 接管本身不保证 Electron 窗口可见或有焦点；跨工具调用时窗口可能 hidden，产品会按设计暂停动画。验证在同一次 browser.run 内通过 AppKit 激活实际窗口，再读取动画状态，不改写 document.hidden。
- 当前工具的 page.evaluate 无法读取 Electron contextBridge 的 `window.monitor`；使用原生 CDP `Runtime.evaluate` 的主世界读取成功。已向工具 QA 报告，不在产品中加入兼容逻辑。
- 减少动态效果的共享 CSS 会移除动画实例，不能用 `getAnimations()[0]` 判断其运动；实际验收用静态 offset 和恢复后的 running 状态。

## 当前交付与风险

- 最终应用：`/Users/zvf003/ZStack/oc-chan/release/mac-arm64/OC Chan.app`。
- 持久服务：`oc-chan-live-delivery`，启动时 PID `30902`，命令移除工具注入的 `NODE_OPTIONS`，未传调试端口。AppKit/CoreGraphics 实际确认 finishedLaunching=true、visibleWindows=1。
- 验收实例 `oc-chan-flow-verification`（PID 18955）已正常退出，CDP 句柄已释放。
- 未 commit/push、未安装到 Applications、未签名、公证、发布或部署。
- 精确正在执行的 OMP 子代理总数仍缺少上游可读生命周期接口。保持 unknown/`—`，不能拿驻留或近期调用推算。
- 来源可显示 partial：128KiB 读取窗口之前的记录未读取，部分运行时没有支持的会话调用来源。长推理尚未落盘时不会持续高亮。错误不吞掉，不用轮询掩盖监听失败。

## 用户偏好与限制

中文沟通；本机只读 desktop。保留无关未提交改动。不改 OMP 全局配置、模型、技能、聊天文件或其他会话；不执行定时任务，不外发消息。需要提交、推送、安装或发布时分别取得对应授权。连续流动只表达关系方向，状态含义保持真实。

## 后续具体动作

1. 新任务先核对运行服务与现有改动，不能沿用本交接的 PID 作为永久事实。
2. 修改订阅逻辑时运行 live-agents/monitor 定向测试并实际追加临时文件，重点验证慢读、替换和停止竞态。
3. 修改连线时验收真实 Electron 窗口，证明可见时运动、隐藏/暂停时停止、普通数据更新不重置阶段。
4. 若需要精确活动子代理数，先取得 OMP 正式生命周期接口，再覆盖创建、执行、完成、取消与退出，禁止用日志持有或 CPU 猜测。
5. 只有取得新授权后才提交/推送、安装到 Applications 或处理分发签名。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan` 的 `feat/agent-live-flow`。本轮已完成会话事件订阅、分区 IPC 更新和连续流动连线，并完成45项定向测试、构建、打包、真实原生窗口验收。先读本交接及README，核对当前服务与现场文件，不重复已通过且仍适用的检查。保留只读与unknown统计边界，不改OMP全局设置。当前普通启动应用已留给用户，不带调试端口；新任务需要验收时仅操作已确认归属本任务的应用实例。
