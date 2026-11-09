# 项目建筑、任务楼层与 Agent 办公区域

- repo：`/Users/zixiaobowen/myProjects/oc-chan`
- 实现分支：`feat/task-office-topology-20261109`
- 集成工作区：`/Users/zixiaobowen/myProjects/oc-chan-task-office-main-20261109`，分支 `integrate/task-office-topology-20261109`
- 目标：一个项目一栋楼、一个主会话协作任务一层；主 Agent 独立办公室，子 Agent 坐共享长桌。用户随后授权 commit 并 push 到 GitHub main；未要求远端部署。

## 已完成

按根 Agent 完整 cwd（去尾斜杠）分建筑，按真实父子连通分支分任务楼层；不猜 Git 根或业务 taskId。跨 cwd 子代理随主任务，缺父／循环／非 main 根明确待归属，不虚构主 Agent。多建筑各有屋顶与入口，独立玻璃办公室、连续长桌与坐姿员工均采用共享几何和有界实例化网格。

员工局部位置相对办公室中心保存；项目重新排布不改变手动工位。主 Agent 拖动限制在办公室、子 Agent 限制在开放区域。任务菜单按项目分组，员工标签优先于楼层／建筑标牌，保留详情、筛选、2D/3D 切换、右键 Tern 入口及镜头恢复。

## 相关文件

- `src/renderer/src/agent-topology-3d-layout.ts`、对应 `.test.ts`：建筑／任务分组、真实关系边界、预算。
- `agent-topology-scene.ts`：多建筑实例、坐标转换、拖动、标牌、资源释放。
- `agent-office-building.ts`、`agent-office-employee.ts`：玻璃办公室、共享长桌、坐姿。
- `AgentTopology3D.tsx`、`agent-topology-3d.css`：项目／任务菜单与响应式。
- `scripts/smoke/topology-scenarios.mjs`：真实 IPC 的选层／角色／切换／筛选／焦点验收。
- `AGENTS.md`、`DESIGN.md`、README 和 main 的 `docs/development.md` 已更新 3D 描述；原工作区未跟踪的 `docs/features.md` 也同步了产品描述，但该文档整体属于并行 README 重整，不纳入本任务提交。
- `docs/images/agent-project-buildings.png`、`agent-task-floor.png`：真实产品场景渲染，24 个合成 Agent／2 项目／4 任务。
- 本目录同名 HTML、`.src.html`、`-evidence.json`：视觉回执和测量数据。

## 实际验证

- `npm run typecheck`：通过；在独立集成工作区合入 main 的 Kubai 图标等改动后再执行，通过。
- `node --import tsx --test src/renderer/src/agent-topology-3d-layout.test.ts src/renderer/src/agent-topology.test.ts src/renderer/src/view-state.test.ts`：实现分支与集成工作区均为 41/41 通过；未运行全仓测试。
- `npm run smoke:renderer -- --scenario topology`：旧版基线通过；首轮新版失败（标牌挤掉选中员工标签），调整为员工标签优先后重跑通过。通过证据：`/tmp/oc-chan-project-offices-after-focus-20261109/result.json`。真实 IPC fixture 全部 cwd 未知；已知项目多楼由直接运行生产 TopologyScene 的合成场景覆盖。
- 基于远端 main `1a3493a545168f160bfe9c48808e2214dd2710ba` 无冲突集成实现提交 `9538163` 后，`npm run smoke:renderer -- --scenario topology --out /tmp/oc-chan-project-offices-main-20261109` 通过（37.05 秒）。该复验覆盖主线新图标依赖和自动合并后的真实界面。
- 真实无头 Electron：CSS 内容区 880×640、960×760、1280×860、1728×1080，200% 字体，11 个连续宽度；无横向溢出，任务选择保留。真实指针拖动验证主／子区域边界；筛选保留手动工位；隐藏停止绘制、恢复继续；视角重建浮点误差约 `1.14e-13`。
- 同机同负载 1200 Agent／4 项目／8 任务：布局更新中位数旧 1.2 ms、新 1.7 ms；新增办公室和楼体增加 2 次 draw call。仅短测，不宣称性能提升。
- 1200 建筑、1200 员工／节点边预算、30 次场景重建均通过；DOM 与 GPU 几何释放。重建采样 Electron 进程集合峰值约 795.5 MiB。
- 20 秒持续刷新浏览器 RPC 在 40 秒超时，随后现场确认已完成（94 个节点发生 working 更新）、场景已 dispose、GPU 几何和 DOM 均为零；精确耗时与更新总数未返回。回执超时不计作成功 RPC，也不掩盖它。记录见 `-evidence.json`。
- 本任务开发实例 `instance-Gc9OtV` 的 owner 与 PID 38943 的启动时间／cwd 已核对。停止后 `.dev-instances` 为空，38943/39025/39027/39028/39038 均已退出；标准 smoke 两个实例与 fixture 目录也已清理。

## 限制与保留项

没有可见 macOS 窗口、真实全屏／分屏、VoiceOver、原生 Tern 激活、物理显示器帧率或 24 小时常驻验收。内存为 Electron 报告的 Browser/GPU/Utility/Tab 集合采样，未覆盖启动器、编译器和短命采集子进程，不能称为完整进程树峰值。未新增运行时依赖。

开始时已有 README 大幅重整、`docs/architecture.md`／features／development／distribution、旧 handoff、图片和 `scripts/local-delivery.mjs` 改动；必须保留，不能全量暂存。本任务只提交明确归属文件。在干净集成工作区更新 main 自身 README 的 3D 描述，避免把并行文档重构夹带进去。

实现提交为 `9538163`。现场 `core.hooksPath` 未设置，默认 `.git/hooks` 只有 sample 文件，没有生效的 pre-push。因此本次沿用现有配置推送，不启用安装钩子、不替换 `/Applications/OC Chan.app`。本地真实 Electron smoke 不代表正式安装包已更新。

Tern 显示另一会话正在处理 main 推送／本机安装。为保持其主线工作区和 Git 索引不受影响，从集成提交建立独立克隆 `/Users/zixiaobowen/myProjects/oc-chan-task-office-delivery-20261109`，在该克隆的 main 执行推送。原仓库分支、worktree、未提交改动均保留；本任务开发实例已清理。

## 交付动作

1. 提交本任务代码、布局测试、相关规范和新截图／回执；保留并行改动。
2. 在独立集成工作区合入最新远端 main，处理相关冲突；仅在代码交互变化时补定向验证。
3. 从已验证的集成提交建立上述独立交付克隆，在其 main 通过 `npm run push:main` 推送，核对 GitHub main 的实际 SHA。若远端变化，先合并远端新提交，按实际影响补验证，禁止强推。
4. 记录推送与本任务清理回执；不删除任何源码 worktree 或分支，不启用安装钩子、不执行远端部署。

恢复提示：继续 OC Chan 项目建筑与任务办公室改版交付。先读取本交接和同名 evidence.json，核对当前 main／origin/main 和本任务分支，保留列出的并行改动。已有 41 个定向测试、类型检查及真实 topology smoke 通过；不要重跑全仓。用户已授权本任务 commit 并 push GitHub main。使用干净集成工作区完成提交／合并／push:main，并核对远端实际 SHA，不能把旧回执当成新版本成功。
