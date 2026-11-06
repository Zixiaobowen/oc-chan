# 安装包重复依赖清理交接（2026-11-05）

## 仓库、分支与目标

- Repo：`/Users/zvf003/ZStack/oc-chan`；本次独立 worktree：`/Users/zvf003/tmp/oc-chan-liquid-glass-main`。
- Branch：`fix/package-runtime-dependencies-20261105`，基于 `main` 的 `45f6b5e63da17aa7fa01793eac7573586e5c53e6`。
- 用户要求：修复重复依赖打包，回测后向 GitHub 提 PR。原工作区并行改动不带入本分支。
- PR 定位：`gh pr view fix/package-runtime-dependencies-20261105`；目标分支为 `main`。本次不合并、不发 Release。

## 已完成

- 将已由 Vite 编译进页面的 React、React DOM、Lucide、React Flow、Dagre 移至 `devDependencies`，同步锁文件；主进程继续保留真实需要的 `systeminformation`。
- 复用原工作区现有许可证生成器，按实际构建输出保留前端直接与传递依赖的版本清单和完整许可证正文。
- `afterPack` 检查 ASAR 3 MiB 上限、仅有的运行时依赖、运行入口、开发文件排除、许可证和锁文件一致性；失败阻止产物发布。
- 新增 `npm run dev -- --packaged-app=<.app路径>`：在隔离、隐藏、不可聚焦的 Electron 中直接加载打包后的代码与资源，退出清理实例。常规开发入口仍沿用现有行为。
- CI 增加包内容及直接受影响的采集、拓扑测试，保留设置与安装事务测试。README 已说明打包策略、边界和回测入口。

## 调查与改动文件

`package.json`、`package-lock.json`、`electron.vite.config.ts`、`scripts/bundled-licenses.ts`、`scripts/check-package.mjs`、`scripts/check-package.test.mjs`、`scripts/build-native.mjs`、`scripts/develop.mjs`、`.github/workflows/build.yml`、`README.md`。

调查了 `src/main/index.ts` 的隔离配置和 IPC、`src/preload/index.ts` 的真实桥接、`scripts/install-local.mjs` 的提交快照安装事务，以及 `@electron/asar` 的写流结束语义。

## 实测体积

同一台 arm64 macOS、Electron 45.2.1、相同打包配置；MB = 1,000,000 字节。`.app` 为包内常规文件大小之和，不计目录和软链接。

| 产物 | 修改前（字节） | 修改后（字节） | 减少（字节） |
| --- | ---: | ---: | ---: |
| .app | 306122856 | 271891482 | 34231374 |
| app.asar | 36408170 | 2176796 | 34231374 |
| ZIP | 121704597 | 117403705 | 4300892 |
| DMG | 125396575 | 120896784 | 4499791 |

主进程、preload、页面 HTML、JS 和 CSS 的 SHA-256 前后一致；运行时代码未变化，新增输出仅为许可证资料。下载体积仍超过 100 MB，Electron 运行时仍占主要部分。本次不宣称启动速度、CPU、内存或动画性能提升。

## 已运行的验证

- `node --import tsx --test scripts/check-package.test.mjs src/main/settings.test.ts scripts/install-local.test.mjs src/renderer/src/agent-topology.test.ts src/main/collectors/system.test.ts`：初次 43/44 通过。包内容正例因测试夹具在 ASAR 写流结束前读取失败；通过 `finished(await asar.createPackage(...))` 修正，未放宽检查。
- 修正后 `node --test scripts/check-package.test.mjs`：5/5 通过。覆盖正确产物、重复前端依赖、采集器入口/版本、许可证丢失/漂移、开发文件和体积上限。其余 39 项已通过且代码未再变化，未重复运行；未运行全仓测试。
- `npm run dist -- --arm64 --config.directories.output=.impeccable/review/package-slimming-2026-11-05/after`：类型检查、前后端构建、原生模块构建、DMG/ZIP 打包通过；ASAR 2176796/3145728 字节，导航 helper 87136/163840 字节。此前运行时入口检查未规范化 `./lib/index.js` 导致构建失败，已按正常路径语义修正。
- `npm run dev -- --packaged-app=".impeccable/review/package-slimming-2026-11-05/after/mac-arm64/OC Chan.app" --inspect`：真实无头 Electron 中加载包内主进程、preload、页面、`systeminformation` 和 `.node` 玻璃模块。主窗口隐藏且不可聚焦，数据目录独立。
- 实际 UI：概览、协作拓扑及缩放/适应全部、系统监控刷新、定时任务页面、玻璃滑块 100% 保存/重载保持/0% 关闭通过。真实系统采集返回 16 核、128 GiB 内存及进程记录，无采集错误；浏览器错误记录为空。
- `unzip -tq <after.zip>`：压缩数据无错误。`hdiutil verify <after.dmg>`：VALID。
- 实例主动 SIGTERM 后，退出码 143 为预期；实例目录和该任务进程树均已消失。其它开发任务未停止或清理。
- GitHub CI 状态、提交、推送及本机 hook 安装结果以 PR、命令回执和最终交付为准，本文件不将本地构建等同于云端或已安装应用验收。

本机证据：`.impeccable/review/package-slimming-2026-11-05/comparison.json`、`smoke.json`，以及该目录下 `before/`、`after/` 的真实产物。这些大文件保持忽略，不进入 Git。

## 风险、限制与用户约束

- 回测使用同版本 Electron 加载实际包内容，但 `app.isPackaged=false`；不能替代正式安装流程、Dock、托盘、桌面背景玻璃、全屏/分屏或可见动画验收。
- 本地只构建 arm64；x64 由 PR 的 Intel CI 验证。未做长时资源压力验证；本次没有修改采集、IPC、渲染或资源管理实现。
- 服务就绪日志被当前工具注入的 `rtk npm` 包装器滞留；已通过真实进程树及监听端口定位，并向工具问题接口报告。没有更改项目代码来隐藏此工具问题。
- 保留原工作区所有并行改动。遵守无头开发入口；未执行任何定时任务、跨应用跳转或外发消息。
- 本仓库已启用 `.githooks/pre-push`。分支推送会从提交快照构建、校验并替换本机应用，不读取未提交源码；个人配置保留。不要绕过既有 hook。

## 后续动作

1. 通过 `gh pr view fix/package-runtime-dependencies-20261105 --json url,headRefOid,statusCheckRollup` 取得 PR 的最新状态和精确提交。
2. 审阅依赖分类、许可证内容和包体约束；确认两个架构的 CI 产物及校验和。
3. 需要合并或发布时先取得对应授权；如要求可见原生交互，再按仓库规则执行正式应用验收。

## 恢复提示

继续 OC Chan 安装包重复依赖清理任务。工作分支 `fix/package-runtime-dependencies-20261105`，独立 worktree `/Users/zvf003/tmp/oc-chan-liquid-glass-main`；先读取本交接并查询 PR 最新状态。用户授权修复、回测及创建 PR，未授权合并或 Release。已通过的本地检查不重复。保留 `/Users/zvf003/ZStack/oc-chan` 的并行改动。体积和无头真实应用证据在本交接指定的忽略目录中。
