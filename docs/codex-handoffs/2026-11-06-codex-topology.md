# Codex 协作拓扑 · 2026-11-06

## 目标与现场

- Repo：`/Users/zvf003/ZStack/oc-chan`。
- Branch：`main`；原完整工作区提交分支为 `fix/oc-chan-r04-admin-sampler-20261106`。
- 用户目标：协作拓扑在 OMP 之外，也显示 Codex 的主代理、子代理与父子连线。
- 已完成代码接入和真实无头 Electron 验收。用户随后要求 commit / push，并在提交范围选择中明确选择「完整当前工作区」；206个改动文件已提交为 `f69cfc256c429b9f9be3b21770e8cad9d1d091c9`。用户进一步明确要求提交到 GitHub `main`，本次按此目标合并两边历史。
- 工作区开始时的大量未提交改动属于此前任务。此次授权纳入完整当前版本，但不授权重置、清理、安装、发布或部署；R-04管理员采样器的长期验收仍未完成。

## 完成行为

- 从存活 Codex CLI / app-server 进程当前持有的可写 rollout 描述符读取首条 `session_meta`。不扫描历史目录，不解析会话对话正文。
- 线程 ID 作为稳定节点标识，`source.subagent.thread_spawn.parent_thread_id` 连接同进程、独立进程及多级子代理。普通 `forked_from_id` 不生成协作关系。父会话未采到时保留缺失说明，不伪造父节点。
- 支持标准 `sessions/YYYY/MM/DD/rollout-…jsonl`、自定义 CODEX_HOME 和 rollout ID 后缀。昵称、工作目录、开始时间进入现有详情。桌面后台服务未持有会话时不作为独立 Agent。
- 关闭描述符或进程退出后，下一轮采样移除对应会话。驻留会话不证明工作状态；桌面会话与子代理保持未知。共享 PID 不重复累加资源。
- OMP / Codex 每轮合计最多 128 个会话头部，Codex 单头部最多 1 MiB，复用全局有界文件与队列预算；格式损坏、归属歧义和超限显式标记为读取不完整。
- 添加中英文 Codex 来源说明与能力限制，详情可定位到该来源行；外部 Codex 窗口跳转未集成。
- CI 的 agents 套件包含 Codex 回归，新增 collector 变更映射到 agents/plugins/monitor/tern 的定向检查。

## 涉及文件

主要实现与验证入口：

- `src/main/collectors/codex-sessions.ts`、`src/main/collectors/codex-sessions.test.ts`
- `src/main/collectors/agents.ts`、`src/main/collectors/agents.test.ts`
- `src/main/live-agents.ts`、`src/main/live-agents.test.ts`
- `src/shared/source-capabilities.ts`
- `src/renderer/src/AgentsView.tsx`、`src/renderer/src/i18n.tsx`、`src/renderer/src/agent-topology.test.ts`
- `scripts/ci-tests.mjs`
- `README.md` 的协作拓扑概述及 Codex 覆盖说明
- `docs/performance-baseline.md` 的「Codex 协作拓扑采集」段

这里列出接入链路及已调查的调用方，不把文件内其他会话的改动归为本任务。

## 验证记录

- Codex 新增定向回归已通过，覆盖元数据/父线程关系和有界读取。未运行全仓库测试套件。
- `node --import tsx --test src/main/live-agents.test.ts`：18/18 通过。原有 128 会话批量读取测试等待原生通知时未保留事件循环句柄；测试内注入持久 watcher，产品仍由发现定时器保持轮询。修正后 128 个真实 watcher、批量发布和终态清除通过。
- `node --test scripts/ci-tests.test.mjs`：9/9 通过。
- `node scripts/ci-tests.mjs --plan src/main/collectors/codex-sessions.ts`：成功选择 Codex/Agent 回归及直接调用方，rendererSmoke=true。
- 用 `npm run dev` 运行隔离无头真实 Electron，接管 CDP 执行界面与 IPC。搜索测试子代理时保留父节点与连线；打开详情及 Codex 来源限制成功；关闭子描述符后节点消失且详情显示对象已离开；进程退出后测试节点全部移除。
- 最终真实快照：17 个 Codex 会话，4 主、13 子；Codex 来源 `ok`，agents.error=null，包含真实多级关系。快照计数代表采样当时，非持续保证。
- 中文默认 1280×860 下确认拓扑与详情；英文在 880×640 CSS 视口、页面 zoom=2 下展开来源能力并滚动读取，未出现页面横向溢出。此为无头真实渲染，不是可见原生窗口或 200% 系统文字设置验收。
- 60 次插件完整启停、每轮 128 个约128KiB头部读取，另64个并发读取取消：7680次完成、64次取消，最终文件/字节/队列使用归零。
- 真实 Electron 额外持有129个大头部输入、60轮刷新与20次插件启停：来源显示 SESSION_LIMIT、Agent总数受128上限约束；未OOM或出现采集错误。应用进程树每轮观测RSS最大708.53MiB；短样本及ps采样不证明完整生命周期瞬时峰值或24h稳定性。

证据保留：

- `/tmp/oc-chan-codex-final-20261106.json`
- `/tmp/oc-chan-codex-electron-before-20261106.json`
- `/tmp/oc-chan-codex-electron-after-20261106.json`
- `/tmp/oc-chan-codex-electron-stress-20261106.json`
- 更完整的前后指标、测量边界见 `docs/performance-baseline.md` 对应段。

## 完整工作区提交前验收

- `npm run build:app`：通过，包含 TypeScript 类型检查与主进程、preload、renderer 构建。
- `npm run smoke:renderer -- --out /tmp/oc-chan-full-commit-filter-smoke-20261106`：通过，`result.json` 为 `complete: true`、`errors: []`，共33张截图；首次实例与独立重启实例均正常退出，临时工作目录已释放。
- 完整场景覆盖真实无头 Electron 的概览直达、拓扑反复 Enter/Esc 与焦点归还、任务详情与历史分页、采集来源与 IPC 失败恢复、历史取消及资源释放、5000条事件分页与插件重建、通知订阅与保存失败重试、双语窄窗/200%文字，以及真实设置文件的独立重启读取。
- 提交门禁暴露两类问题并已修复：`AgentTopology.tsx` 的延后自动适应视图与用户明确选择存在时序竞争，且 React Flow 的节点 DOM 尚未同步时归还焦点会使用旧坐标；现保留目标并等待当前 DOM 提交。对应 `AgentsView.tsx` 和 `scripts/smoke/scenarios.mjs` 检查真实焦点就绪及重复打开/关闭。
- 通知验收此前继承历史分页场景保留的 `Perf schedule 000` 搜索词，导致 launchd 行被过滤；`scripts/smoke/notification-scenarios.mjs` 现经真实“清除筛选”入口建立独立前提，保留不支持订阅的断言。产品继续保留用户筛选条件。
- 先前失败证据保留在 `/tmp/oc-chan-full-commit-dom-smoke-20261106` 等目录；最终通过证据以 `filter-smoke` 目录为准。临时焦点诊断实例与监督进程已结束，`/tmp/oc-chan-focus-live-20261106.mjs` 已移除。
- GitHub 身份现场回读为 `Zixiaobowen`，目标为该账号的 `oc-chan` 仓库。提交范围仍是获批的完整当前工作区；推送只对本次命令禁用会自动安装本机应用的 pre-push 钩子，不修改永久配置。提交 SHA 与远端回执见本次会话最终交付。

## 清理、限制与风险

- 测试 descriptor 进程正常退出；本任务 launcher PID97883 已发 SIGTERM，监督服务因主动停止返回143，此为收尾退出，不是验收故障。
- `.dev-instances/instance-lZDcuv` 已释放；同名实例相关进程为0。保留原有 `instance-9jSULN`。
- 本任务7个临时测量/诊断脚本及 `/tmp/oc-chan-codex-topology-20261106` 合成夹具目录已删除；测量JSON证据保留。
- 仅能显示当前被存活进程持有且符合结构的可写会话。关闭但仍被桌面进程持有的线程可能继续可见，所以不能将数量解释为活动工作数。
- 没有集成 Codex 当前调用事件、可靠的桌面/子代理 busy/idle 或外部窗口导航；界面明确展示这些能力限制。
- 没有执行可见窗口全屏、连续拖动、硬件缩放、帧时间或长期OOM验收。Codex采集接入本身未改布局/动效；提交门禁随后修复了拓扑视口与焦点时序，只完成上述无头交互验收，不声称可见原生动效验收通过。
- 前后性能样本背景会话和导航存在变化，不据此宣称性能提升。新增工作是会话头部识别，测试只证明受预算限制且短时运行正常。

## 后续动作

1. 若继续开发，先核对本分支本地 HEAD 与远端是否一致，保护新的未提交改动，读取本交接及相关文件的最新状态。
2. 若只需重验，使用 `npm run dev` 新建隔离无头实例，在“协作拓扑 → 全部”搜索 Codex，检查父子关系和来源说明；活动筛选不把状态未知的会话计为活跃。
3. 若继续 R-04，按原 backlog 交接完成管理员采样器的长期资源验收；本次提交不能代替该验收。正式安装、发布和部署仍需单独授权。

## 恢复提示

继续 OC Chan 的 Codex 协作拓扑工作。先读 `docs/codex-handoffs/2026-11-06-codex-topology.md`。用户最终指定 GitHub main；完整工作区 f69cfc2 与 main e5431c0 的合并决策及本地通过检查见下方“合入 GitHub main”。Codex实现与真实无头验收已完成；只读当前可写rollout头部，不读历史正文，不把驻留误判为工作中，共用128会话/单头1MiB预算。R-04长期资源验收仍未完成，不能把这次合并视为安装、发布或部署。Git最终SHA与远端回执见会话最终交付，恢复时现场核对 main。不要打开可见开发窗口或改动其他worktree。

## 合入 GitHub main

- 用户明确纠正交付目标为 GitHub `main`。现场抓取到 `origin/main=e5431c0935ac5ac7357a14493dc8b36003220e1f`，与完整工作区提交 `f69cfc2` 分叉；使用保留两边历史的普通合并，不强推、不删分支。
- main 的液态玻璃、前端依赖不重复打包、拓扑项目色及分组排序继续保留；与新版插件、Codex、通知、视图记忆、实测布局和焦点同步整合。保留 main 原有目录初始化、无头异常/渲染进程退出处理、原生材质错误处理和保存中拒绝玻璃预览。
- 开发实例的 `present-window` 输出与主进程资源查找统一到 `<instance>/resources/tern-navigation`；启动器将两份静态Tern插件文件精确复制进该实例。玻璃/通知原生模块继续使用实例目录，不写回共享资源。`--packaged-app` 旧入口由现有完整包门禁和交付流程替代，README同步删除旧命令。
- CI 的 `APP_DIRECTORY` 改为 `${{ github.workspace }}/release/mac-arm64/OC Chan.app`，与当前包门禁要求绝对路径一致；未放宽任何包内容或体积限制。
- `npm run build:app`：通过，TypeScript、主进程、preload、renderer全部构建成功。
- `node --import tsx --test --test-concurrency=2 src/main/settings.test.ts src/shared/diagnostics.test.ts src/main/ipc-boundary.test.ts src/main/shutdown.test.ts src/main/tray-window.test.ts src/main/window-geometry.test.ts src/main/tern-navigation.test.ts src/main/installation-check.test.ts src/renderer/src/agent-topology.test.ts scripts/check-package.test.mjs scripts/install-local.test.mjs scripts/ci-tests.test.mjs`：184/184通过，0失败/取消/跳过；未运行全仓测试。
- `OC_CHAN_DEV_INSTANCE=/tmp/oc-chan-main-native-K49T0c npm run build:native`：通过。`file`核对导航helper为arm64可执行文件，Liquid Glass与通知模块为arm64 Mach-O bundle；该临时输出已清理。只编译，没有激活Tern或运行可见窗口。
- `npm run smoke:renderer -- --out /tmp/oc-chan-main-merge-smoke-20261106`：完整场景通过，覆盖真实无头Electron、IPC、焦点归还、历史/事件/通知及独立重启设置持久化。验收结果和逐阶段证据保留于该目录。
- 推送仍仅对本次命令跳过会自动安装应用的pre-push钩子；不改永久hooks配置、不替换`/Applications/OC Chan.app`。GitHub云端构建、安装包及可见原生验收与上述本地验证分开，不能互相替代。
