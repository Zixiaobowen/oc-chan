# 开发与验证

[返回首页](../README.md)

命令和路径均相对仓库根目录。后台与桌面宿主使用 Rust，唯一宿主为 `src-tauri`；React / TypeScript 界面经 Vite 打包，在 macOS 系统 WKWebView 中运行。2D 拓扑使用 ReactFlow，3D 建筑使用 Three.js。Node 用于前端构建、开发与验收工具，不随生产应用分发。

## 运行

需要 Apple Silicon Mac、Rust 1.99（`rust-toolchain.toml` 固定）、Node.js 22.12+（建议24）、npm，以及包含 macOS 26+ SDK 的 Xcode Command Line Tools。原生玻璃和验收驱动的系统要求不等于较旧 macOS 已验收；WKWebView 使用系统 WebKit，不打包 Chromium。

```sh
npm ci
npm run dev
```

启动器构建真实 Rust worker、原生系统插件、Swift Tern helper、Vite 页面和 Tauri 宿主，生成并 ad-hoc 签名实例内 `.app`，直接运行 `Contents/MacOS/oc-chan`。每次启动创建独立 `.dev-instances/instance-*`，隔离 profile、Cargo 产物和资源；bundle ID 由实例路径派生，同路径恢复保持一致。开发 plist 设置 `LSUIElement=true`，默认隐藏原生窗口，不显示 Dock/托盘，不允许激活外部应用、修改登录项或申请通知权限；不使用正式应用的个人设置或数据库。通知权限只读查询使用真实应用身份。

非默认 `acceptance` feature 提供认证驱动、真实 WKWebView 探针与截图，绑定实例、UID、令牌和有界请求。生产 features 为 `["custom-protocol"]`，不包含验收驱动、探针或测试信任根。构建回执使用 schema 3、`renderer: "react"`；开发 features 为 `["acceptance", "custom-protocol"]`，页面通过受控 custom protocol 加载。

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
npm run smoke:renderer -- --scenario schedules --out /tmp/oc-chan-schedules-new
```

当前 `scripts/smoke-renderer.mjs` 复用真实开发启动器，驱动隐藏且非 key 的 WKWebView 窗口，操作实际 React 页面、保存截图，并验证退出与实例清理。`--out` 必须指向全新证据目录。`all` 覆盖完整场景，各专项按实际脚本选择行为；不能用场景名称代替行为证据。报告保留 `nativeVisibleWindowAcceptance: false`，是否通过以实际运行证据为准。

`schedules` 只验收定时任务页及配置详情：读取隔离 Hermes 配置中的长正文、工作目录和模型，检查 1280×860 / 880×640 的正文宽度、配置与历史独立刷新、任务切换、关闭与离页释放。该场景不安装插件、不运行设置恢复流程，退出时核对本次实例已回收。

验收 driver 使用真实 WKWebView 的 DOM、JavaScript 与 React 提交探针，截图及输入仍走实际宿主。总截止20分钟、构建10分钟、启动5分钟、场景6分钟、重启1分钟；其他分阶段预算以当前脚本为准。`--fault fixture|ipc` 仅用于 `all` 的故障验收。失败保存 `result.json`、日志与已捕获截图并返回非零。

功能验收范围继续包括历史分页/取消/锁库恢复、事件筛选与分页、来源停用恢复、通知设置与权限、设置写入失败及回滚、脱敏诊断、窗口授权、ReactFlow 2D/Three.js 建筑视图交互、同 profile 重启、独立启动恢复、插件市场安装/升级/取消/摘要拒绝/失败恢复，以及侧栏布局持久化。脚本恢复不等于本次验证已通过，任何缺少的行为证据都应明确记录。

真实输入夹具应使用独立存活进程、FD、JSONL、JSON、plist与SQLite，由生产 Rust 采集器读取，不能播种假快照或借用个人数据。性能夹具现位于 `scripts/performance/agent-fixtures.mjs`，通过 `stopAgents` 排空真实进程。市场签名夹具入口仍为 `OC_CHAN_ACCEPTANCE_MARKET_FIXTURES`，只允许 acceptance 无头开发实例；同 profile 重启须复用信任根，不能从可写安装目录建立信任。正式构建不读取该入口。

资源断言应使用 Rust 资源池的 `history`、`events` 等固定标签；业务来源 `hermes-events` 与分页来源 `hermes` 不同。缺少资源记录必须失败。暂停显示只取消视图查询，后台事件采集继续；停用事件后才要求对应资源归零。诊断未知资源标签须脱敏并标明无效字段。

设置持久性应回读完整磁盘字节，并与带明确运行时覆盖的状态区分。登录/无头模式临时关闭 Dock 与防休眠不能覆盖保存偏好。侧栏继续使用 `sidebarCollapsed`、`sidebarWidth`，保留单在途与最新待提交、失败回滚和重试；188px再向左64px收起、恢复原宽度、⌃⌘S、紧凑导航、三档文字和焦点要求仍需定向验收。

鼠标、文本、按键与窗口坐标按 WKWebView/AppKit 实际路径验收；CSS像素、页面缩放、窗口边框、内容区和物理像素分开记录。880×640、1280×860、200%文字及长内容仍是要求。WKPreferences [`tabFocusesLinks`](https://developer.apple.com/documentation/webkit/wkpreferences/tabfocuseslinks) 与 DOM 焦点行为须按真实页面核验。隐藏截图和动作回执不能证明 VoiceOver、物理 Tab、可见缩放或60/120Hz呈现通过。

拓扑菜单仍须覆盖右键、键盘、外部关闭、Escape及焦点归还；Tern导航必须走真实宿主命令，无头拒绝不等于前台切换验收成功。Three.js 按需绘制及 ReactFlow 动效须覆盖隐藏/暂停/离页取消、有界缓存和 WebGL 资源释放；`requestAnimationFrame`、WebGL draw 返回及驱动往返不能当作可见帧率或GPU完成证据。

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

需要实际 worker 或签名 fixture 的显式忽略测试必须单独配置环境执行，不能把默认忽略当通过。CI 根据变更路径映射 Rust 包、前端与脚本行为测试，未映射代码或测试明确报错。查看计划：`npm run test:ci -- --plan src-tauri/src/host.rs`。

宿主测试构建实际资源及 Vite 页面，并通过 Tauri 构建配置传入资源；优先使用已有 CI 宿主组编排。直接执行 Cargo 测试同样必须满足前端输出、系统 collector、签名市场夹具及资源配置要求，不能用空目录代替真实资源。

应用更新使用独立场景 `npm run smoke:renderer -- --scenario updates`。开发与无头实例只执行更新探测，不启动 Sparkle 下载/安装界面；正常安装版的自动检查由 Sparkle 管理。场景通过不代表真实安装、重启或可见标准更新界面已通过，相关证据须分别记录。

React 页面、Tauri 入口、WKWebView 探针及构建变更按选择器映射到真实 renderer smoke。删除路径必须保留删除状态，重命名展开两侧路径，不能把未知删除当作全量测试；下面仅输出计划：

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

入口仅接受普通用户 `--sampler user`，不申请新系统权限，也不接受 root 采样。`run.mjs` 报告 schema 3，记录构建/启动阶段、实际核心发布、事件投递和 React commit、分通道消息与JSON字节、WebGL draw和原生rAF桶，以及RSS、单核CPU、FD和进程数；缺少文件事件专属watch时间与各采集分区span，不把JSON载荷字节当作传输封装字节。

C/libproc 采样核验出生身份的宿主和可观察后代，并单独记录启动器。acceptance-only WebKit实例关联提供出生身份核对后的XPC记录，共享身份去重；不可用角色、关联租约到期、不完整CPU区间与亚采样周期生命周期缺口均显式保留，不填零。XPC可能共享，因此不能声称独占应用总内存或自动推导改善幅度。WebGL draw只证明原始方法返回；隐藏WK可能暂停rAF，均不证明GPU完成或物理显示帧率。

startup baseline运行10轮；idle覆盖主窗、托盘及均隐藏；daily baseline运行5轮，每轮预热120秒、测量600秒，smoke预热2秒、测量8秒。真实夹具包含32会话，L2与soak使用128会话；stress覆盖资源边界，soak baseline为24小时。真实进程发现、文件写入、事件频率、历史查询、变更与交互计数写入workload证据；源码变化、采样失败、排空或清理失败均失败。具体负载与阈值以 `scenarios.mjs`、`soak-scenario.mjs` 和共享 workload 为准，不将所有场景概括为8秒。

`scripts/performance/compare.mjs` 对冻结基线与候选执行对照，生成schema 2比较报告，并断言共享夹具、实际负载、视口与计数一致；构建管线、驱动开销、watch及进程归属覆盖差异仍须说明，不自动宣称性能提升。[历史性能基准](performance-baseline.md)与本地 `docs/codex-handoffs/2026-11-10-rust-migration-integration.md` 仅证明当时实现，旧Electron、Tauri和GPUI证据均不能当作本次恢复成绩。当前实现尚未验证；短测不证明24小时、睡眠/网络切换或16GiB硬件通过。

## 构建与打包

```sh
npm run build
npm run package
npm run dist
```

`build`执行 Vite 前端打包和 Rust/Tauri release 构建；`typecheck` 检查前端类型。`package`生成目录应用，`dist`生成DMG和ZIP，稳定发布另生成签名的 `appcast.xml`，不再生成 `latest.json`。产物位于`release/tauri/`，实际路径以schema 3的`build.json`和对应`distribution.json`为准；回执标记`renderer: "react"`，生产features为`["custom-protocol"]`。构建验证Rust与renderer依赖许可及 Sparkle 2.10.1 官方归档 SHA-256/逐文件 pin，保留完整 framework 和上游签名 helpers（包括封印内的 Headers/Modules）；包内不分发Node/Electron/Chromium，WKWebView由系统提供。Sparkle 的生产体积增量须以实际产物测量，不能以历史预算证明已达标。

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
