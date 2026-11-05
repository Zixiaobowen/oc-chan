# 2026-11-05 液态玻璃集成到 main

## 范围与位置

- 原仓库：`/Users/zvf003/ZStack/oc-chan`，保留原分支及其他任务的全部未提交修改。
- 独立集成 worktree：`/Users/zvf003/tmp/oc-chan-liquid-glass-main`，工作分支 `integrate/liquid-glass-main-20261105`，从 `origin/main@8ad1e92051afc2386f4f2bc52b8eb4bfb7ede975` 创建。
- 目标：按用户授权将液态玻璃和 arm64 导航程序 160 KiB 预算集成到 `main`、推送 GitHub，并更新本机正式应用。GitHub 默认分支仍为 `master`，没有修改仓库默认分支。
- 原目录混有插件、通知、采集、侧栏、安装包体积治理等并行修改；本次只移植玻璃、所需无头启动、原生构建及既有安装 hook，不整包带入其他子系统。

## 已实现

- 公共 AppKit `NSGlassEffectView`，每个窗口复用一个原生视图，0 时释放；不使用私有 API。0–100 整数强度默认 65，调节通透程度而非未公开的折射率。
- 侧栏、顶栏和托盘外层使用材质，数据区实色。减少透明度／增加对比度时停用并保留强度。
- 拖动预览、释放保存；键盘停顿 250ms 保存；Esc、失焦、隐藏和卸载取消。一个在途预览加一个可替换的最新请求，失败显式诊断，保存事务回滚，重试恢复焦点。
- 独立无头开发入口，隔离数据、输出、端口；不显示窗口、Dock、托盘或跨应用跳转。显式准备 Electron 锁定版本的二进制：当前 Electron 45.2.1 npm 包没有 postinstall，单独 `npm ci` 不会准备可执行文件。
- `afterPack` 编译目标架构的导航程序与玻璃模块。arm64 导航程序在编译后检查 163840 字节上限，读取 `docs/package-baseline.json`。本次没有移植源工作区尚未提交的完整包内容治理，基线其他历史测量不能代替本分支全包结果。
- 本机 pre-push 从提交快照打包、检查架构、签名、替换并启动应用；不从混合工作区打包。CI 同时覆盖 main/master，使用 macos-26 与 macos-26-intel，添加玻璃模块架构检查。

## 主要文件

- `src/native/liquid-glass.mm`、`src/main/liquid-glass.ts`、`src/main/index.ts`、`desktop-settings.ts`。
- `src/shared/settings.ts`、`src/main/settings.ts`、`settings.test.ts`、`src/preload/index.ts`。
- `src/renderer/src/LiquidGlassSetting.tsx`、`settings.tsx`、`SettingsView.tsx`、`SettingsSaveError.tsx`、`settings.css`、`styles.css`、`liquid-glass.css`。
- `scripts/build-glass.mjs`、`build-native.mjs`、`develop.mjs`、`install-local.mjs`、`install-local.test.mjs`、`.githooks/pre-push`。
- package/lock、electron-vite 配置、工作流、README、DESIGN、PRODUCT、包预算基线。

## 已运行与结果

- `npm ci --no-audit --no-fund`：成功。现有构建依赖包含弃用提示；未顺手升级依赖。
- `npm run typecheck`：通过。
- `node --import tsx --test src/main/settings.test.ts scripts/install-local.test.mjs`：19/19 通过；没有运行全仓测试。
- 工作流 YAML 解析通过；GitHub 官方 runner-images 已核对 macos-26 与 macos-26-intel 标签。
- `npm run dev -- --inspect`：真实隔离 Electron。初次因新 worktree 缺少 Electron 二进制而失败，接入官方安装入口后运行成功。RTK 包装缓冲输出导致监督服务 readiness 超时，已用真实 Electron PID 44637 的 Inspector/CDP 核对运行，未伪报 ready 回执。
- 原生能力可用；唯一窗口不可见、不可聚焦，Dock 不可见。拖动 65→100 时保存值仍为 65，Esc 取消后磁盘无文件；释放写入 100；Home 写入 0。
- 实际 IPC 拒绝 -1、101、小数、NaN、字符串和缺失参数。
- 临时同名目录造成真实写盘失败：显示路径冲突并恢复 0；清除故障后重试写入 100，焦点回滑杆。仅操作独立验收 profile。
- 注入预览 handler 单次失败：界面实色、显示诊断；重试恢复材质与滑杆焦点；handler 已还原。
- 仅在测试进程注入减少透明度属性/事件：控件禁用，已保存 100 保留，随后恢复；没有修改系统设置。
- 默认 1280×860 内容区、880×640 内容区的 200% 放大（440×320 CSS 视口）：无文档横向溢出，滑杆可滚动到达并用键盘从 65 保存为 64。浅色／深色均运行；保存 73 后重载仍为 73。
- 相同隐藏实例真实只读采集负载，各 5 秒/10 样本：0% 峰值 RSS 675.625 MiB、结束 611.078 MiB、平均 CPU 0.243%；100% 峰值 RSS 617.047 MiB、结束 615.438 MiB、平均 CPU 0.263%。均为四个 Electron 进程的指标合计，不包含 WindowServer，不据此声称性能提升。
- 浏览器和 Inspector 已释放，本任务 Electron PID 不存在，独立实例目录已删除；未关闭其他开发实例。
- 详细本地证据：`.impeccable/review/liquid-glass-main-2026-11-05.json`（忽略文件）；原功能更长压力记录仍在原工作区 `docs/codex-handoffs/2026-11-05-liquid-glass.md`。

## 交付阶段与限制

此文件记录提交前验收。最终提交、push、安装及 GitHub Actions 的实际回执在这些操作完成后追加到原工作区的 `docs/codex-handoffs/2026-11-05-liquid-glass.md`，不能从本文件的提交前状态推断操作结果。

无头验收不能证明可见原生折射效果、真实托盘交互、全屏/分屏、持续手拖缩放、系统辅助功能实际切换、VoiceOver、可见帧时间或 120Hz。没有长时压力结果。没有配置 Developer ID 或 Apple 公证。

## 后续动作

1. 仅暂存本 worktree 中属于该集成的文件并提交，快进本地 main。
2. 推送 main，核对 pre-push 独立快照构建、安装与启动回执；保留原应用个人配置。
3. 核验远端提交与 GitHub Actions 两个架构的构建结果。
4. 将最终交付回执写入原工作区交接；可见原生交互验收需要用户明确要求后进行。

## 恢复提示

继续 OC Chan 液态玻璃 main 集成。先读本文件和原工作区 docs/codex-handoffs/2026-11-05-liquid-glass.md 的后续交付记录。保留原目录所有并行改动；集成 worktree 在 /Users/zvf003/tmp/oc-chan-liquid-glass-main。用户已经授权 main 合并推送和本机更新，不要重复询问。类型检查、19项定向测试及真实无头玻璃交互已通过；根据实际 Git/安装/CI 回执继续剩余动作，不重复通过的检查，不开启可见开发窗口，不扩大到 Release 发布或其他部署。
