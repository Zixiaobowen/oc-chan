# 开发与验证

[返回首页](../README.md)

命令和路径均相对仓库根目录。后台、桌面宿主与界面均使用 Rust，`crates/oc-desktop` 使用 GPUI / Metal 和原生拓扑画布。Node 仅用于构建编排、开发与验收工具；没有前端打包步骤。

## 运行

需要 Apple Silicon Mac、Rust 1.99（`rust-toolchain.toml` 固定）、Node.js 22.12+（建议24）、npm，以及包含 macOS 26+ SDK 的 Xcode Command Line Tools。GPUI 必须启用 `font-kit` 才会在 macOS 使用真实文字系统；禁用它会选中无字形的 `NoopTextSystem`。同时启用 `runtime_shaders`，供只有 CLT 的构建环境使用，不要求独立 Metal 编译工具。原生玻璃和验收驱动的系统要求不等于较旧 macOS 已验收。

```sh
npm ci
npm run dev
```

启动器构建真实 Rust worker、原生系统插件、Swift Tern helper 和 GPUI 宿主，生成并 ad-hoc 签名实例内 `.app`，直接运行 `Contents/MacOS/oc-chan`。每次启动创建独立 `.dev-instances/instance-*`，隔离 profile、Cargo 产物和资源；bundle ID 由实例路径派生，同路径恢复保持一致。开发 plist 设置 `LSUIElement=true`，默认隐藏原生窗口，不显示 Dock/托盘，不允许激活外部应用、修改登录项或申请通知权限；不使用正式应用的个人设置或数据库。通知权限只读查询使用真实应用身份。

非默认 `acceptance` feature 提供认证 Unix socket，协议为 `OC_CHAN_GPUI_ACCEPTANCE_V1`，绑定实例、UID、令牌和有界请求。真实隐藏 GPUI 窗口的 Metal capture 也仅在验收构建可用。生产 feature 列表为空，不包含驱动、capture 或测试信任根。构建回执使用 schema 3、`renderer: "gpui"`；开发 feature 为 `["acceptance"]`。

按 Ctrl+C 先撤销新工作，再等待本实例宿主、插件、worker及已确认后代退出，成功后回收临时目录。无法确认进程身份、排空或清理时明确失败并保留现场；不得凭进程名或 PID 批量终止。需要保留本轮隔离配置以检查重启行为时：

```sh
npm run dev -- --no-cleanup
# 用上一条输出的实际绝对路径重新打开同一实例：
npm run dev -- --resume-instance /absolute/path/to/.dev-instances/instance-XXXX --no-cleanup
```

恢复实例复验 owner、排空凭证及构建记录；启动前核验 bundle 路径、Info.plist 身份、程序与资源摘要、代码签名，复用原 profile 和产物。旧裸 executable 记录明确拒绝；恢复不是源码修改后的自动重建入口。省略 `--no-cleanup` 时，正常退出会回收该实例及其中的 `.app`。不得手动改写 owner 文件绕过身份检查。

只有用户明确要求原生窗口交互时才使用 `npm run dev:window`。无头结果不能证明 Dock、物理托盘、可见焦点、系统授权框、VoiceOver或可见动效已通过。

## 真实应用场景

```sh
npm run smoke:renderer
npm run smoke:renderer -- --scenario collectors --out /tmp/oc-chan-collectors-new
npm run smoke:renderer -- --scenario marketplace --out /tmp/oc-chan-marketplace-new
npm run smoke:renderer -- --scenario notifications --out /tmp/oc-chan-notifications-new
npm run smoke:renderer -- --scenario topology --out /tmp/oc-chan-topology-new
npm run smoke:renderer -- --scenario sidebar --out /tmp/oc-chan-sidebar-new
```

当前 `scripts/smoke-renderer.mjs` 复用真实开发启动器，检查隐藏且非 key 的 GPUI 窗口，按1280×860和880×640导航页面，通过 Metal capture 保存 PNG，打开隐藏托盘并验证退出与实例清理。`--out` 指定证据目录；脚本会创建目录，建议每轮使用独立路径。`marketplace` 目前选择插件/设置页，`topology` 选择 Agent 页，其余场景选择全部主要页面；场景名称本身不证明原有专项行为已覆盖。报告保留 `visibleWindowAcceptance: false`，当前文档不宣称这轮 GPUI smoke 已运行通过。

验收 driver 使用真实 GPUI 状态和动作，不提供 DOM setter、JavaScript eval、React 提交或 WebKit 探针。请求20秒截止，启动等待最多1200秒，首个设置状态等待默认60秒，退出排空30秒；以当前脚本为准，不沿用旧 WebView runner 的分阶段预算或 `--fault` 参数。失败输出 `result.json`、`launcher.log` 和已捕获截图并返回非零。

原有功能验收范围必须继续保留：历史分页/取消/锁库恢复、事件筛选与分页、来源停用恢复、通知设置与权限、设置写入失败及回滚、脱敏诊断、窗口授权、2D/建筑视图交互、同 profile 重启、独立启动恢复、插件市场安装/升级/取消/摘要拒绝/失败恢复，以及侧栏布局持久化。当前基础截图遍历不能替代这些行为证据，尚未补齐的自动化应明确记录为缺口，不能删除产品要求。

真实输入夹具应使用独立存活进程、FD、JSONL、JSON、plist与SQLite，由生产 Rust 采集器读取，不能播种假快照或借用个人数据。性能夹具现位于 `scripts/performance/agent-fixtures.mjs`，通过 `stopAgents` 排空真实进程。市场签名夹具入口仍为 `OC_CHAN_ACCEPTANCE_MARKET_FIXTURES`，只允许 acceptance 无头开发实例；同 profile 重启须复用信任根，不能从可写安装目录建立信任。正式构建不读取该入口。

资源断言应使用 Rust 资源池的 `history`、`events` 等固定标签；业务来源 `hermes-events` 与分页来源 `hermes` 不同。缺少资源记录必须失败。暂停显示只取消视图查询，后台事件采集继续；停用事件后才要求对应资源归零。诊断未知资源标签须脱敏并标明无效字段。

设置持久性应回读完整磁盘字节，并与带明确运行时覆盖的状态区分。登录/无头模式临时关闭 Dock 与防休眠不能覆盖保存偏好。侧栏继续使用 `sidebarCollapsed`、`sidebarWidth`，保留单在途与最新待提交、失败回滚和重试；188px再向左64px收起、恢复原宽度、⌃⌘S、紧凑导航、三档文字和焦点要求仍需 GPUI 定向验收。

原生鼠标、文本、按键与窗口坐标必须按 GPUI/AppKit 实际路径验收；逻辑像素、窗口边框、内容区和物理像素分开记录。880×640、1280×860、200%文字及长内容仍是要求。旧 WKPreferences [`tabFocusesLinks`](https://developer.apple.com/documentation/webkit/wkpreferences/tabfocuseslinks) 与 DOM 焦点测试仅为历史记录，不适用于 GPUI。隐藏截图和动作回执不能证明 VoiceOver、物理 Tab、可见缩放或60/120Hz呈现通过。

拓扑菜单仍须覆盖右键、键盘、外部关闭、Escape及焦点归还；Tern导航必须走真实宿主动作，无头拒绝不等于前台切换验收成功。GPUI 绘制不使用 `requestAnimationFrame` 或 Three.js；按需更新、隐藏/暂停/离页取消及有界缓存要求保留，不能把驱动往返或捕获一帧当作可见帧率。

## 定向检查

按影响范围选择已有测试，普通局部修改不默认跑全仓。全量宿主迁移属于跨模块变更，需要覆盖全部新核心及桥接。

```sh
npm run typecheck
npm run test:desktop
cargo build -p oc-core --bin oc-data-worker --features acceptance
OC_DATA_WORKER_TEST_EXECUTABLE="$PWD/target/debug/oc-data-worker" cargo test -p oc-core --features acceptance --lib -- --test-threads=1
node --input-type=module -e "import { runRustTests } from './scripts/ci-tests.mjs'; process.exitCode = runRustTests(['host'])"
cargo test -p oc-installer --lib -- --test-threads=1
node --test scripts/develop.test.mjs
node --test scripts/performance/*.test.mjs
npm run test:release
```

需要实际 worker 或签名 fixture 的显式忽略测试必须单独配置环境执行，不能把默认忽略当通过。CI 根据变更路径映射 Rust 包和脚本行为测试，未映射代码或测试明确报错。查看计划：`npm run test:ci -- --plan crates/oc-desktop/src/views/mod.rs`。

宿主组先构建 release 系统 collector，并用原生市场构建器生成签名包，将独立资源目录通过 `OC_CHAN_RESOURCE_DIR` 传给 `oc-desktop --features acceptance`；不再构建 Vite 或传入 `TAURI_CONFIG`。直接 `cargo test -p oc-desktop` 时仍须满足实际构建资源要求，优先使用已有 CI 宿主组编排。

GPUI 入口、原生 capture、视图及构建变更按选择器映射到真实 renderer smoke。删除路径必须保留删除状态，重命名展开两侧路径，不能把未知删除当作全量测试；下面仅输出计划：

```sh
node --input-type=module -e "import { execFileSync } from 'node:child_process'; import { changedFiles, selectTests } from './scripts/ci-tests.mjs'; const base = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' }).trim(); const changes = changedFiles(base); console.log(JSON.stringify({ files: changes.files.length, removed: changes.removed.length, plan: selectTests(changes.files, undefined, changes.removed) }, null, 2))"
```

## 资源与性能

```sh
node scripts/performance/run.mjs --mode smoke --scenario startup
node scripts/performance/run.mjs --mode smoke --scenario daily
node scripts/performance/run.mjs --mode smoke --scenario stress
node scripts/performance/run.mjs --mode smoke --scenario soak
# 单独安排的24小时常驻测量：
node scripts/performance/run.mjs --mode baseline --scenario soak --out /tmp/oc-chan-rust-soak-new
```

入口仅接受普通用户采样，不申请新系统权限。报告使用 schema 4、`renderer: "gpui"`，记录从启动器开始到观察设置的时间（包含构建等待）、驱动导航往返、宿主及开发进程的 RSS、单核口径 CPU、FD 与进程数；驱动往返不是 event-to-paint 时延。

C/libproc 每秒采样出生身份已核验的宿主及可观察后代，启动器单独统计。新生、离场、读失败进程不计为完整 CPU 区间；缺失字段与覆盖缺口显式记录，不填零。不再关联 WebKit XPC 进程，当前也没有 GPU 内存、GPU完成、显示帧率或亚采样周期 helper 生命周期的完整证据。

daily 使用32会话×1Hz，stress 使用128会话×10Hz，soak 使用128会话×1Hz并在每小时首分钟10Hz突发。真实 session 文件写入、字节、轮转和每分钟 schedule mutation 都记录，GPUI inspect 核对全部夹具ID/PID。smoke 每场景8秒，不会自然覆盖每分钟轮转；baseline 的 soak 为24小时，daily为600秒，其余为60秒。源码变化、压力落后、采样停止或清理失败均失败。旧100并发刷新、200历史替换、锁库/取消与拓扑专项不是当前 runner 已覆盖项，仍须补充等价验收。

`scripts/performance/compare.mjs` 仅接受同 schema 4 GPUI 契约，并核对实际 workload。旧 Electron 与 Tauri 数字保留为[历史性能基准](performance-baseline.md)，不能改写数字或将旧结果当 GPUI 成绩；旧 Rust/Tauri 证据仍在本地 `docs/codex-handoffs/2026-11-10-rust-migration-integration.md`。当前缺少 GPUI 构建/视觉通过证据，短测也不证明24小时、睡眠/网络切换或16GiB硬件通过。

## 构建与打包

```sh
npm run build
npm run package
npm run dist
```

`build`执行 Rust/GPUI release 构建；`typecheck` 单独映射为 `cargo check -p oc-desktop`。`package`生成目录应用，`dist`生成DMG、ZIP和schema 2的`latest.json`。产物位于`release/gpui/`，实际路径以schema 3的`build.json`和对应`distribution.json`为准；回执标记`renderer: "gpui"`，生产features为空。构建验证Rust依赖许可证，包内没有Node/Electron/WebView运行时。

本地默认ad-hoc签名，不代表Developer ID、公证或正式安装验收。打包不替换`/Applications/OC Chan.app`；安装、发布和推送的授权与回执分别处理。完整门禁和清理要求见[安装、构建与发布](distribution.md)。

## 任务收尾

并行任务交付分别记录源码、证据保全和临时 worktree 状态。新建临时目录使用唯一命名的任务/集成分支，通过 `HEAD:main` 推送；main/master 只检出在保留工作区。创建时在本地交接中记录绝对路径、用途及清理授权；已有目录、其他任务、长期工作区和用户要求保留的目录不自动纳入。推送不包含清理授权。

实现及公开文档按授权提交并推送 GitHub main。交接放在本地 `docs/codex-handoffs/`，列明本任务目录、实际检查结果、安装/发布的独立状态、原始证据位置和保留方式；交接、审计与迁移实验记录按 `.gitignore` 排除，不再随任务推送。原始日志、截图、安装回执、源码快照、ZIP/DMG 应在目标 worktree 之外保存并核对内容。公开文档、截图、迁移接口契约和构建依赖 JSON 继续入库。

**当前限制：**现有 `closeout:task` 仍要求交接在远端 main 和入口 HEAD 中具有一致 blob，不能用于上述本地交接。此时保留工作树并明确报告“本地交接不满足远端门禁”；不得强制添加忽略记录、借用无关交接或绕过安全检查。以下仅说明工具现有契约，不授权执行清理；只有另行明确的清理授权和全部原有前提均满足时才适用。

从同仓一个保留的工作区运行，替换为本任务实际路径：

```sh
npm run closeout:task -- --worktree /absolute/path/to/oc-chan-task --handoff docs/codex-handoffs/YYYY-MM-DD-topic.md
```

默认输出 JSON 报告，不删除工作树材料；为核验实时远端会执行 `ls-remote` 和 `fetch`。目标 HEAD 必须在 GitHub main 的祖先链中；交接必须已提交，保留工作区中的版本与远端 main 的常规 blob 一致。工具不以旧 `origin/main` 缓存、相似补丁或文件内容大致相同替代合入证明。

所有暂存、未暂存和未跟踪内容都会阻止删除，包括文档、技能和未入库交接。ignored 清单单独报告，默认也阻止删除。逐项检查其内容后，只有可重建产物、或必要材料已在目标外保存且核验的条目，才能显式传入可重复的 `--discard <精确相对路径>`，例如确认后添加 `--discard node_modules`。参数只匹配报告中的精确条目，不接受通配符或父目录泛匹配；不能将报告全部自动转成 `--discard`。`out/`、`release/` 或 `.dev-instances/` 的名字本身不是可丢弃证明。

`assume-unchanged` 和 `skip-worktree` 可能隐藏本地改动；发现这些索引标记也会拒绝收尾，工具不会自动取消标记或重置文件。报告中的 `dirty` 列出状态与路径，不读取或公开文件正文。

本任务会话及进程退出、预检无阻塞后，对同一目标和已审阅参数加 `--apply`：

```sh
npm run closeout:task -- --worktree /absolute/path/to/oc-chan-task --handoff docs/codex-handoffs/YYYY-MM-DD-topic.md --apply
```

执行前重新核验路径身份、HEAD、全部改动、ignored 清单、实时远端及交接，并通过 macOS `lsof` 检查目标中的打开文件和工作目录。主仓、执行者所在树、main/master、锁定或失效登记、外仓、符号链接祖先和在用目录均拒绝；不发送停止信号，不删除分支，不使用 `--force`、`reset`、`stash` 或 `clean` 绕过。

收尾使用普通 `git worktree remove`，随后核对目录不存在且注册记录消失。`--apply` 将本地计划及结果保存在 Git common dir 的私有 `task-closeouts/` 下，报告返回 `receiptPath`，目标移除后仍能读取；原始证据仍位于事先保全的位置，工具不会自动移动或归档它们。阻塞与错误返回非零；最终交付须区分“已推送、收尾完成”和“已推送、收尾阻塞”，记录剩余目录及具体原因。

这些检查不能对不合作的外部并发写入提供原子保证。收尾期间不得在目标中新启动会话或构建；已检测到的远端/进程查询失败（包括权限报错）会保留目录。成功的 `lsof` 查询仅覆盖当前用户可观察的进程，不能独立证明所有会话和进程均已退出，退出确认仍是操作者前置责任。该入口的进程门禁针对 macOS；其他平台不执行删除。

定向回归使用隔离的临时 Git 仓库与本地 bare remote，不访问真实 GitHub、不删除工程工作树：

```sh
node --test scripts/closeout-task.test.mjs scripts/push-main.test.mjs scripts/ci-tests.test.mjs
```
