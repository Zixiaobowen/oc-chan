# Tern 右键跳转候选与进程身份修复

- Repo：`/Users/zixiaobowen/myProjects/oc-chan`
- Branch：`fix/tern-navigation-candidates-20261108`
- 目标：修复协作拓扑右键“跳转到 Tern 标签页”报 `OC_TERN_AMBIGUOUS`。

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
- 最终原生helper按发布参数 `xcrun swiftc -O -target arm64-apple-macos13.0 ...` 编译通过，无警告，117744字节，小于163840字节现有预算。未执行完整打包或x64编译。
- 最终真实 `probe` 成功：PID79787、`/Applications/Tern.app/Contents/MacOS/tern`、Bundle ID=`so.stencil.tern`、Team ID=`VTLHGQC72S`。
- 经用户授权，从实际 `tern inspect` 重取窗口与pane，调用生产 `TernNavigation.focus()`（真实资源、命令与原生helper，未注入mock）通过。回执：`{"ok":true,"paneId":9723805958155,"windowKey":"14","durationMs":1068}`。该方法完成session复核、pane focus、原生窗口激活并确认主窗口焦点稳定；只操作本会话目标。

## 已处理的现场问题

- 最初AppKit枚举到的可交互Tern为PID15733，另有后台PID7153。没有捕获原报错当时的多个AppKit候选；后台/退出项误判由实际Swift回归证实，不等于还原了用户当时现场。
- 对PID15733：`proc_pidpath`返回0、`errno=2 (ENOENT)`；`SecCodeCopyGuestWithAttributes`返回100002（`UNIX[No such file or directory]`）；AppKit `launchDate=nil`。
- `lsof -n -a -p 15733 -d txt -F n`显示其主程序仍为 `/Applications/.Tern.app.old-1793980827/Contents/MacOS/tern`；该旧目录已不存在。
- `/Applications/Tern.app`磁盘新版本的Developer ID签名核验通过，Bundle ID=`so.stencil.tern`、Team ID=`VTLHGQC72S`。不能用新程序的静态签名替代正在运行旧程序的身份校验。
- 用户明确选择“重启并验收”并回复“允许”后，已执行 `tern restart --json`。回执为 `running=true`、`windows=1`、`kept="its executable has not changed since it started"`；会话程序继续运行，新的窗口应用PID79787。旧路径问题已消失。
- 重启后 `launchDate` 仍为nil，但内核启动时间、可执行路径和运行签名均可读取。Apple SDK `NSRunningApplication.h:111` 明确说明未通过Launch Services启动的应用没有 `launchDate`；改用内核时间后真实probe与导航均通过。
- 本任务临时helper、复制的插件和诊断脚本已清理；已核对临时helper目录不存在。没有清理其他任务资源。

## 限制与状态

- 用户现有 `docs/codex-handoffs/2026-11-04-github-release-publishing.md` 修改原样保留。
- 未提交、未推送、未替换 `/Applications/OC Chan.app`，没有沿用旧任务的安装授权。
- Tern重启及本会话原生跳转已按本次明确授权完成；没有打开可见开发窗口，没有变更辅助功能授权或任何登录资料。
- 修复候选选择与进程启动身份，不放宽签名、不选择第一个歧义目标、不吞掉错误。已完成本轮修复及当前会话真实验收；跨空间/全屏及安装应用验收未执行。

## 后续操作边界

1. 用户要求提交/合并时，仅处理本次源码、测试、README、CI映射及本交接；保留无关handoff改动。
2. 用户要求安装时，通过仓库交付/安装流程构建并替换OC Chan；当前已安装应用尚未包含本轮源码改动，不能把源代码验收当成安装验收。
3. 将来出现新的原生跳转报错时，重新采集窗口/pane/PID及系统签名证据，不沿用这里的临时PID，也不机械重跑全部测试。

## 恢复提示

继续 `/Users/zixiaobowen/myProjects/oc-chan` 的 `fix/tern-navigation-candidates-20261108`。本轮修复完成：Swift选择器先排除后台/退出项；进程身份用内核启动时间代替CLI启动时为空的AppKit launchDate。81项定向检查、相关27项复测、typecheck、无头topology smoke通过。用户已授权且已完成Tern官方重启，旧程序路径问题已解除；生产TernNavigation.focus真实跳转本会话pane成功，约1068ms。临时资源已清理。未提交/推送/安装OC Chan，保留无关handoff修改。已通过且仍适用的检查不要重复跑。
