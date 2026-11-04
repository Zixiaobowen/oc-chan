# Hermes 定时任务状态修复交接

- 仓库：`/Users/zvf003/ZStack/oc-chan`。
- 工作分支：`master`。用户授权覆盖本地应用，已完成安装与已安装版验收；随后授权将本任务源码提交、推送到 GitHub。
- 目标：修复个人配置中的启用 Hermes 任务全部显示未知，准确区分当前调度状态与最近执行结果。
- 用户要求：先解释原因，随后明确要求“修吧”，之后要求“覆盖本地的occhan”和“提交推送到github”。不触发、暂停或改写 Hermes 任务。

## 已完成

原采集器将所有未停用的 Hermes 任务固定写成 `unknown`。本机 12 条 Hermes 任务中，9 条启用并 scheduled，3 条 paused。修复后开发构建与独立 macOS `.app` 都实际返回 9 条 waiting、3 条 disabled，`hermes-runtime` 来源为 ok。

新增 `src/main/collectors/hermes-runtime.ts`，读取白名单元数据、执行数据库及必要的 PID/启动时间：

- 有 running 执行记录、300 秒以内的非未来心跳、同一个存活进程的启动时间时标记运行中。使用 `ps` 的 UTC 启动时间和 Hermes 的百分之一秒指纹，允许其官方 2 秒漂移容差；排除僵尸。
- 确认没有在途执行或残留心跳的 enabled/scheduled 任务标记等待触发。暂停或完成配置标记停用，确证运行优先。
- claimed、过期或异常心跳、PID 复用、状态不识别、数据库不可读等保留未知，详情说明具体类型。缺失数据库不会新建一个数据库并伪造空历史。
- 最近执行结果与当前状态独立。优先当前任务的结果元数据；若执行数据库有更新的终态，则使用更新的终态。保留同次运行的投递失败，不把它显示成普通成功。不输出 error 正文、命令、prompt 或凭据。
- 读取数据库使用 Electron 自带 `node:sqlite`，在短时独立进程运行；没有新增依赖，也没有系统 SQLite 或 Python 的备用读取路径。执行前设 SQLite 8 MiB 堆预算、2 MiB 缓存、只读与 query_only，JS 老生代上限 32 MiB，输出上限 4 MiB，3 秒超时后强制结束。
- 每次最多 256 个任务、4096 条相关执行记录；超限明确报告不完整，不拿截断结果判断状态。OMP/Hermes 元数据采用分配前检查的 1 MiB 文件上限，读取期间文件增长报错。
- 与独立 launchd 查询并发，沿用 Monitor 的刷新合并与每 30 秒采样，没有新增后台订阅、持久缓存或定时器。

## 修改文件

- `src/main/collectors/hermes-runtime.ts`：新增有界、只读的 Hermes 运行证据采集与状态判定。
- `src/main/collectors/hermes-runtime.test.ts`：13 项行为及数据库边界测试。
- `src/main/collectors/schedules.ts`：接入 Hermes 运行采集、metadata 白名单和 bounded JSON 读取。
- `src/shared/types.ts`：新增状态原因及最近执行结果可选字段。
- `src/renderer/src/SchedulesView.tsx`：原详情中展示当前状态、最近执行结果、结果记录时间与未知原因，中英文齐全；未修改表格布局或 CSS。
- `src/renderer/src/components.tsx`：Hermes 运行来源名称和正常诊断翻译。
- `README.md`：状态规则、证据限制、资源预算、定向验证命令。
- 本交接。

工作区原本已有并行任务改动，包括 README、DESIGN、App、AgentsView、AgentTopology、styles 和 SidebarResizeHandle。任务过程中这些文件和默认应用产物仍有其他会话更新。没有回退或全量暂存；README 只插入本任务段落。首轮修复使用隔离构建与验证 profile；用户随后要求覆盖本地应用，本轮从完整最新工作区执行 `npm run package`，再替换 `/Applications/OC Chan.app`，包含同时存在的其它功能改动。

## 实际验证

- `node --import tsx --test src/main/collectors/hermes-runtime.test.ts`：最终 13/13 通过。真实临时 WAL 数据库、真实 `ps` 进程检查；覆盖新旧终态、时区顺序、PID 复用、未来/过期心跳、claimed、数据库缺失/损坏、超预算、带 SQL 字符的任务 ID、read-only 文件内容保持。
- `node --import tsx --test src/main/collectors/schedules.test.ts src/main/monitor.test.ts`：24/24 通过，含刷新合并与停止后的晚到采集不发布。相关共 37 项测试，不是全仓测试。
- `npm run typecheck`：通过。
- `electron-vite build --outDir /tmp/oc-chan-hermes-status-final`：最终前后端构建通过。
- `impeccable detect --json src/renderer/src/SchedulesView.tsx src/renderer/src/components.tsx`：`[]`。
- 本机 `collectSchedules()`：9 waiting、3 disabled，Hermes 运行来源 ok。
- 原生 Electron 窗口：实际点击任务范围、状态筛选、详情、Esc 返回；刷新、连续尺寸变化后保留个人范围、等待筛选、选中任务及详情焦点。
- 原生内容区尺寸：默认 1280×860、最小 880×640；最小窗口 200% 缩放对应 CSS 440×320；连续 sweep 880/920/959/961/1024/1280；原生全屏 CSS 2560×1440。检查无整页横向溢出。
- 中文浅色与英文深色最近执行成功/失败/无记录；隔离 IPC 验收数据覆盖长标题、长路径、未知原因与空列表。测试数据只进验证窗口，没有改个人任务文件。
- 打包后真实 `.app` 通过 preload/IPC 读取本机 Hermes 数据，9 waiting/3 disabled/source ok。实际查看“ZSvirt 运营日报”的等待触发、最近执行成功、结果时间与下次计划。

## 性能与资源证据

环境：本机 Apple Silicon、macOS 27.2、Electron 45.2.1 / Node 24.22.1，真实本机任务与其余采集器共同运行；同一台机器其他会话仍在工作，数字不是隔离基准。

- 同样的 20 次手动刷新（间隔约 500ms）：原构建平均 32.95ms；最终构建 75.50ms。新增约 42.55ms 来自独立 Electron/Node 进程启动与数据库查询；已与 launchd 并行，不阻塞主线程，也没有增加默认采样频率。不是性能优化声明。
- 该负载下 50 次进程树采样：原构建 RSS 峰值 841.94 MiB、CPU 均值 12.41%；最终构建峰值 775.23 MiB、CPU 均值 12.68%。不同运行轮次，不据此宣称节省内存。
- 250 轮 × 每轮 16 个并发 refresh 调用，共 4000 个请求：平均每轮 69.66ms，最慢 187.90ms。30 秒、150 次进程树采样峰值 884.61 MiB，CPU 均值 42.28%，最多观察到 13 个进程（包含应用本来的采集子进程）。无崩溃/OOM，状态及焦点保留。
- 后续 20 秒空闲采样 CPU 均值 3.29%、RSS 峰值 862.05 MiB。短测不能证明小时级持续运行无增长。
- 第一次主窗口 did-finish-load：原构建 205.48ms，最终构建 204.69ms；单次数据，不作启动优化结论。
- 应用包无新增依赖。最终 `app.asar` 36,344,011 bytes；同时存在的默认包 36,339,510 bytes，但默认包由并行任务生成，不是严格同源基线。完整独立包约 292.7 MiB；与默认包差约 5.25 MiB 主要因为下载的 Electron 分发带 Chromium LICENSE 文件和语言资源，不能归因于本次源码。

## 产物与已处理失败

已安装产物：`/Applications/OC Chan.app`，对应本轮最新 `release/mac-arm64/OC Chan.app`。首轮隔离验证产物仍在 `release/hermes-status/mac-arm64/OC Chan.app`。未签名/未公证，与项目现有策略一致。本地未生成 DMG/ZIP，未发布安装包。

证据：`release/hermes-status/verification/results.json`、`release/hermes-status/verification/packaged-details.png`、`release/hermes-status/verification/installed-details.png`。不额外生成 HTML 回执。

排查中 macOS `/usr/bin/sqlite3` 的只读读取在 Hermes WAL/sidecar 变化时返回 SQLite 14。显式 URI 曾短暂成功，但独立复测仍失败；已彻底移除该方案，改用打包 Electron 内置 SQLite，在最终 `.app` 中验证。

electron-builder 不允许从项目外的 `/tmp` 打包资源。曾失败两次，改为将最终构建暂存到项目内 `release/hermes-status-build` 后成功，验证后移除暂存。没有关闭其安全检查。

Browser screenshot helper 曾返回另一个 OC Chan 原生窗口，已报工具问题；视觉证据使用绑定到确切 CDP page 的 `Page.captureScreenshot`。首轮独立验收没有关闭用户应用；用户授权覆盖后，先正常退出旧版再完整替换应用包，完成已安装版验收后以普通方式重新打开。

## 本地覆盖与已安装版验收

- 按用户“覆盖本地的occhan”授权执行。`npm run package` 成功，包含 TypeScript 检查、原生辅助程序构建、Electron 前后端构建和 arm64 应用打包。没有重复运行此前已通过且仍适用的 37 项测试或扩大到全仓测试。
- 旧版进程 1413 经 AppleScript quit 正常退出，完整新包暂存后更换 `/Applications/OC Chan.app`；没有合并旧包残留文件，也没有触碰用户配置目录。
- 新包与安装包 `app.asar` SHA-256 一致：`5f0e3f5ebce35839022523ee3150d945ee88086c1c2ea9c6fb99a98b0344c796`。
- `~/Library/Application Support/OC Chan/settings.json` 替换前后 SHA-256 均为 `b47284ace35af36e8517f6252e9f4d3d2767caf36a564e2cf0f4a48234e8a64c`，原有中文、较大文字、Menlo 代码字体、托盘与防休眠等设置未变。
- 使用原用户配置启动 `/Applications/OC Chan.app`，实际 preload/IPC 刷新返回 9 waiting、3 disabled，`hermes-runtime` 来源 ok、采集错误 null。真实窗口点击个人任务筛选和“ZVF 个人日报”详情，显示等待触发、暂无执行记录、下次计划；内容区 1280×860，无整页横向溢出。截图在 `installed-details.png`。
- 结束临时 9441 端口调试验收，验收进程正常退出码 0。通过 AppleScript activate 普通重启后返回 running=true；进程 28975、父进程 1、命令为 `/Applications/OC Chan.app/Contents/MacOS/OC Chan`，没有调试参数。应用保留运行供用户使用。

## GitHub 源码交付范围

- 目标为 `Zixiaobowen/oc-chan` 的 `master`；使用现场核对的 GitHub 账号 `Zixiaobowen` 与 gh 凭据，Git 作者为 `bowen.sun <bowen.sun@zstack.io>`。
- 提交 Hermes runtime、定时任务采集接入、状态类型、任务详情、来源翻译、13 项测试、本交接，以及 README 中两段 Hermes 说明和定向测试命令。
- 侧栏和协作拓扑的并行改动仍保留在工作区；README 按段落暂存，未使用全量暂存。此前安装包包含当时完整工作区，源码提交范围限于本任务。
- 沿用已通过的 37 项定向测试、最新 `npm run package` 和已安装版验收证据。本轮没有重复测试或执行全仓测试；推送后由现有 Build macOS 工作流构建 arm64/x64 产物，不创建 Release。
- 提交标识和推送结果以 Git 提交历史、远程 master 回读为准。

## 限制与下一步

- 未强制触发用户的生产 Hermes 任务；运行中判定通过真实测试进程+临时 WAL 数据库验证，生产窗口观察到的是等待/停用及已完成历史。
- 未做小时级/隔夜内存测试、系统原生 Split View 手动拖拽、多硬件缩放验证。短时压力证明仅限上述负载。
- 本来存在的 system launchctl 状态解析失败和系统日历 Second 扩展提示仍在，非此次个人 Hermes 状态问题，不扩大修复范围。

后续具体动作：

1. 若要验证生产运行中状态，在用户自然运行的 Hermes 任务期间观察并记录 heartbeat、PID、启动时间及 UI，不自行触发有副作用的任务。
2. 若继续资源验收，按相同采集负载记录小时级进程树 RSS 曲线，保留现有预算，不通过加堆或忽略错误解决。
3. 后续提交继续逐块检查 README/shared types/components 与并行改动的归属，只暂存对应任务的范围；此次源码推送不包含发布授权。

恢复提示：

> 在 oc-chan 继续 Hermes 定时任务状态工作。先读本交接。修复和 37 项定向测试、真实原生窗口、独立 macOS 包均已通过。用户要求覆盖本地应用后，已用最新完整源码重新打包并安装到 /Applications/OC Chan.app，已安装版验收显示 9 waiting/3 disabled，原设置文件哈希未变；应用现以普通方式运行，无调试参数。用户随后授权提交推送，源码范围为 Hermes 修复、测试及对应说明，侧栏与协作拓扑并行改动保留；核对当前 Git 与 GitHub master 获取实际交付状态。不要重新把 scheduled 简单等同于运行证据，不要读取/展示任务 prompt、命令或错误正文，不要改真实 Hermes 任务。
