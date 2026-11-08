# Tern 右键跳转候选与进程身份修复

- Repo：`/Users/zixiaobowen/myProjects/oc-chan`；主线工作区：`/Users/zixiaobowen/myProjects/oc-chan-main-integration-20261106`
- Branch：修复分支 `fix/tern-navigation-candidates-20261108` 已快进合并到 `main`
- 目标：修复拓扑右键Tern跳转，合并并推送 `main`，更新和验收本机应用；均已完成。

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
- **已安装应用真实右键验收通过**：用原生鼠标右键3D拓扑中的本会话员工标签，真实菜单出现“跳转到 Tern 标签页”；点击该菜单项后，前台应用为 `so.stencil.tern`、PID79787、原生窗口 `[Tern "14"] Default`。随后 `tern inspect --json --window 14` 证实tab `8169027796994` 的 `shown=true`，本会话pane `9723805958155` 的 `focused=true`。
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
- 用户在本会话明确授权“合并到main并push，更新本机应用”，已执行并验收；没有创建公开Release或修改GitHub默认分支。
- Tern重启及原生跳转也已按本次授权完成。没有变更辅助功能授权或任何登录资料；临时验收脚本、资源和开关已清理/恢复。
- 构建仍提示现有依赖弃用和大于500KB的渲染chunk；构建成功。跨空间/全屏切换、x64及公开签名发布不在本轮验收内。没有运行全仓库测试。

## 后续操作边界

1. 无新增代码或故障时，不重复构建、安装或执行已通过检查；已安装产品代码来自修复提交，后续交接文档提交不改变产物。
2. 后续开发以主线工作区 `main` 为准，保留两个工作区的无关未提交记录和并行任务文件，不清理或删除分支/worktree。
3. 若原生跳转再报错，重新采集窗口/pane/PID、内核启动时间与系统签名证据，不沿用本记录中的临时PID。

## 恢复提示

继续主线工作区 `/Users/zixiaobowen/myProjects/oc-chan-main-integration-20261106` 的main。本轮Tern跳转修复已提交为330d1fc4ff3dcb28f87143e4aa0c259b76c4c377，快进合并并推送origin/main。本机OC Chan已由该提交独立快照构建并替换，版本0.1.0、renderer/IPC/四类采集/历史就绪通过；实际在已安装3D拓扑右键本会话并点击跳转，Tern14窗口成为前台，本会话pane9723805958155所在tab shown且pane focused。81项定向检查、27项相关复测、typecheck、无头smoke均通过，未跑全仓库测试。临时AX模式已恢复false，未改全局权限/登录。产品交付已完成，最后交接提交仅文档。保留两个工作区的无关记录与并行任务文件，不重复安装、测试或清理。
