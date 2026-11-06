# 2026-11-04 不抢焦点的无头开发模式

- Repo：`/Users/zvf003/ZStack/oc-chan`；承接前一阶段 `main` 分支上的未提交工作，没有切换分支、提交或推送。
- 用户问题：多个开发实例会抢焦点，打断正常电脑操作；希望有无头开发方式。
- 目标：默认开发启动、并行实例、热重载和设置更新都不激活 macOS 前台，保留真实 Electron、采集、IPC、渲染与可截图能力。

## 已完成

- `npm run dev` 改为 `node scripts/develop.mjs`，默认无头。需要原生窗口时显式使用 `npm run dev:window`；`npm run dev -- --inspect` 增加动态端口的 Node Inspector。
- 新启动器每次创建 `.dev-instances/instance-*`，隔离 userData、sessionData、日志、构建输出和 Vite 缓存。Vite HTTP、CDP 与可选 Inspector 使用系统分配端口；实例目录位于仓库内，编译后的主进程仍可正常解析已有 node_modules。
- 子进程使用独立进程组；正常退出及 Ctrl+C 结束本实例后检查子进程退出并清理其临时目录。超时或仍存活的进程会明确报错；不会删除正在使用的目录，也不触碰其他任务的实例。
- 无头模式设置 macOS activation policy 为 `prohibited`，两个真实 BrowserWindow 均保持隐藏、不可聚焦，不创建原生托盘或应用菜单；主进程热重载仍沿用独立配置目录。
- 启动、activate、second-instance 与设置更新都受模式约束。无头设置初始关闭 Dock 和防休眠；尝试开启时明确返回错误。原生主窗口打开与跨应用 Tern 跳转明确拒绝，启动/退出错误写终端而不弹抢焦点的原生错误框。
- 可见模式中，设置更新仅在窗口原本聚焦时恢复 focus；原本未聚焦则使用 `showInactive()`。
- README 写明开发入口、能力边界和清理语义；AGENTS 增加自动化默认无头的项目规则。
- 正式安装应用未替换、未停止；其他并行任务的源码、配置和实例均保留。

## 修改与调查文件

- 修改：`scripts/develop.mjs`（新增）、`src/main/index.ts`、`src/main/desktop-settings.ts`、`electron.vite.config.ts`、`package.json`、`.gitignore`、`README.md`、`AGENTS.md`。
- 调查：`src/shared/settings.ts`、`src/preload/index.ts`、`src/main/settings.ts`，以及已安装 electron-vite 的 CLI、输出目录解析、watch/restart 与信号处理实现。
- `DesktopSettings` 的 LSP references 查询报告没有可用语言服务器，随后使用当前文件搜索确认唯一构造调用在 main/index.ts，已同步更新。
- 保留 main/index.ts 中其他任务增加的 schedule-history、themes 等代码，以及 README 的并行改动。

## 实际验证

- `npm run typecheck` 通过。
- `npm exec -- tsx --test src/main/settings.test.ts`：10/10 通过，未运行全仓测试。
- 两个实例同时运行约 10 分钟：实例 A 为 `instance-jGcFR1`，实例 B 为 `instance-29qJcf`。分别通过直接 Node 启动器和 `npm run dev -- --inspect` 启动，HTTP / CDP / Inspector 端口均不同，配置与构建目录不同。
- 通过真实 Electron Node Inspector 检查：两实例各有主窗口、托盘渲染窗口，全部 `isVisible=false`、`isFocused=false`、`isFocusable=false`；`app.dock.isVisible=false`，应用菜单为 null。
- 浏览器通过 CDP 接管隐藏页面，完成导航、深色设置操作及截图。A 保存深色，B 仍为 system，证明配置未串用。
- 真实 IPC 校验：开启 Dock、防休眠、显示主窗口、跨应用跳转均明确拒绝；拒绝后原生设置仍为 false；agents / schedules / system 的采集快照可正常读取，检查时 error 均为 null。
- 只更新 `src/main/desktop-settings.ts` 的 mtime 触发两个主进程实际热重载，源文件内容未变。旧 PID 35069 / 36017 退出，新 PID 59096 / 59097 启动；A 的深色配置保留，窗口仍隐藏。额外触发 activate 与 second-instance 事件，仍未出现可见窗口或 Dock。
- 原生 AppKit 前台事件观察约 11 分钟，本次上述四个 Electron PID 未出现在激活事件中。记录中存在其他应用、正式安装版及旧开发实例的切换，不能将这些事件归因于本次无头模式。观察器及其 `/tmp` 源码已经停止并清理。
- 热重载后 10 次真实 `monitor.snapshot()` IPC 耗时为 1.9–2.8 ms。
- 两个 Electron 进程树各含 5 个进程；29.914 秒、30 次 RSS 采样的同时峰值合计 1607.359375 MiB，无进程退出或 OOM。该数字不包含 Vite / Node 开发服务器，不是长期内存上限证明。
- 采样前记录了既有可见开发进程的资源快照，但它们使用不同构建方式且本仓库同时有其他代码变化，不能作为严格的性能提升或退化结论。没有重新启动可见窗口来制造用户报告的抢焦点，也没有完整的同代码冷启动时间对照；未做长期运行或超大输入压力测试。
- A 通过 app.quit 正常退出，服务 exit 0；B 通过 Ctrl+C 中断，OMP 的 RTK/npm 包装报告 exit 1，完整日志确认已执行实例清理。随后 `ps` 对本任务 launcher / Vite / Electron PID 均无结果，两份本任务实例目录均已删除。
- 验收期间另一个任务创建了 `instance-Kuoe5d`；该目录不是本任务所有，未删除。不要因为 `.dev-instances` 非空就全量清理。
- 正式设置 `~/Library/Application Support/OC Chan/settings.json` SHA-256 仍为 `b47284ace35af36e8517f6252e9f4d3d2767caf36a564e2cf0f4a48234e8a64c`。
- 隐藏真实页面截图：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15c0cb2ff2ea0cca.webp`。

## 工具与验收限制

- OMP 将其中一条 `npm run dev` 命令包装为 `rtk npm run dev`，输出被缓冲，导致工具的 ready 正则等待超时；应用本身已启动。通过进程树、端口、真实页面和 Inspector 完成了验收；Ctrl+C 后完整启动/重载/清理日志被输出。启动常驻验收服务时可直接用 `node scripts/develop.mjs` 以获得实时日志。
- `tab.run` 内 `page.evaluate` 在该 Electron 页面看不到 contextBridge API，但直接 `tab.evaluate` 和主进程 `webContents.executeJavaScript` 可正常访问。已报告工具问题，并使用后两者完成真实 IPC 验收，没有增加应用兜底。
- 本次没有重新运行 `dev:window` 的原生交互验收，以避免再次打断用户。无头截图不能证明 Dock、托盘、原生焦点切换或可见动效质量。
- 新入口不会自动改变旧进程的运行模式。用户随后明确授权“除了正式应用，都改成无头”，已处理当前实例，结果见下方迁移记录；这不授权提交推送、覆盖正式安装或清理无关资料。

## 下一步

1. 后续自动化默认运行 `npm run dev`，需要 main Inspector 时追加 `-- --inspect`。
2. 当前开发实例继续使用无头入口；不要使用裸 `electron out/main/index.js` 或 `npm start` 做无人值守验收。
3. 只有用户明确要求原生窗口交互时才运行 `npm run dev:window`。没有该要求时，报告原生交互验收限制，不自行打开可见开发窗口。
4. 获得提交授权后，仅暂存本任务范围中的文件或改动块；保留其他任务的已暂存和未提交内容。

## 恢复提示

继续 oc-chan 的无头开发工作。默认 npm run dev 已实现、两实例真实启动/IPC/截图/主进程热重载/非激活状态/退出清理均已验证，类型检查及 10 项设置测试通过。用户已明确要求除正式应用外全部无头，当前实例已处理，见下方记录。先看本 handoff 和现有源码；不要重复启动可见实例，也不要全量删除 .dev-instances。只有用户明确要求原生窗口交互时才允许 dev:window；当前授权不包含提交推送或覆盖正式安装。

## 用户授权后的现有实例迁移

- 用户要求：除 `/Applications/OC Chan.app` 正式应用外，所有开发实例改为无头。`AGENTS.md` 第 7 节已明确只有用户主动要求原生窗口交互时才可使用 `dev:window`。
- 旧普通实例 PID 3526 使用 `/tmp/oc-chan-schedule-details-1793783933011/final-profile`。已保存配置和页面状态到同目录上一级的 `headless-migration-20261104.json`，原配置目录保留。替代实例恢复深色 GitHub 主题、中文、筛选条件和“定时任务 → 通用 MR 请求队列”详情；Dock 与防休眠保持关闭。
- 替代服务 `occhan-schedule-headless` 以持久服务运行，启动命令 `node scripts/develop.mjs --inspect`；本次验收主进程 PID 7895，实例目录 `.dev-instances/instance-vbt4w7`，渲染地址 `http://127.0.0.1:49308/`，main Inspector 端口 49337、renderer CDP 端口 49338。热重载后 PID 和调试端口可能改变，以服务日志为准。
- 旧实例调用 `app.quit()` 后仍有调试连接并未退出，随后向该开发进程发送 SIGTERM。实际确认旧主进程 3526 及其启动进程 3521 均已结束，未停止正式应用。
- 核对期间另一个任务启动过可见实例 PID 9552；它随后由该任务退出并改为无头实例 PID 24115，启动器为 `node scripts/develop.mjs`，renderer CDP 端口 50392。我方为迁移额外准备的实例 PID 27061 / 服务 `occhan-theme-headless` 已正常退出，服务回执 exit 0，没有保留多余实例。
- 最终现场检查时间 `2026-11-04T10:16:35.301Z`：开发主进程仅 7895、24115，均由 macOS `NSRunningApplication` 返回 `activationPolicy = 2`（禁止激活）、`active = false`。PID 7895 另经 Electron Inspector 验证主窗口和托盘窗口均不可见、不可聚焦，Dock 隐藏；两个开发实例的真实渲染页面均可通过 CDP 访问。
- 正式应用仍为原 PID 76802、路径 `/Applications/OC Chan.app`，`activationPolicy = 0`，保留正常应用模式。本阶段未修改其个人配置、未重启或重新安装它。
- 本阶段只迁移现有进程并更新工作约定与交接，没有修改业务代码或重跑已通过的类型检查、单元测试；未重新验证可见窗口动效或长期压力场景。
