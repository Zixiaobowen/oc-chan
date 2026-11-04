# GitHub Actions 构建与产物交接

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Remote：`https://github.com/Zixiaobowen/oc-chan.git`（私有仓库）
- Branch：`master`
- 目标：配置 GitHub CI，构建当前支持的 macOS 应用并提供可下载产物。

## 已完成

- 新增 `.github/workflows/build.yml`，由 `master` 推送、目标为 `master` 的 PR、`v*` 标签及手动操作触发。
- 使用 Node.js 24、锁文件安装和固定提交 SHA 的官方 checkout / setup-node / upload-artifact actions。
- `macos-15` 构建 arm64，`macos-15-intel` 构建 x64；Swift 原生导航程序与 Electron 同机同架构构建，上传前检查两者架构和原生程序执行权限。
- 新增 `npm run dist`，输出 `OC-Chan-<版本>-mac-<架构>.dmg`、`.zip`；生成并验证 `SHA256SUMS.txt`，上传产物保留 30 天。
- 只授予 `contents: read`，不保存 checkout 凭据；同一分支或 PR 的新任务取消旧任务，job 超时 30 分钟，两架构互不因对方失败而取消。
- 移除 `build.electronDist` 的本地目录绑定。干净安装证明原配置可能不存在 `node_modules/electron/dist` 并打包失败；改为 electron-builder 按锁定依赖版本获取 Electron 后完整打包通过。
- 已提交并推送实现：`d4e05316b1751d2c6a3362bf40ac8e7811c71b84`（`ci: build macOS distributions and upload artifacts`）。
- 首次云端运行 [41790194037](https://github.com/Zixiaobowen/oc-chan/actions/runs/41790194037)：两架构均成功打包，但 runner 的 Xcode 16.4 `lipo` 将 `-verify_arch` 后的文件路径当成架构名，导致上传前校验失败。调整为 `lipo <文件> -verify_arch <架构>`，没有删除或跳过检查。
- 修正已提交并推送：`08f70a3bf26bda7dcf6dc2bd2a01b14e8547c67e`；本地定向架构检查和 actionlint 均再次通过。云端运行 [41790811125](https://github.com/Zixiaobowen/oc-chan/actions/runs/41790811125) 已成功，两种架构的安装、构建、架构校验、SHA-256 校验及上传步骤均通过。

## 相关文件

- 修改：`.github/workflows/build.yml`、`package.json`、`README.md`、本交接。
- 调查：`scripts/build-native.mjs`、`src/main/tern-present.swift`、`electron.vite.config.ts`、`package-lock.json`、`.gitignore`。
- 依赖锁文件未改变；没有新增应用运行时依赖。

## 实际验证

在任务专用临时目录中，从 Git 快照复制源码并叠加配置变更，未替换工作区现有 node_modules 或 release 应用。

- `npm ci --no-audit --no-fund`：通过。
- `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist -- --arm64`：修复 electronDist 后通过，包含 TypeScript 检查、Swift 编译、electron-vite 构建和 DMG / ZIP 打包。
- actionlint 1.7.12：`.github/workflows/build.yml` 语法、表达式及 job 检查通过；未启用外部 shellcheck / pyflakes。
- 直接执行工作流中的 packaged-application 和 checksums 步骤：通过；Electron 与 Swift 程序均为 arm64，DMG / ZIP SHA-256 一致。
- `hdiutil verify`：本地 DMG 完整性通过。
- `ditto -x -k`：本地应用 ZIP 解压通过；解压后用 `ELECTRON_RUN_AS_NODE=1` 运行应用内 Electron，输出版本 `45.2.1`、架构 `arm64`、平台 `darwin`。
- 检查 app.asar：包含 main / preload / renderer 入口，不包含项目 src、scripts、docs、.github、.git、.impeccable。
- 未运行全仓测试；本次只改构建和分发配置。未宣称 GUI 功能、安装到 Applications 或 Gatekeeper 验收通过。
- 云端 arm64 job：`126443501587`，成功，07:13:55–07:15:12 UTC；x64 job：`126443501369`，成功，07:13:57–07:19:59 UTC。
- 已确认 Actions 产物 `oc-chan-macos-arm64-2`（ID `13303461520`，247,023,750 bytes）与 `oc-chan-macos-x64-2`（ID `13303377628`，255,231,716 bytes）均存在且未过期，保留至 2026-12-04。
- 本机意外中断恢复后，已核对原后台监听不再运行，无本会话待恢复子代理。新增的 DESIGN.md、README.md、App.tsx、styles.css、SidebarResizeHandle.tsx 和侧栏交接是其它工作，保留，未暂存到本次提交。
- 远端 ZIP 目录及清单验收通过：使用 HTTP Range 读取两份产物的 ZIP 中央目录及 `SHA256SUMS.txt`，校验清单文件的 CRC，确认各自只包含对应架构的 DMG、应用 ZIP 和校验清单，清单中的文件名与实际目录一致。此检查不等同于完整下载后重新计算 DMG / ZIP 的 SHA-256。
- 本机整包下载未完成：`gh run download` 报 `unexpected EOF`；直接连接和使用已有系统代理的续传均超时。云端的完整 SHA-256 校验已通过，但未宣称本机对云端整包进行了完整下载验收。未修改全局网络设置。
- 已验证的远端内容：arm64 DMG `125,346,273` bytes、ZIP `121,676,851` bytes；x64 DMG `129,458,547` bytes、ZIP `125,772,555` bytes。

## 边界与限制

- 保留当前 macOS 范围，不增加 Windows / Linux 构建。
- 沿用未配置 Developer ID 签名和 Apple 公证的设置；用户从 GitHub 下载后首次启动可能受 Gatekeeper 限制。
- 工作流不创建 GitHub Release、不部署应用；`--publish never` 明确禁止打包器发布。
- 私有仓库下载需要仓库权限；macOS runner 消耗账号 Actions 额度。
- 用户要求主要是构建和产物输出；不要额外引入自动更新、发布服务或第三方依赖。

## 后续使用

原始任务已完成：工作流配置、双架构云端构建及产物输出均成功，无构建阻塞。本机整包下载的网络限制见上文。

1. 从 run `41790811125` 的 Artifacts 下载对应架构产物，解压外层 ZIP 后运行 `shasum -a 256 -c SHA256SUMS.txt`。
2. 需要新产物时，从 Actions → Build macOS → Run workflow 手动运行；正常推送 master、PR 或版本标签也会触发。
3. 后续排查失败时优先查看具体 job / step 的日志，保留架构与校验值检查，不用重跑已成功的本次构建。

## 恢复提示

> 在 `/Users/zvf003/ZStack/oc-chan` 继续工作。GitHub CI 已完成，实现和 lipo 修正提交为 d4e0531、08f70a3；run 41790811125 的 arm64 / x64 构建与产物上传均成功，远端文件目录和校验清单已验收。不要重新创建工作流或重跑已通过检查。本机整包下载因网络超时未完成，未做云端整包本地 SHA-256 复核。保持 unsigned / no notarization / no Release 范围，并保留侧栏任务等用户与并行工作区改动。
