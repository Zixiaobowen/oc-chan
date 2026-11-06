# 本轮清单实施合入 master · 2026-11-06

## 目标与工作区

- 用户明确要求“提交到master”，随后要求“推送到github”。本轮包含代码提交、合并、普通分支推送；不创建标签、Release，不重新安装本机应用。
- 原仓库：`/Users/zvf003/ZStack/oc-chan`，仍在 `fix/oc-chan-r04-admin-sampler-20261106`，全部未提交改动保留。
- 独立集成工作树：`/Users/zvf003/tmp/oc-chan-backlog-master-20261106`，当前分支 `master`。
- 实施提交：`e4628c5`（`feat: harden local monitoring and collector lifecycle`），分支 `integrate/backlog-master-20261106`。
- 已生成master合并提交：`002aac39e8b7f36ce1525bc06970403a0957f8a0`，父提交为`dab694d`与`e4628c5`。提交身份`bowen.sun <bowen.sun@zstack.io>`。
- 最终应用/CI源码提交：`b8c364308cdb872cf3e195b98697c55cd3678b7a`，已普通推送到`origin/master`。其后仅提交本交接的完成回执，使用`[skip ci]`避免重复构建相同应用源码。
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
- `002aac3`已通过普通push送达GitHub，`git ls-remote`确认远端master完整SHA一致。首次云端工作流`42172300826`行为测试通过，Electron smoke失败于`events-identity-and-background-new-record`的真实滚轮断言，产物步骤未执行；Release作业按普通分支条件跳过。失败日志、截图、完整回执下载于`/tmp/oc-chan-ci-42172300826/oc-chan-renderer-smoke-19`。
- 来源输入带原生datalist，原脚本点击后直接发wheel，未关闭候选菜单或移动指针到滚动区；补齐Escape与mouseMoved，保留实际滚动、焦点和阅读位置断言，不修改产品代码、不重跑未修改的失败提交。
- 修正后的完整本地Electron smoke通过：`/tmp/oc-chan-ci-wheel-fix-20261106/result.json`，184.23秒，`complete=true`且无错误。真实wheel后scrollTop为240；后台新事件到达前后来源框焦点一致，可见记录`smoke-f05-04949`距工作区顶部均为103.796875px。两次进程正常退出并完成资源/profile/输入清理。云端仍需验证。
- 修正提交`8c0ec3a082afca3de40f2567193c7a5acc0891c2`已推送。云端运行`42173731035`仍失败于同一个滚轮断言，说明仅补齐菜单/指针前提不足；不能宣称根因已经解决。原始回执保存在`/tmp/oc-chan-ci-42173731035`。
- 诊断提交`117cadbf72961743020aecc7d87bda6a1b5c1934`对应运行`42174528532`确认：视口1280×860、DPR=1，容器高度805、内容12605、overflow=auto；可信mousemove与wheel均命中MAIN，deltaY=240且defaultPrevented=false，但scrollTop始终0，没有scroll事件。该证据不支持滚动后被产品重置，也不能归因于候选菜单。
- 完整`Input.synthesizeScrollGesture`在完整本地smoke也超时：`/tmp/oc-chan-ci-scroll-gesture-20261106`、`/tmp/oc-chan-ci-compositor-fix-20261106`、`/tmp/oc-chan-ci-native-geometry-20261106`。关闭后台节流和核对原生1280×860窗口均不足以解决。独立最小实验能够滚动，但不能代表完整流程；实际frame/gesture内部阻塞点仍未确认。临时探针、节流设置和尺寸日志均已删除；两个独立调查实例正常退出且profile已移除。
- 最终smoke沿用已有目标返回场景的DOM `scrollIntoView`建立真实记录阅读位置；真实事件IPC、页内记录、输入焦点、同一可见记录及≤1px位置误差断言仍保留，没有轮询重试或失败后兜底。此项验证后台刷新保留阅读状态，不再把隐藏窗口输入当作原生滚轮验收；原生专项仍未完成，README及结果字段明确注明。
- 最终本地完整smoke通过：`/tmp/oc-chan-ci-reading-position-20261106/result.json`，181.74秒，`complete=true`、`errors=[]`。初始scrollTop=344；新增事件后同一记录`smoke-f05-04949`距顶部始终-0.203125px，来源输入焦点未变。首轮与重启退出0、资源全归零，进程/profile/输入目录清理完成。
- 最终smoke提交`530b4adf48df0dad36995229980a96eca058dfc2`已推送。云端运行`42179105685`的行为测试、完整Electron smoke及证据上传通过；后续失败于包检查入口：工作流传入相对`--app`，脚本明确要求绝对路径，错误为`Expected --app ABS_APP and --arch arm64|x64`。该次未完成产物上传。
- 工作流`APP_DIRECTORY`已改为`${{ github.workspace }}/release/mac-arm64/OC Chan.app`。YAML实际解析与表达式展开检查通过；`node --test scripts/check-package.test.mjs`45/45通过，无跳过。修正提交`b8c3643`已推送。
- 最终云端运行[42181153359](https://github.com/Zixiaobowen/oc-chan/actions/runs/42181153359)已完成且`conclusion=success`，实际head SHA为`b8c364308cdb872cf3e195b98697c55cd3678b7a`。工作流包括适用行为测试、完整Electron smoke、arm64 DMG/ZIP构建、依赖许可证/公告、包内容及冻结体积、SHA-256校验与上传；普通分支未发布Release。
- API确认两份未过期产物：`oc-chan-renderer-smoke-24`，ID`13485870345`、4,171,966字节、摘要`sha256:d6ef249e2f55f85948cc47487d6eacae96ba5fc6bf0a6b4bc562e5373bfec9d8`；`oc-chan-macos-arm64-24`，ID`13484729871`、236,300,004字节、摘要`sha256:ade3181d9e90eaef06ca463a3e9318fe2e0e068dc9495bdfe7bdafd779cf17a3`。该摘要是GitHub产物压缩包摘要，不冒充本机文件复算；最终产物未下载或安装。
- GitHub API期间出现TLS握手超时及unexpected EOF，未因此重跑旧提交。系统已有代理`127.0.0.1:7897`，仅临时用于命令；最终回执通过公共DNS实际返回的官方API地址、保留域名TLS校验读取。未修改全局网络、DNS或Git配置，凭据只在进程内使用，未写入仓库或日志。

## 未完成与限制

- 本轮master合并、源码推送、云端构建及产物上传均已完成。仅文档回执提交不改变已验收的应用源码。
- 37卡仍为27卡有完整本地完成证据。R-04的24h验收未完成：管理员采样器定向检查和真实权限验证已有证据，但最近预验在macOS系统认证阶段超时，未启动Electron；没有长测运行，旧失败时长不累计。
- U-05、U-07、U-08、F-06、D-03仍缺完整原生专项；系统通知权限denied。F-07只做调研，正式签名公证/发布和多人试用按用户决定延期。
- 本轮未替换`/Applications/OC Chan.app`、未运行可见原生窗口，也未新增性能提升声明。云端产物不能替代已安装应用验收；当前安装版不是本轮合并版本。

## 接续动作

1. 具备macOS系统认证条件时，从原实施交接恢复R-04的6分钟管理员采样预验；通过后新开24h，不累计旧失败时长，不重复认证弹窗。
2. 安排隔离账号中的登录启动、物理托盘、VoiceOver、系统减少动态效果等原生专项，保持U-05/U-07/U-08/D-03未完成状态直到实际回执齐全。
3. F-06需系统通知权限可用后验证投递、点击、专注模式及睡眠恢复；当前denied不能计为通过。
4. 原工作区并行Codex拓扑改动单独集成；保留现有修改，不全量暂存、重置、强推或删除工作树。
5. D-01/D-02正式分发、F-07接口实施和O-01多人试用按用户既有范围决定延期，恢复时重新确认对应发布或外发授权。

## 恢复提示

OC Chan本轮master提交与推送已完成。集成工作树`/Users/zvf003/tmp/oc-chan-backlog-master-20261106`，master合并002aac3，最终应用/CI源码b8c364308cdb872cf3e195b98697c55cd3678b7a；云端运行42181153359已success，两份artifact为oc-chan-macos-arm64-24与oc-chan-renderer-smoke-24。最终仅文档回执提交不重复构建。无需重做已通过的构建、82项集成定向检查、45项包检查及完整本地/云端smoke。原仓库保持fix/oc-chan-r04-admin-sampler-20261106及其并行Codex工作。37卡仍为27卡有完整本地证据；R-04系统认证阻塞、原生专项和用户延期项保持未完成。本轮未安装应用、发布标签或Release；后续安装和发布需要对应授权。
