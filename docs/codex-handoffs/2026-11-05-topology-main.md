# 拓扑项目配色与分组：main 提交交接

## 目标与范围

- Repo：`/Users/zvf003/ZStack/oc-chan`。
- 隔离工作树：`/Users/zvf003/tmp/oc-chan-topology-project-groups-main`。
- 分支：`feat/topology-project-groups-20261105`，基于 `origin/main` 的 `45f6b5e63da17aa7fa01793eac7573586e5c53e6`。
- 用户要求：同项目拓扑块同色，活跃状态不靠颜色区分；同项目主 Agent 相邻并列，并有稳定归类顺序。随后授权提交到 GitHub `main`。
- 本记录随代码提交生成；最终推送 SHA/回执记录在原工作树的 `docs/codex-handoffs/2026-11-05-topology-project-colors.md`。

## 已完成

- 按完整工作目录（忽略末尾斜杠）确定项目色；未知目录使用中性色。工作中、空闲、运行中、未知使用不同图形并保留文字。选中外框、上下文虚线和状态更新都不覆盖项目底色；活动连线仅加粗。
- 真实关系分支按根节点的项目目录升序、稳定 ID 排序；未知项目最后。同项目并列，项目之间增加间距；跨项目子代理保留真实父子关系和自身项目色。首次聚焦首个项目组。
- 布局 key 包含归一化目录，目录变更会重排；状态、指标及输入顺序不重排；手动位置仍优先，重新布局恢复分组。
- 修改 `AgentTopology.tsx`、`AgentsView.tsx`、`agent-topology.css`、`agent-topology.ts`、`agent-topology.test.ts`；同步 `README.md` 和 `DESIGN.md`。
- 原工作区存在大量其它任务的未提交改动。因此从 main 单独移植本次行为，未带入另一个任务尚未提交的分页、动态节点尺寸、跨页视图记忆等实现，也未修改原工作区源码。

## 已运行验证

- `npm ci --no-audit --no-fund`：完成独立依赖安装。
- 两项新增分组回归先在旧 main 失败：原布局按分支大小排序且目录变更未使布局失效。
- `node --import tsx --test src/renderer/src/agent-topology.test.ts`：16 项通过，0 失败。
- `npm run build:app`：TypeScript 检查与主进程、preload、renderer 构建均通过。没有运行全仓测试，也未打安装包。
- `npm run dev -- --inspect`：真实独立无头 Electron，确认不可见、不可聚焦。7 节点临时样本通过真实主进程 IPC 到渲染端，验证同项目同色、项目分组、不同状态切换不改变颜色或坐标、父子关系、拖动保留及重新布局、上下文和选中保留项目色、浅/深模式、880×640 与 1280×860 CSS 视口无整页或分组提示横向溢出。渲染错误为空。
- 同一实例、同一 7 节点样本、16 次重新布局：renderer TaskDuration 总增量前/后 115.263/107.184ms，应用进程 CPU 累计增量 0.330576/0.266763s，端点工作集合计 588208/565104KiB。前样本首次操作包含预热；开发模式、HMR 与 GC 会影响总量，不能宣称性能提升或长期内存稳定性。
- 证据在原工作树 `.impeccable/review/topology-main-2026-11-05/`，包含 `verification.json`、浅/深截图及 `cleanup.json`。

## 限制与约束

- 默认中文，保留其它任务改动，不全量暂存、不重置或清理用户工作树。
- 仅提交并推送 GitHub main；安装、发布、部署不包含在本次授权内。本机 `pre-push` 只负责替换安装并启动应用，因此使用单次 `-c core.hooksPath=/dev/null` 推送，不改 hook 或持久配置，不替换正式应用。
- 未验收正式安装包、可见原生窗口/分屏/全屏、120Hz 动画或长时间压力。无头 smoke 不替代这些证据。
- 项目身份依赖来源提供的完整工作目录；不自动将不同子目录或 worktree 合并为一个 Git 项目。颜色可能重复，不是唯一身份标识。

## 后续动作与恢复提示

1. 如需核对交付，读取原工作树上述交接末尾的推送 SHA，并与 GitHub `refs/heads/main` 对照。
2. 后续合并原工作区改动时保留本次项目色与分组规则，针对分页版本处理已有同名 helper，避免重复移植。
3. 如用户要求更新正式应用，按新授权执行安装；当前阶段没有安装或部署。

恢复提示：本轮拓扑项目配色、非颜色状态标记、项目排序已在独立 main 工作树通过 16 项定向测试、应用构建和真实无头 Electron smoke。不要重复已通过检查，不要停止其它实例，不要清理工作树。先读原工作树 `2026-11-05-topology-project-colors.md` 最新交付记录，再按新的用户请求继续。
