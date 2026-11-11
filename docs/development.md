# 开发与验证

[返回首页](../README.md)

命令和路径均相对仓库根目录。应用后台与桌面宿主使用 Rust / Tauri 2，界面保留 React、TypeScript、React Flow 和 Three.js，运行在系统 WKWebView 中。Node 仅用于前端构建及开发工具。

## 运行

需要 Apple Silicon Mac、Rust 1.99（由 `rust-toolchain.toml` 固定）、Node.js 22.12+（建议24）、npm，以及包含 macOS 26+ SDK 的 Xcode Command Line Tools。macOS 27 会拒绝旧 Rust 工具链产生的部分 release 构建期动态库（`mis-aligned LINKEDIT string pool`），不要降低最低系统版本或复用旧编译器产物绕过。生产最低系统要求与自动化驱动要求分别记录：原生玻璃和验收驱动的鼠标坐标转换需要 macOS 26+，不能据此宣称已在较旧系统完成验收。

```sh
npm ci
npm run dev
```

启动器构建真实 Rust worker、原生系统插件、Swift Tern helper、前端及 Tauri 宿主，再由 Tauri 生成并 ad-hoc 签名实例内的 `.app`，直接运行其中的 `Contents/MacOS/oc-chan`。每次启动创建独立 `.dev-instances/instance-*`，隔离 profile、Cargo 产物和资源；bundle ID 由实例路径派生，与正式应用隔离，同路径重启保持一致。开发 plist 设置 `LSUIElement=true`，默认隐藏原生窗口，不显示 Dock/托盘，不允许跳转激活外部应用、修改登录项或申请系统通知权限；不使用正式应用的个人设置或数据库。通知权限的只读查询使用真实应用身份，不将裸 executable 的原生错误伪装为不支持。

验收构建通过非默认 `acceptance` feature 提供认证 Unix socket，绑定当前实例、UID、nonce、窗口和资源上限。它不是 Chrome/CDP，也不提供对生产应用开放的调试端口。发布构建不包含此驱动、测试信任根或性能探针。

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

`--out` 必须是新目录。入口复用 `npm run dev`；受控输入来自真实存活的描述符进程、JSONL、JSON、plist和SQLite，Rust生产采集器实际读取这些输入。系统监控由独立Rust插件真实采集本机指标。夹具不借用个人会话、任务正文或正式数据库。

`marketplace` 场景覆盖统一「插件」入口、未安装时的空状态与顶栏管理入口、安装后子页面、独立箭头的鼠标／键盘展开收起、收起目录后仍能进入管理，以及停用／卸载和重启。`sidebar` 场景先执行未安装到已安装的基础流程，再验证收起顶栏只有一个「插件」管理入口且系统监控仍可访问；以原生窗口红绿灯坐标和 WebView 缩放／遮挡偏移校准按钮中心，覆盖三档文字大小与展开／收起六种组合，容差为 0.5pt。

启动分为 `first-build` / `first-startup`（重启和恢复同样分段）。构建及产物校验沿用性能验收的600秒预算；`develop.mjs` 仅在 `loadDevelopmentBuild` 完成构建回执、资源摘要与签名核验后、启动应用前输出结构化 `{developmentStage:"build-complete",instance,resumed}`。Smoke校验实例身份、重启模式并拒绝重复信号，从收到信号时开始计算独立300秒应用就绪预算，信号到阶段切换之间的时间也计入其中。恢复使用新构建，重启复用产物但仍须完成校验；构建失败或缺少信号不能进入就绪阶段。全程1200秒、UI场景360秒预算保持不变，冷编译耗时不再被误报为应用启动挂起。

会话夹具由短命启动器创建，实际进程确认`ppid=1`后才报告自己的PID；这样不会因从OMP工具内启动而被采集为该OMP的子任务。控制管道由验收进程持有，EOF触发实际夹具关闭FD并退出；收尾同时等待继承输出管道关闭和实际PID消失，不能用启动器退出代替夹具退出，也不按裸PID强杀。

完整场景覆盖页面导航、历史分页/取消/锁库恢复、事件筛选与分页、来源停用恢复、通知设置、设置写入失败与回滚、诊断、IPC权限、2D/3D交互、同profile重启和独立启动恢复。首轮退出后，重启复用实际保存的设置、插件目录及业务数据库，不能用重新播种相同内容代替持久性证明。

验收feature在每个新文档解析应用脚本前注册有界的未捕获异常和Promise拒绝观察器，重载时重新建立；场景检查重载前后的状态，缺少监测对象也判失败。该脚本不进入生产构建。

无头文档在产品层保持逻辑可见，因此在 macOS 14+ 通过 Tauri `background_throttling(Disabled)` 禁用 WebKit 的后台节流/挂起；原生窗口仍隐藏且禁止激活，普通窗口保留系统默认策略。正式应用最低 macOS 13 不变：Wry 在 13 上不设置此策略；当前原生输入验收要求 macOS 26+，启动证据必须回读 `inactiveScheduling.policy=none`。不能把无头逻辑可见误当作 WebKit 已自动保持活跃。

超时调查使用 `evidence/*.jsonl` 中的 `driver-operation`（≥250ms 或失败的操作，区分排队与执行耗时，不记录脚本、令牌和响应正文）及 `events-deduplication-sample`（100 次采样各自的 refresh/snapshot 进度）。先比较阶段累计时间和后端资源耗时，区分驱动/WebKit调度与采集器耗时；总deadline触发后的driver关闭是收尾结果，不能据此认定事件采集挂起。

资源断言使用Rust资源池的`history`、`events`等固定标签；业务来源`hermes-events`与分页结果`hermes`是不同字段。缺少资源记录必须失败，不能让空集合检查通过。暂停显示只取消该视图查询，后台事件采集继续；停用事件插件后才要求整个`events`资源桶归零。诊断导出保留当前固定资源标签，未知标签脱敏为`unknown`并标记`invalid-fields`。

市场场景使用签名原生插件和有界本机HTTP源，覆盖离线首装、启用、卸载、下载取消、升级、摘要篡改拒绝、激活失败恢复旧版及重启复验。v1/v2使用真实系统collector，v3通过验收feature返回真实采集错误；HTTP服务只提供包字节，不模拟采集结果。测试信任根仅在验收构建可用，不能进入发布包。

市场夹具根由本次启动器通过`OC_CHAN_ACCEPTANCE_MARKET_FIXTURES`明确传入，并在复验已安装包之前加载；同profile重启复用相同根。该入口仅编译进`acceptance`且只允许无头开发模式，JSON≤64KiB、根≤16、固定目录与catalog摘要受校验；移除根后同一已安装HTTP验收包必须被拒绝，不能由可写安装目录自行建立信任。正式构建不读取此环境变量。

独立启动恢复同时核验磁盘原始设置与运行时快照：恢复不能把临时Dock/防休眠覆盖写回偏好文件；公开快照则显示实际原生开关，无头模式中两项均为false。验收分别比较完整持久字节和带明确运行时覆盖的设置，不能把两者直接等同。

鼠标、文本和按键通过真实AppKit responder进入WKWebView；原生select与时间草稿显式使用DOM setter，并验证React状态及Rust IPC。内容区、CSS viewport和遮挡inset分别记录，不能混同窗口外框或物理像素。场景覆盖880×640、1280×860、200%文字及长内容；这不替代可见窗口连续缩放或物理刷新率验收。

主窗、托盘和恢复窗均通过Tauri公开配置入口启用WKPreferences的[`tabFocusesLinks`](https://developer.apple.com/documentation/webkit/wkpreferences/tabfocuseslinks)，使用依赖树已有的WebKit绑定。无头窗口实际`document.hasFocus()`为false，原生Tab专项未触达目标；不将它记为可见窗口键盘导航通过。通知控件显式设置DOM焦点，再发送真实AppKit按键，验证激活、保存、错误回滚与焦点保留；事件select显式设置DOM焦点和值，再验证React草稿和实际Rust查询。鼠标点击本身不被假定会聚焦按钮或复选框，也不通过固定Tab次数推定目标焦点。

协作拓扑的 2D 与 3D 共用手动控制的顶层 Agent 菜单：右键松开后保持打开，后续外部 pointerdown 关闭，菜单内部按下不提前卸载；卸载释放监听。拓扑定向 smoke 通过 AppKit responder 验证完整右键、移入、菜单点击、外部关闭及 Escape/Shift+F10/Tab。跳转请求调用真实 Rust IPC，无头模式明确返回 `OC_TERN_UNAVAILABLE`，不激活用户的 Tern，也不代表原生前台切换通过。

侧栏使用当前 Rust 设置契约的 `sidebarCollapsed` 布尔字段（默认 false）及原有 `sidebarWidth`。React 沿用单在途、最新待提交补丁队列；保存期间忽略中间回执，排空后采用实际快照，失败回滚布局并显示“侧栏布局”诊断与重试。按钮固定在红绿灯右侧，⌃⌘S 切换布局；最小宽度 188px 再向左拖 64px 收起，取消本次宽度修改，展开恢复原偏好。紧凑视口保留菜单及快捷键开关菜单，不写回临时布局。

收起布局只展示当前可用的核心页面、已安装插件与市场入口，来源及设置固定在顶栏右侧；展开布局继续使用现有插件分组和插件面包屑。顶栏空间不足时隐藏文字但保留显式无障碍名称，标签可横向滚动。短 CSS 过渡不创建覆盖交互的快照层，不依赖 View Transitions；减少动态效果时不播放。拖动收起后的选择阻止监听在指针释放、取消、失焦、隐藏及卸载时释放。

`sidebar` 定向 smoke 使用真实隐藏 Tauri/WKWebView、AppKit 点击和拖动、Rust IPC、磁盘设置回读与同 profile 重启。覆盖顶栏各页、已安装插件、来源与设置、188−64px 阈值、原宽度保留、快速切换、设置目录真实写拒绝后的回滚与重试、紧凑导航及名称。写拒绝复用通知场景的隔离 profile 权限 helper，持有目录描述符并在 finally 精确恢复权限，不改正式应用设置。快速连续点击与快捷键使用明确标注的 DOM 事件，不能作为原生 ⌃⌘S 或可见动画验收；安装后还需在实际窗口核对原生快捷键、连续反向点击、系统减少动态效果和 VoiceOver 名称。

侧栏最窄检查为 `npm run typecheck`、`cargo test -p oc-core --lib settings::` 以及上述 `sidebar` 场景。新增字段不恢复已删除的 Electron 主进程设置实现。

隐藏WKWebView的`requestAnimationFrame`可能挂起；后台任务节流开关不保证动画帧执行。桌面更新调度依据宿主登记的模式选择：普通窗口使用原生rAF，无头展示使用可取消的单次任务，执行真实布局、Three.js绘制和标签投影；显式暂停和卸载会取消待执行更新，不建立常驻绘制循环。场景的`frames()`在真实`document.visibilityState === 'hidden'`时同步刷新布局并记录`hidden-layout-flush`，可见文档才等待双动画帧。实际WebGL绘制批次与原生rAF相关间隔分开计量，不将单次任务或布局刷新当作显示帧率和可见动画连续性证明。

总流程限时20分钟，首次构建/启动限时5分钟，场景限时6分钟，普通RPC限时5秒；较长操作另有明确边界。失败保留阶段、实际错误及截图并返回非零。`--fault fixture` / `--fault ipc` 用于验证故障不能被误报通过。退出记录资源归零、真实进程退出与实例清理；清理错误同样不能通过。

## 定向检查

按影响范围选择已有测试，普通局部修改不默认跑全仓。全量宿主迁移属于跨模块变更，需要覆盖全部新核心及桥接。

```sh
npm run typecheck
npm run test:frontend
cargo build -p oc-core --bin oc-data-worker --features acceptance
OC_DATA_WORKER_TEST_EXECUTABLE="$PWD/target/debug/oc-data-worker" cargo test -p oc-core --features acceptance --lib -- --test-threads=1
node --input-type=module -e "import { runRustTests } from './scripts/ci-tests.mjs'; process.exitCode = runRustTests(['host'])"
cargo test -p oc-installer --lib -- --test-threads=1
node --test scripts/develop.test.mjs
node --test scripts/performance/*.test.mjs
npm run test:release
```

需要实际worker或签名fixture的显式忽略测试必须单独配置环境并执行，不能把默认忽略当通过。CI选择器根据变更路径映射Rust包和前端/脚本行为测试，未映射代码或测试明确报错。测试选择方案可用 `npm run test:ci -- --plan src/renderer/src/AgentTopology.tsx` 查看。

宿主组在全新 checkout 中也必须先生成真实构建输入：选择器先构建 release 系统 collector，复用原生市场构建器签名打包，再用 Vite 构建前端。目录由本次运行独立创建，经 `OC_CHAN_RESOURCE_DIR` 和 `TAURI_CONFIG` 传给宿主，在成功或失败后回收；任一前置步骤失败即停止，保留原始错误输出。其他 Rust 组不执行这些宿主前置步骤。直接运行 `cargo test -p oc-chan` 需要调用方自行提供已生成的市场 catalog 和前端。

路径映射按模块覆盖原生市场验收夹具、WK 探针以及已删除的 Electron 入口；旧入口仅允许删除状态，映射到当前替代模块，不把未知删除路径转成全量测试。市场夹具、WK 探针和原生迁移入口触发真实 renderer smoke。检查完整 PR 差异时需保留删除状态，并将重命名展开为两侧路径；下列命令只输出计划，不构建或运行测试：

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

入口只接受普通用户采样，不申请新系统权限。记录构建与应用启动时间、事件到React真实提交的时延、消息数量/载荷、WebGL绘制及有界资源账本。Rust与JavaScript时钟经过往返校准，误差和关联覆盖率随结果保留。

C/libproc采样器记录已确认后代；WebContent、Networking和GPU另按WK实例返回的PID及出生身份关联、跨窗口去重，并在采样时复验。XPC可能共享，未知、过期、权限不足和短命生命周期均保留缺口，不填零。只统计父子树不能代表完整应用内存，关联成功也不能称为独占成本。

压力场景包含128会话突发、100并发刷新、200历史替换、超长JSONL、plist边界、SQLite锁与取消、插件反复启停及大拓扑。日志与夹具均有大小/数量上限；源码指纹变化、预算越界或清理失败中止测量。短测不代表24小时、睡眠/网络切换或16GiB硬件已经通过。

同机对照使用 `scripts/performance/compare.mjs` 顺序运行独立基准与候选，不能同时争用资源。负载、采集方式和HOME不一致时必须说明差异，不从不可比数字宣称性能提升。旧Electron成绩保留在[历史性能基准](performance-baseline.md)，Rust本轮证据记录在迁移交接（本地记录：`docs/codex-handoffs/2026-11-10-rust-migration-integration.md`，不随仓库分发）。

## 构建与打包

```sh
npm run build
npm run package
npm run dist
```

`build`执行类型检查及Rust/Tauri release构建；`package`生成目录应用，`dist`生成DMG、ZIP和schema2的`latest.json`。产物、构建摘要及资源清单位于`release/tauri/`，实际路径以`build.json`和对应`distribution.json`为准。构建时生成并验证前端与Rust依赖许可证，包内没有Node/Electron运行时。

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
