# Tern 右键跳转候选与进程身份修复

- Repo：`/Users/zixiaobowen/myProjects/oc-chan`；主线工作区：`/Users/zixiaobowen/myProjects/oc-chan-main-integration-20261106`
- Branch：修复分支 `fix/tern-navigation-candidates-20261108` 已快进合并到 `main`
- 目标：修复拓扑右键Tern跳转，合并并推送 `main`，更新和验收本机应用。候选与进程身份修复已交付；后续辅助功能权限阻塞已在用户授权和系统认证后解除，已安装应用真实右键跳转验收通过。

## 已完成

- `src/main/tern-present.swift`：先筛选未退出且 `activationPolicy == .regular` 的可交互应用，再判断候选唯一性。后台/CLI及已退出记录不再制造歧义；两个可交互实例仍明确拒绝。改用 `proc_pidinfo(PROC_PIDTBSDINFO)` 返回的启动秒/微秒绑定PID，删除对AppKit可空 `launchDate` 的依赖。保留实际可执行路径、Developer ID签名、session与原生窗口回执验证。
- `src/main/tern-present.test.ts`：编译实际Swift选择器，覆盖10种候选组合和3种真实内核进程身份场景（稳定、不同进程、退出后拒绝）。修改前实际复现正常应用与后台/退出项并存时报 `OC_TERN_AMBIGUOUS`；修改后通过。临时目录自动清理，不依赖真实Tern、网络或辅助功能授权。
- `scripts/ci-tests.mjs`：原生回归加入现有Tern定向套件。
- `README.md`：同步候选筛选、内核进程身份、Tern更新后旧进程处理及实际原生验收范围。
- 本地依赖目录缺少锁文件已声明的 `three` / `@types/three`，已运行 `npm install --ignore-scripts --no-audit --no-fund` 补齐（新增9项、移除1项）；`package.json` 和 `package-lock.json` 无变更。

## 已运行验证

- `npm run test:ci -- src/main/tern-present.swift src/main/tern-present.test.ts scripts/ci-tests.mjs`：81/81通过，9个定向测试文件；未跑全仓库测试。
- 新增内核身份修复后运行 `node --import tsx --test src/main/tern-present.test.ts src/main/tern-navigation.test.ts`：27/27通过；未重复其它仍适用的已通过检查。
- `npm run typecheck`：补齐依赖后通过。首次失败是缺少Three.js及其类型依赖。
- `npm run smoke:renderer -- --scenario topology`：补齐依赖后通过。真实无头Electron、preload、React、IPC、拓扑交互、重启恢复和正常退出通过；`nativeWindowAcceptance=false`，不是实际跨应用焦点验收。
- Smoke成功证据：`/var/folders/sw/0g6s73xd04n89bg0lympw6_40000gn/T/oc-chan-smoke-evidence-JkwHOV/result.json`，`complete=true`、8阶段通过、errors为空、临时工作目录已删除。
- 原生helper按发布参数 `xcrun swiftc -O -target arm64-apple-macos13.0 ...` 编译通过，无警告，117744字节，小于163840字节现有预算。后续交付的arm64应用目录打包也已通过；未构建x64、DMG或ZIP。
- 最终真实 `probe` 成功：PID79787、`/Applications/Tern.app/Contents/MacOS/tern`、Bundle ID=`so.stencil.tern`、Team ID=`VTLHGQC72S`。
- 经用户授权，从实际 `tern inspect` 重取窗口与pane，调用生产 `TernNavigation.focus()`（真实资源、命令与原生helper，未注入mock）通过。回执：`{"ok":true,"paneId":9723805958155,"windowKey":"14","durationMs":1068}`。该方法完成session复核、pane focus、原生窗口激活并确认主窗口焦点稳定；只操作本会话目标。

## 合并、推送与本机安装

- 修复提交：`330d1fc4ff3dcb28f87143e4aa0c259b76c4c377`，仅包含Swift、原生回归测试、CI映射、README及本交接5个文件。
- `git merge --ff-only fix/tern-navigation-candidates-20261108` 在主线工作区成功，`e184bc8` → `330d1fc`，无冲突。
- `git -c core.hooksPath=.githooks push origin main` 成功。仅本次命令使用仓库现有pre-push安装钩子，没有永久修改Git配置；远端 `git ls-remote --refs origin refs/heads/main` 回读为完整修复SHA。
- 钩子以该提交的 `git archive` 独立快照执行 `npm ci`、类型检查、Vite构建、arm64目录打包及原生编译，完成来源、内容、架构、签名、磁盘和权限预检，再替换 `/Applications/OC Chan.app`。没有将工作区未提交文件混入应用。
- 已安装版本 `0.1.0`，实际应用PID27126。安装回执 `status=ready`、`renderer=true`、`ipc=true`，agents/schedules/system/events均ready，Hermes历史读取25条。个人设置和数据目录保留。
- **更正已安装应用右键验收结论**：原验收确实操作了3D拓扑真实右键菜单，并观察到前台应用为 `so.stencil.tern`、原生窗口 `[Tern "14"] Default`，tab `8169027796994` 的 `shown=true`、本会话pane `9723805958155` 的 `focused=true`。但未核对OC Chan端导航成功回执，这些状态不足以证明整条链路成功；原“验收通过”结论撤回。命令行中调用生产导航成功也不能代替已安装应用的权限验收。
- 验收通过Electron公开的 `AXManualAccessibility` 临时暴露已安装应用控件树；原值false，结束后设置并读回false。未开启调试端口、未重启额外开发窗口、未改变系统辅助功能权限。
- 本交接随后补充交付回执；仅文档变更不重复构建或安装相同产品代码。

## 已处理的现场问题

- 最初AppKit枚举到的可交互Tern为PID15733，另有后台PID7153。没有捕获原报错当时的多个AppKit候选；后台/退出项误判由实际Swift回归证实，不等于还原了用户当时现场。
- 对PID15733：`proc_pidpath`返回0、`errno=2 (ENOENT)`；`SecCodeCopyGuestWithAttributes`返回100002（`UNIX[No such file or directory]`）；AppKit `launchDate=nil`。
- `lsof -n -a -p 15733 -d txt -F n`显示其主程序仍为 `/Applications/.Tern.app.old-1793980827/Contents/MacOS/tern`；该旧目录已不存在。
- `/Applications/Tern.app`磁盘新版本的Developer ID签名核验通过，Bundle ID=`so.stencil.tern`、Team ID=`VTLHGQC72S`。不能用新程序的静态签名替代正在运行旧程序的身份校验。
- 用户明确选择“重启并验收”并回复“允许”后，已执行 `tern restart --json`。回执为 `running=true`、`windows=1`、`kept="its executable has not changed since it started"`；会话程序继续运行，新的窗口应用PID79787。旧路径问题已消失。
- 重启后 `launchDate` 仍为nil，但内核启动时间、可执行路径和运行签名均可读取。Apple SDK `NSRunningApplication.h:111` 明确说明未通过Launch Services启动的应用没有 `launchDate`；改用内核时间后真实probe与导航均通过。
- 本任务临时helper、复制的插件和诊断脚本已清理；已核对临时helper目录不存在。没有清理其他任务资源。

## 限制与状态

- 保留原工作区的 `docs/codex-handoffs/2026-11-04-github-release-publishing.md` 修改、并行任务的 `2026-11-08-push-update-audit.md/.html`；保留主线工作区的 `2026-11-06-app-updates-main.md` 修改。
- 用户在本会话明确授权“合并到main并push，更新本机应用”，已合并、推送并安装；基础就绪和最终已安装右键跳转均通过。没有创建公开Release或修改GitHub默认分支。
- Tern重启及原生跳转按本次授权完成；后续用户另外明确允许为OC Chan开启辅助功能权限，并完成macOS系统认证。没有变更其他应用权限或登录资料；临时验收状态已恢复。
- 构建仍提示现有依赖弃用和大于500KB的渲染chunk；构建成功。跨空间/全屏切换、x64及公开签名发布不在本轮验收内。没有运行全仓库测试。

## 辅助功能权限阻塞（后续现场）

- 用户报告 `OC_TERN_ACCESSIBILITY`。系统TCC日志确认已安装助手 `present-window` 的请求归属 `local.oc-chan.desktop`（`/Applications/OC Chan.app`），不是Tern、终端或命令行运行环境。
- 2026-11-08 21:29:34，助手PID34355的两次 `kTCCServiceAccessibility` 请求均返回 `authValue=0`、`authReason=4`。
- 只读查询 `/Library/Application Support/com.apple.TCC/TCC.db` 中该应用的记录：`client_type=0`、`auth_value=0`、`auth_reason=4`，更新时间21:21:38。其csreq末尾CDHash为 `c3889e2485de6457374593bad6f518e3a36882f2`，与当前安装应用 `codesign -dv --verbose=4` 输出一致；没有旧版签名失配的证据。
- `src/main/tern-present.swift:273` 在原生窗口操作前用 `AXIsProcessTrusted()` 检查授权，未授权时明确抛出该错误。导航CLI在此之前可能已选中pane，因此pane与前台状态不能单独充当成功证明。
- 导出并检查当前Tern公开插件类型，发现pane/tab focus接口，未找到原生窗口激活接口。没有修改TCC数据库、重置授权、放宽签名校验或添加绕过路径。
- Apple官方说明该权限需在“系统设置 → 隐私与安全 → 辅助功能/无障碍”批准应用：https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac （2026-11-08核对）。本机实际权限页标题为“设备控制和数据访问”，通过原生界面的 `OC Chan_Toggle` 开关完成操作。

## 辅助功能授权与最终验收

- 用户明确选择“允许开启并验收”。原生界面确认OC Chan开关初始为0，仅点击该开关；macOS要求Touch ID/密码认证，用户随后确认“已完成认证”。没有读取或接收密码，没有写TCC数据库或重置授权。
- 系统记录随后为 `auth_value=2`、`auth_reason=4`，更新时间2026-11-08 21:42:33，权限归属仍为已安装 `local.oc-chan.desktop`。
- 从当前会话环境重取目标 `TERN_WINDOW_KEY=14`、`TERN_PANE=9723805958155`，用 `tern inspect` 确认对应tab `8169027796994`。实际在已安装OC Chan（PID27126）的3D员工标签“TERN: 修复协作拓扑与 Tern 辅助功能权限, 工作中, PID 65783”上右键，再用真实鼠标点击“跳转到 Tern 标签页”。未调用测试替身或命令行导航来代替此操作。
- 应用端检查：此前实际可见的 `OC_TERN_ACCESSIBILITY` 错误消失，“前往 Tern”按钮恢复可用，未处于“正在跳转”状态；完整原生控件树和已安装窗口截图均未显示导航错误。截图留在本会话 `local://oc-navigation-authorized.png`。
- 系统端检查：2026-11-08 22:00:45，归属于OC Chan的本次助手PID68023请求 `68023.1/.2/.3` 均返回 `authValue=2`、`error=(null)`；原生前台应用为 `so.stencil.tern`、PID79787，主窗口为 `[Tern "14"] Default`；`tern inspect` 回读本会话tab `shown=true`、pane `focused=true`。
- 临时UI检查脚本设置 `AXManualAccessibility=true` 时立即回读仍为false，未以此宣称开关启用成功；最终使用真实鼠标完成交互。结束后显式恢复并读回false。关闭本任务独占启动的系统设置进程PID48966，已确认退出。
- 此阶段没有修改产品代码、重装应用或重跑此前已通过的自动测试。只读核对签名/TCC、原生权限设置、已安装真实交互和窗口/pane回读构成本次验证。

## 后续操作边界

1. 无新增代码或故障时，不重复构建、安装或执行已通过检查；已安装产品代码来自修复提交，后续交接文档提交不改变产物。
2. 后续开发以主线工作区 `main` 为准，保留两个工作区的无关未提交记录和并行任务文件，不清理或删除分支/worktree。
3. 本次辅助功能授权已生效，无需重复申请或重置；以后若再次报错，先核对当次应用身份和系统权限回执，不能沿用旧PID或单凭pane已选中认定成功。
4. 后续真实导航验收同时检查应用错误状态、请求结束、系统权限决策、目标pane和原生窗口焦点；命令行上下文的授权不能代替安装应用的授权。
5. 无新增故障无需继续动作；只有新增产品改动才运行相关验证和安装流程，保留用户设置、窗口布局及其他任务资源。

## 恢复提示

继续主线工作区 `/Users/zixiaobowen/myProjects/oc-chan-main-integration-20261106` 的main。候选与进程身份修复330d1fc4ff3dcb28f87143e4aa0c259b76c4c377已合并、推送并安装，基础就绪通过。后续OC_TERN_ACCESSIBILITY已定位为已安装OC Chan未获辅助功能授权，csreq与当前签名一致。用户明确同意开启并完成系统认证后，权限变为auth_value=2；2026-11-08 22:00:45从已安装3D拓扑真实右键跳转，本次helper PID68023获准，应用错误提示消失、按钮恢复可用、Tern14主窗口前台且本会话pane9723805958155聚焦。此前仅凭前台/pane认定成功的结论已更正，以最终多端证据为准。临时UI检查状态已恢复false，本任务系统设置已退出。本次未改产品代码或重装；此前81项定向检查、27项复测、typecheck、无头smoke仍有效。保留两个工作区无关记录与并行任务文件，不重置权限、不重复测试或清理用户资源。
