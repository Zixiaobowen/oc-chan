# 2026-11-04 本机推送安装 hook

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：开始任务时为 `main`；实际验收提交为 `9fafc1539e943c6bf4ec5b82fd5aa3de829fbc02`。
- 目标：向本项目 GitHub 仓库推送 PR 分支时，自动构建并替换本机 `/Applications/OC Chan.app`，删除旧应用包、保留个人设置。

## 已完成

- 新增可执行 `.githooks/pre-push`，并执行 `npm run hooks:install` 将当前仓库的 `core.hooksPath` 设为 `.githooks`。
- 新增 `scripts/install-local.mjs`：识别本项目 GitHub HTTPS / SSH 远程地址，解析 Git 推送引用；从待推送提交导出独立源码快照，执行 `npm ci` 和现有 `npm run package`，隔离未提交改动。
- 校验应用标识、当前架构、原生导航程序和本地 ad-hoc 签名；使用安装锁与同卷暂存，在新包就绪后退出旧应用、整包替换并启动。成功后删除旧包；失败阻止推送，并还原旧包或明确保留失败现场。
- 支持 `npm run install:local` 手动构建当前工作目录（含未提交改动）。此模式和自动 hook 的构建来源不同。
- 新增 `scripts/install-local.test.mjs` 与 `npm run test:install`；README 已说明启用方式、触发范围、操作顺序、失败语义及 pre-push 先于网络上传。
- 不增加运行时依赖，不修改 GitHub Actions。当前未提交、未推送本次文件，也未创建 PR。

## 实际验证

- `npm run test:install`：9/9 通过。覆盖远程与引用筛选、多分支歧义、整包替换去除旧文件、个人设置保留、退出失败、启动失败还原、首次安装失败与还原失败保留双方应用。
- `git hook run --to-stdin=/tmp/oc-chan-pre-push-smoke-20261104.txt pre-push -- origin https://github.com/Zixiaobowen/oc-chan.git`：最终完整成功。输入指向提交 `9fafc1539e943c6bf4ec5b82fd5aa3de829fbc02`；执行快照 `npm ci`、TypeScript 检查、Swift 原生程序构建、Vite 构建、arm64 打包、安装签名与架构校验、退出原应用、替换并启动，启动 PID 为 63378。本命令仅执行本地 hook，没有向 GitHub 推送。
- 前两次真实验收发现并修复 JXA 无参数 Objective-C 方法调用和 NSWorkspace 状态缓存问题。现在按 PID 等待退出，并通过新的 NSWorkspace 查询获取启动状态；错误原因完整输出，不隐藏嵌套错误。最初的应用包已在失败后还原，再完成最终成功安装。
- 安装后的真实 macOS 应用（1280 × 860 CSS 内容区、2× 设备比例）通过 CDP 验证概览和系统监控页面切换、实时数据与截图；浏览器记录的 renderer errors 为空。截图位于 `/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15c0c52998d7363f.webp`。
- `~/Library/Application Support/OC Chan/settings.json` 更新前后 SHA-256 均为 `b47284ace35af36e8517f6252e9f4d3d2767caf36a564e2cf0f4a48234e8a64c`。
- 验收用调试进程已正常退出，CDP 接管已释放，应用经 LaunchServices 普通方式重新打开。本次失败验收暂存包和临时引用输入已清理。
- 未运行全仓测试。Intel 路径未在本机实测；真实 macOS 的崩溃还原未故意注入故障，事务失败行为由真实文件系统上的定向测试覆盖。

## 已知失败、边界与限制

- `npm run install:local` 对任务期间的当前工作目录构建失败：`src/preload/index.ts(5,7): TS2739`，`MonitorApi` 新增 `scheduleHistory`、`cancelScheduleHistory`，preload 实现尚未补齐。该错误来自并行工作，未修改相关文件、未重复运行以确认错误。构建阶段即停止，没有动到已经安装并验收的提交版本。
- 因此当前安装的是上述已提交版本，不包含本轮工作目录中的未提交 UI / 调度改动。
- pre-push 在网络上传前运行；本机更新成功不表示 GitHub 推送成功，也不表示 PR 创建或合并成功。仅网页创建 PR、本地 commit、仅标签/删除/无新引用的推送不会安装。
- 现有未提交改动与暂存区属于用户或并行任务，均保留；未全量暂存、重置或清理。
- 用户授权本次替换并删除旧应用包，不授权清理个人配置、日志或其他应用。

## 下一步

1. 并行任务完成 `MonitorApi` 与 preload 实现后，如需要未提交版本，再运行 `npm run install:local`。
2. 按本次范围审阅 `.githooks/pre-push`、`scripts/install-local.mjs`、`scripts/install-local.test.mjs`、`package.json` 和 README 新增段落，保留其他改动块。
3. 获得提交授权后仅暂存本次改动；正常推送分支时 hook 会自动运行。无需另做 GitHub Actions 本机安装步骤。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan` 的本机推送安装 hook 工作。先读本 handoff 和当前文件；hook 已在本地启用，自动快照构建、应用替换及原生窗口验收通过。不要把当前已安装应用当成包含未提交改动；当前目录曾因并行的 scheduleHistory / cancelScheduleHistory preload 接口缺失而构建失败，依据新证据决定是否重试。保留其他任务的未提交和已暂存修改；没有授权提交、推送、创建 PR 或删除个人数据。
