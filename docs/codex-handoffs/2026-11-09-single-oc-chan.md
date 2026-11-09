# OC Chan 单一正式安装与调试资源清理

- 日期：2026-11-09
- Repo／main 工作区：`/Users/zixiaobowen/myProjects/oc-chan-single-app-20261109`。原目录 `/Users/zixiaobowen/myProjects/oc-chan` 与旧主线工作区均保留并行插件市场任务。
- Branch：`main`；功能提交 `28b7ad4`，合并交付提交 `398e32d` 已实际推送 GitHub main。
- 当前目标已完成：本机正式应用保留 `/Applications/OC Chan.app`；对应任务合并并实际推送 GitHub 后，回收其临时应用和有归属的开发实例。
- 用户明确授权“合并到main并push”。本次没有重新安装正式应用、发布版本或部署；各阶段证据与最终回执见文末。

## 已完成

已精确注销并删除以下四份额外应用；未删除它们所属的源码工作区：

- `oc-chan-main-integration-20261106/release/mac-arm64/OC Chan.app`
- `oc-chan-update-mechanism-20261108/release/update-source-20261108-verified/mac-arm64/OC Chan.app`
- `oc-chan-update-mechanism-20261108/release/local-update-repair-20261108/mac-arm64/OC Chan.app`
- `oc-chan-update-mechanism-20261108/release/local-update-repair-verified-20261108/mac-arm64/OC Chan.app`

以上路径均位于 `/Users/zixiaobowen/myProjects/`。最终文件枚举与 Spotlight 索引均只返回 `/Applications/OC Chan.app`；NSWorkspace 返回运行 PID `79518`，bundle 路径为正式安装。清理前后正式应用 `settings.json` SHA-256 相同。

实现与规则：

- `AGENTS.md` 第 8 节规定单一正式安装、成功安装后的源包回收，以及合并推送后的任务级清理。
- `scripts/local-app-lifecycle.mjs` 提供 `registerDevelopmentInstance`、`cleanupBuildApplication`、`cleanupLocalWorktree` 和默认只读 CLI。仅处理同仓库登记工作区中的 `release/**/OC Chan.app` 与有 owner 记录的 `.dev-instances/instance-*`。
- 开发 owner 绑定 PID 启动时间、命令、cwd、Node executable；launcher 持续持有 owner 文件描述符，防止复制其他实例身份授权终止。停止前复核身份；等待 launcher 与子进程退出后删除。
- 应用校验 bundle ID、可执行文件名、Mach-O 和路径归属；拒绝活动应用、越界链接及身份变化。资源扫描与删除有数量、深度、字节和时间上限。
- `scripts/develop.mjs` 登记实例归属，沿用既有退出清理。
- `scripts/install-local.mjs` 在正式安装实际就绪后清理受管源应用，输出注销结果；自有 Git 源码快照由其原有 finally 回收。外部交付来源不在已登记工作区的 release 中时拒绝自动清理。
- `scripts/push-main.mjs` / `npm run push:main` 保留标准 Git hooks，先 push，再核对远端包含本次提交。只清理当前主线工作区和本次新合入的工作区；未合入、含未提交产品文件、此前已合入的其他工作区保留。Markdown 文档与 `docs/codex-handoffs/*.html` 回执可保留且不阻止清理；其他 HTML、JS、策略 JSON 仍按产品文件保护。清理失败与推送失败分别报告。
- `package.json` 增加 `cleanup:local`、`push:main`，扩展 `test:install`；`scripts/ci-tests.mjs` 同步定向测试映射；README 保留当前社区版结构，详细行为已随主线文档拆分迁入 `docs/development.md`。

## 根因与边界修正

最初的清理测试有 6 项失败：对从未登记的临时应用调用 `lsregister -u` 返回 exit 1 / `-10814`。SDK `LSConstants.h` 确认该状态为 `kLSApplicationNotFoundErr`。

NSWorkspace 的已安装应用 URL 列表会漏掉临时目录中确实登记的 bundle，不能据此断言未登记。独立实验观察到 `lsregister -f` 后 `-u` 成功，第二次 `-u` 才返回明确未找到。

最终实现始终对精确路径执行注销，只将 exit 1、空 stdout、包含该精确路径的已观察 `-10814` 完整诊断识别为 `not-registered`，并写入结果；注销成功为 `unregistered`。其他错误全部抛出并阻止删除，不依据宽泛错误码或失败重试猜测成功。已增加真实登记/注销测试，证明清理一个应用不会注销另一个应用。

## 验证

使用 Node `v24.22.1`（`/Users/zixiaobowen/.local/node-v24.22.1/bin/node`）。本次 shell 默认 Node 为 v22.23.4，未修改全局 Node 配置。

1. 首批定向命令：
   ```sh
   /Users/zixiaobowen/.local/node-v24.22.1/bin/node --import tsx --test scripts/install-local.test.mjs scripts/local-app-lifecycle.test.mjs scripts/push-main.test.mjs src/main/installation-check.test.ts scripts/ci-tests.test.mjs
   ```
   初次 67 项中 61 通过、6 失败；失败均为上述注销边界。安装器、就绪协议和 CI 选择器的 43 项通过且未受后续行为修改影响。
2. 修正后最终运行：
   ```sh
   /Users/zixiaobowen/.local/node-v24.22.1/bin/node --test scripts/local-app-lifecycle.test.mjs scripts/push-main.test.mjs
   ```
   25/25 通过。合计最终适用的 68 项不同定向用例通过。推送测试使用本地临时 bare Git 仓库及 Git URL 重写，无生产 GitHub 写入。
   随后补齐 HTML handoff 保留边界，单独重跑 `node --test scripts/push-main.test.mjs`，9/9 通过；其他已通过且仍适用的检查未重复。
3. `node --check scripts/install-local.mjs` 通过；最后变更仅增加源包清理结果日志。
4. `npm run cleanup:local` 实际执行成功，返回 `applications: []`、`instances: []`。npm 输出已有用户配置警告 `home`、`3005/`，本轮未改全局 npm 配置。
5. 真实无头 Electron smoke：4 次前后对照（原 launcher 2 次、新 launcher 2 次）和 3 个新实例并发；每次真实渲染、monitor IPC、32 个合成 Agent 就绪。所有窗口均不可见且不可聚焦；7 次运行全部正常回收进程组和实例目录。新实例通过真实 cleanup API 退出。验证脚本与原 launcher 临时副本已删除。

证据：`/private/tmp/oc-chan-single-app-20261109-NODbT6/result.json`，同目录保留每次 launcher 日志、配置和退出记录。临时 fixture 与登记实验应用均已清理。

硬件：Apple M5 Max、18 CPU、128 GiB 内存；Node 24.22.1；本轮 smoke 总时长约 63 秒。每 250ms 采样 launcher 及其完整子进程树的 RSS 和 ps CPU 估计，单实例预算 2 GiB，文件缓存为热缓存。L1 为 32 Agent 合成负载，实际断言渲染就绪、monitor 快照 IPC、Agent 数量、窗口无头属性和退出回收；未额外验收任务历史交互。

| 运行 | 启动 ms | IPC 往返 ms | 进程树峰值 MiB | 平均 CPU % | 清理 ms |
|---|---:|---:|---:|---:|---:|
| 变更前 1 | 2543 | 2.89 | 1273.59 | 34.64 | 250 |
| 变更前 2 | 1604 | 2.74 | 1281.75 | 37.75 | 349 |
| 变更后 1 | 1819 | 2.68 | 1290.30 | 34.76 | 1971 |
| 变更后 2 | 1834 | 2.88 | 1305.17 | 31.73 | 1981 |
| 并发 1 | 2445 | 2.61 | 1324.52 | 26.26 | 5658 |
| 并发 2 | 2405 | 2.82 | 1281.69 | 25.77 | 5933 |
| 并发 3 | 2404 | 2.71 | 1297.66 | 25.25 | 6204 |

前后 CPU 平均值包含整个采样窗口，新入口的清理时间包含预览及多次身份核验；并发清理计时共用起点，逐项记录完成时间。它们不是同一统计口径下的纯退出耗时。少量样本不用于声称性能提升。全部运行低于每实例 2 GiB 验收预算，未发生 OOM；未进行小时级/隔夜稳定性验证，也未验收 Dock、托盘、可见原生窗口或显示器刷新率。

未运行全仓测试、全量构建、正式应用重装或发布；本轮为本地生命周期工具变更。

## 保留范围与风险

- 源码 worktree、分支、未提交产品文件、个人设置与数据库、ZIP/DMG、交付日志/证据保留。
- 原有 `docs/codex-handoffs/2026-11-04-github-release-publishing.md` 改动，以及后来出现的 `2026-11-08-push-update-audit.md/.html` 属于用户或并行任务，本轮未修改。
- Git 没有本地 post-push hook。普通 `git push`、网页合并不会调用新入口；须遵守 AGENTS 的 `npm run push:main` 约定，其他入口完成推送后在对应任务工作区手动执行 `npm run cleanup:local -- --apply`。
- owner 不明、旧版本没有 owner 的实例、活动 bundle、不同 Node executable、符号链接越界或超预算时保留并报错，不能猜测归属。
- 注销工具的诊断格式变化时会失败保留；不把未知错误当作未登记。
- Node/macOS 没有本实现可直接使用的原子 pidfd/目录相对删除接口。多次复核能减少竞态，但不宣称抵御同 UID 恶意进程在最后系统调用间隙持续替换目标。

## 下一步

1. 后续修改继续保护并行插件市场任务、原有未提交交接文件及当前正式安装。
2. 今后从 main 使用 `npm run push:main`，读取推送确认与清理回执；自动安装 hook 当前未启用，不因推送擅自启用。
3. 如通过网页或其他客户端推送，先核对对应任务已合入远端，再到对应工作区预览与执行清理。
4. 遇到未知实例或活动 bundle 时先调查启动身份与任务归属，不扩大为全仓或按进程名删除。

恢复提示：

> OC Chan 单一正式安装任务已完成。读取 docs/codex-handoffs/2026-11-09-single-oc-chan.md 文末回执：功能提交 28b7ad4、合并交付提交 398e32d 已推送 GitHub main，定向测试和真实无头 Electron 验收通过。main 位于 oc-chan-single-app-20261109；原目录及 oc-chan-main-integration-20261106 均有并行插件市场任务，禁止覆盖其文件、索引和分支。不重新执行已通过且仍适用的检查，不擅自重新安装正式应用或启用自动安装 hook。按用户新的任务继续。

## 2026-11-09 合并准备与集成验证

- 用户已明确授权合并到 `main` 并 push。原目录已经切到并行的 `feat/plugin-marketplace-20261109`，另有 README 改动；本轮在 `oc-chan-single-app-20261109` 独立工作区提取清理功能，基于 `origin/main` 的 `3118aea` 集成，保留原目录全部状态。
- 远端已将开发文档从 README 拆入 `docs/development.md`，因此按现有结构同步清理说明；保留最新 Kubai 图标及系统监控插件拆分。
- Node 24.22.1 安装独立依赖后，安装器、清理、push-main、安装就绪协议与 CI 选择器共 68/68 用例通过。
- 真实 `npm run dev -- --inspect` 完成主进程/preload 编译、渲染和四域 monitor 快照 IPC；实际截图已核对。独立窗口 invisible/non-focusable、headless=1，用户数据位于自有实例目录。
- 首次退出暴露已存在的重复信号竞态：stop 已向进程组发送 SIGTERM，组长退出后 run 又向仍在退出的 Electron 子进程重复发信号，macOS 返回 EPERM。最终虽无残留，但启动器返回 1。修复为已请求停止时不再重复发信号，使用有界进程组成员表等待完全退出；真实权限失败仍报错。
- 新增真实 launcher + 异步退出子进程回归，验证仅收到一次信号、目录只在退出后删除；修复后 `node --test scripts/local-app-lifecycle.test.mjs` 为 17/17 通过，合计 69 项不同相关用例通过。其余已通过且仍适用的测试不重复。
- 修复后的真实 Electron 启动约 1605ms，renderer 与 IPC 可用；通过生产 cleanup CLI 发送 SIGTERM，launcher 退出码 143（有意停止），无“开发启动失败”、EPERM 或退出超时。再次核对本任务实例进程和目录均消失。该次在初次 Agent/任务采集完成前退出，不冒充全采集验收。
- 集成证据 `/tmp/oc-chan-merge-exit-20261109-lGXId6/result.json`、`fixed-1.log`；首次实际界面 `/var/folders/sw/0g6s73xd04n89bg0lympw6_40000gn/T/omp-sshots-15c773d80d0278bd.webp`。浏览器接管已释放。
- 当前仓库没有 `core.hooksPath`，默认 hooks 只有 sample；本轮不改 hook 配置、不重新安装正式应用、不部署或发布。

## 最新主线集成结果（推送前记录）

- 清理实现提交 `28b7ad405eafb9702e52cdf06a9cede4a51bf895`。集成期间远端新增 `269595c255fc122081b668f4cb762dd81457c775`（更新交付与公开发布源）；已保留它的 schema 2 交付校验源、SemVer 就绪检查、发布测试和 GitHub 发布源。
- 冲突仅在 `scripts/install-local.mjs`、`scripts/install-local.test.mjs`、`scripts/ci-tests.mjs`；组合本轮来源应用回收与上游新 `verifyDeliveryForInstall(directory)` 契约，保留两侧用例。
- 合并后的安装、安装就绪、CI 选择、交付源、交付包和包检查定向测试 156/156 通过。清理生命周期 17/17 已通过且代码未再变化；push-main 相关用例包含在前述 68 项通过记录中。未运行全仓库测试。
- 最终真实无头 Electron 验收：约 2268ms 得到 agents/schedules/events/system 四域真实数据，四域 error 均为 null；清理入口有意终止后退出 143，临时实例已删除，无退出报错。记录在 `/tmp/oc-chan-merge-exit-20261109-lGXId6/final-main.json` 和 `final-main.log`。
- `oc-chan-main-integration-20261106` 已被并行插件市场任务切到 `integrate/plugin-marketplace-20261109` 并处于冲突处理期间，禁止操作其分支、索引和文件。本轮在独立 `oc-chan-single-app-20261109` 工作区完成本地 main 快进与 push；不安装正式应用。
- 此段是推送前验证快照；实际推送回执见下节。不得继续使用上文旧主线工作区执行 merge 或 cleanup。

## 最终推送回执

- 第一次推送被 Git 以 non-fast-forward 拒绝，且清理入口未执行。原因是远端并行新增纯文档提交 `49496a6`；已核实仅三份交接文档变化，合入后没有重复运行仍适用的测试。
- 第二次 `npm run push:main` 成功：Git 回执 `49496a6..398e32d main -> main`；入口再次查询并验证 GitHub main 包含本次提交后才开始清理。
- 当前 main 工作区 `oc-chan-single-app-20261109` 清理成功；本任务真实开发实例、子进程及其临时目录均已退出或删除。
- `oc-chan` 因 HEAD 尚未合入远端而保留；`oc-chan-main-integration-20261106`、`oc-chan-update-main-20261109`、`oc-chan-update-mechanism-20261108` 因推送前已合入、不是本次新增任务而保留。没有删除 worktree、分支、个人配置或并行开发资料。
- 本轮没有执行安装器、发布器或部署命令。npm 输出本机既有 `home` / `3005/` 配置警告，推送及清理命令退出码为 0。
- 本节为实际推送后追加的文档回执；不改变已经验证的产品代码。
