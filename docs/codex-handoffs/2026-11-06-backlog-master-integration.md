# 本轮清单实施合入 master · 2026-11-06

## 目标与工作区

- 用户明确要求“提交到master”，随后要求“推送到github”。本轮包含代码提交、合并、普通分支推送；不创建标签、Release，不重新安装本机应用。
- 原仓库：`/Users/zvf003/ZStack/oc-chan`，仍在 `fix/oc-chan-r04-admin-sampler-20261106`，全部未提交改动保留。
- 独立集成工作树：`/Users/zvf003/tmp/oc-chan-backlog-master-20261106`，当前分支 `master`。
- 实施提交：`e4628c5`（`feat: harden local monitoring and collector lifecycle`），分支 `integrate/backlog-master-20261106`。
- 合并基线：远端 `origin/master` 的 `dab694d`。本地 master 已从 `33068be` 快进到该远端基线，合并内容已通过本轮集成验证。
- 源码取自已验证冻结目录 `/private/tmp/oc-chan-r04-admin-source-h4AzW7`，来源摘要 `bd23450ba0da1e4920abfb81e03a3661a25a1b93cd2cd7c6c38357f0075f358d`。196项中仅导入194个源码/配置文件，两个生成的原生二进制不提交；另导入21份相关配置及文档。
- 并行 Codex 拓扑接入留在原工作区，未导入其新增文件、修改后的7个文件版本或专属验收段；不宣称该功能随本轮交付。

## 集成决定

- 保留远端蓝白主题、品牌资源和标签发布流程。
- 保留本轮插件化采集、全局资源预算、历史取消/退出等待、IPC边界、页面查看状态、来源诊断、本地事件与通知、arm64本地交付、CI行为门禁及专用只读管理员采样器。
- 历史与IPC冲突采用本轮已经迁移到公开插件契约和有界资源管理的实现，删除旧的默认provider和独立history实例，不保留兼容路径。
- 标签发布产物整理改为本期唯一支持的arm64，保留版本标签检查、固定Action SHA、只读构建权限和单独发布权限。普通master推送不会执行Release作业。
- 推送需单次使用 `git -c core.hooksPath=/dev/null push origin master:master`，避免触发本机安装；不改持久hook配置、不强推、不删除分支或工作树。

## 本轮实际验证

- `npm run build`：通过。包含TypeScript类型检查、main/preload/renderer Vite构建及Swift/Objective-C++原生模块构建。
- 定向测试82/82通过：`src/main/schedule-history.test.ts`、`src/main/collectors/hermes-history.test.ts`、`src/main/plugins/schedules.test.ts`、`src/main/ipc-boundary.test.ts`、`src/main/shutdown.test.ts`、`src/main/navigation.test.ts`、`src/renderer/src/agent-topology.test.ts`、`src/renderer/src/view-state.test.ts`、`scripts/ci-tests.test.mjs`。命令入口为 `node --import tsx --test`，未运行全仓单元套件。
- 实际解析合并YAML，并以临时arm64文件执行原样Release产物整理脚本：DMG/ZIP摘要检查通过；缺包退出1。临时夹具已删除；未调用GitHub发布接口。
- 首次真实无头Electron smoke：`/tmp/oc-chan-master-integration-smoke-20261106/result.json`，失败于重复打开/关闭Agent详情后的焦点返回。首轮Escape正常，第二轮焦点落在搜索框；失败不是构建或历史读取错误。
- 诊断运行：`/tmp/oc-chan-master-focus-diagnostic-20261106/result.json`；记录显示目标`performance:0`节点第二轮关闭时不在DOM，视口为`translate(-2226.3px,126.425px) scale(0.65)`。节点仍属于当前页，不能当成对象离场。
- 上述失败实例都正常退出，进程组、独立profile和合成输入已清理，插件/队列/资源预留归零。失败原始证据保留。

- 焦点根因由额外trace运行`/tmp/oc-chan-master-focus-trace-20261106`确认：初始项目组fit在对象导航/两次开关详情后才执行，使目标节点离开视口并被虚拟化。`AgentTopology.tsx`让初次/待完成的自动fit采用最新对象导航目标，保留明确fit-all与手动视口取消。无轮询、重试或兼容分支；临时focus原型探针已删除。
- 修复后`/tmp/oc-chan-master-focus-fixed-20261106`中两次Escape均保持`performance:0`节点焦点，原始geometry确认节点可见；历史、事件、故障恢复等前序场景通过。最新`npm run typecheck`通过。该次完整流程仍失败在通知测试：前序历史场景保留`Perf schedule 000`搜索，而通知场景错误假定launchd行可见。
- `scripts/smoke/notification-scenarios.mjs`在场景入口经真实Escape/清除筛选控件恢复初始条件，仍要求launchd实际出现并验证不支持执行通知；未删除或放宽断言。
- 最终完整Electron smoke通过：`/tmp/oc-chan-master-integrated-final-20261106/result.json`，`complete=true`、8个运行阶段全部通过、`errors=[]`，总耗时201.27秒。覆盖重复开关详情的焦点返回、历史分页、事件、通知、故障恢复、设置持久化及真实重启。首轮和重启均退出0，monitor停止，全部资源预留归零，进程、独立profile和临时输入目录已释放。已查看实际拓扑截图，目标节点可见并保留键盘焦点。

## 未完成与限制

- 本轮集成验收已通过，待生成合并提交、推送并核对GitHub工作流；回执在后续追加。
- 37卡仍为27卡有完整本地完成证据。R-04的24h验收未完成：管理员采样器定向检查和真实权限验证已有证据，但最近预验在macOS系统认证阶段超时，未启动Electron；没有长测运行，旧失败时长不累计。
- U-05、U-07、U-08、F-06、D-03仍缺完整原生专项；系统通知权限denied。F-07只做调研，正式签名公证/发布和多人试用按用户决定延期。
- 本轮没有重新打DMG/ZIP、替换`/Applications/OC Chan.app`、运行可见原生窗口或新增性能提升声明。当前安装版不能当作本轮合并版本。

## 接续动作

1. 完成master合并提交；最终Electron成功及退出清理回执已经核对，不重复运行已通过检查。
2. 按上述单次hook绕过推送，核对远端master的实际SHA与GitHub工作流回执。
3. 更新本交接的最终提交、推送和CI结果；不得把普通smoke当成R-04或原生专项通过。
4. 后续具备macOS认证条件时按原实施交接恢复6分钟管理员采样预验；通过后才新开24h，勿重复认证弹窗。
5. 原工作区保留并行Codex改动，后续单独集成，禁止全量暂存、重置或清理来消除残留。

## 恢复提示

继续OC Chan本轮master集成，工作树`/Users/zvf003/tmp/oc-chan-backlog-master-20261106`。实施提交e4628c5已生成，master基线dab694d，合并冲突已按本轮插件化实现解决并保留远端蓝白品牌与标签发布流程。构建及82项定向测试已通过，Release arm64整理脚本已真实检查成功/缺包失败。Electron重复开关详情的焦点问题已修复；完整smoke在`/tmp/oc-chan-master-integrated-final-20261106/result.json`通过，退出清理已核对。下一步生成合并提交并推送、核对CI。用户已授权提交和推送，无需再问；单次禁用安装hook，不覆盖正式应用或发布标签。原仓库仍在fix/oc-chan-r04-admin-sampler-20261106，保留其并行Codex拓扑工作。R-04系统认证阻塞、原生专项和延期项继续保持未完成。
