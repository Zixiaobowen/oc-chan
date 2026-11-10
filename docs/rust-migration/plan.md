# OC Chan Rust / Tauri 全量迁移方案

日期：2026-11-09；实施记录更新于2026-11-10。状态：方案独立评审、Rust/Tauri实现与已授权的本地工程验收完成。最终完整应用、真实压力、6分钟持续运行、启动/空闲/日常顺序对照、生产ZIP/DMG及包检查均通过；[验收回执](implementation.html)汇总证据。正式安装、系统授权/通知投递、Developer ID/公证、物理原生动效、24h及其他硬件未验证。用户已追加授权提交并推送迁移分支，未授权合并main或发布。

## 目标、基准与授权边界

用户要求完整方案、评审、实施。目标是把生产后台与桌面宿主完整迁至 Rust / Tauri 2，继续使用现有 React、TypeScript、React Flow、Three.js 界面；这不把 UI 改成 Rust GUI。主进程、采集、状态管理、持久化、插件宿主、更新与系统桥接全部替换，不保留 Electron、Node 生产进程、CommonJS 插件兼容层。Node 仅用于前端构建和开发测试工具。

独立工作区：`/Users/zixiaobowen/myProjects/oc-chan-rust-migration-20261109`；分支：`feat/rust-tauri-migration-20261109`；基准提交：`112d1d03f33373b96f3edc1898631149f030507e`。从原工作区复制了 13 项已跟踪修改及 21 项未跟踪文件；文件摘要见 `source-snapshot.json`。原工作区、其他任务实例、正式 `/Applications/OC Chan.app` 不由本次实现流程修改。

本次授权包括代码、文档、本地独立构建、无头验收，以及用户追加授权的当前迁移分支提交与GitHub推送；不包含合并main、发布、部署、替换正式安装、申请系统辅助功能/通知/管理员权限或清理其他任务资源。已存在的权限可用于只读核验。未授权的外部发布和原生交互不作为“已经完成”的证据。

## 完成条件

1. 下列能力矩阵全部有实际 Rust/Tauri 实现与对应验收，不能以空数组、成功空返回、静态示例、吞错或旧 Node 后台替代。
2. 界面保留当前全部页面、2D/3D 拓扑、长内容与窄窗布局、主题、语言、导航、筛选、选择、手动布局及暂停显示语义。宿主切换不顺带重新设计产品。
3. 所有生产采集、数据库、事件、插件调度、设置及发布更新事务在 Rust/原生边界执行。Swift/Objective-C 平台实现可复用；移除 N-API、Electron 与 CJS 执行宿主。
4. 资源、权限、取消、错误及未知状态保持明确；测试和真实无头 WKWebView 证明主链路可用，并记录整应用进程树资源数据。
5. 构建产物无 Electron/Node 运行时、旧 CJS 插件、开发驱动或测试资源。新插件可离线安装、启用、取消、升级、卸载、重启恢复。
6. 文档、构建发布、开发验收与清理入口同步切换；旧生产实现与失效的实现细节测试删除，用户改动和交付证据保留。
7. 未取得的 Developer ID/公证、真实通知投递、系统授权交互、物理高刷新率、其他硬件与 24h 验收分别列为未验证，不用单测或无头运行冒充。

## 最终结构与执行模型

- `crates/oc-core/`：与 Tauri 无关的 Rust 业务核心。类型、验证、资源预算、有界 IO、采集器、实时会话、调度/历史、事件/通知策略、设置、诊断、插件市场及更新状态机。
- `crates/oc-plugin-sdk/`：版本化原生插件消息契约与 Rust SDK。仅公开 DTO、宿主 IO 请求、取消及生命周期协议；不依赖核心内部实现。
- `plugins/system-monitor/`：Rust 官方独立采集插件及 manifest。系统监控仍通过市场安装，默认不安装，不编译进核心。
- `src-tauri/`：Tauri 桌面宿主、严格 command 边界、主窗/托盘/恢复窗、原生桥接、应用生命周期及更新安装入口。
- `src/renderer/` 与 `src/shared/`：保留 UI 和渲染纯逻辑。集中 `desktop` 适配器通过 `@tauri-apps/api` 调用有限命令与事件；替换旧 preload，生产页面不含 Node 能力。
- `native/`：Swift Tern helper 与 C ABI 的 AppKit/UserNotifications/ServiceManagement/IOKit 小型桥接。平台行为保留，N-API 删除。
- `scripts/`：前端构建、Cargo/Tauri 打包、原生插件包生成、隔离无头启动、真实 WKWebView 场景、性能采样、安装和归属清理。

Tauri 主线程只处理窗口和原生 UI。异步 IO 由 Tokio 执行；SQLite 使用独立 Rust `oc-data-worker` 子进程，所有请求仍经过统一有界资源池，禁止用 `spawn_blocking + timeout` 假装终止同步查询。worker设定SQLite hard_heap_limit/cache/busy/progress-handler边界；Hermes读取heap8MiB/cache2MiB，本地事件heap16MiB/cache1MiB，3s执行截止。取消必须终止并wait该工作进程、排空stdio后才归还租约。同步查询不会进入Tauri主线程。

数据库worker不安装系统常驻服务；初始实现保留每项请求独立执行的强隔离，后续只有测量证明需要且预算/取消等价时才改驻留池。内置插件使用同一生命周期及资源契约；外部官方插件使用独立原生子进程。采集在途合并、慢周期跳过；取消撤销发布权后等待真实IO结束。关闭先停admission，再排空插件、worker、监听器和原生对象。IPC保留按分区更新与来源心跳，不恢复全量快照广播。

## 全量能力与迁移映射

|能力|现有依据|Rust/Tauri 实现与必须保留的行为|
|---|---|---|
|Agent 进程发现|`collectors/agents.ts`|识别 OMP、Codex CLI/app-server、Claude Code、OpenCode；只返回白名单元数据，进程存活不等于正在工作；进程身份含启动时间，防 PID 复用|
|OMP 会话与关系|`collectors/agents.ts`、`live-agents.ts`|通过真实描述符、socket、会话头确认 cwd/model/session/父子；只沿证据建立关系，保留重复/缺失/超限诊断和 Tern 目标身份|
|Codex 会话|`collectors/codex-sessions.ts`|读取存活进程的可写 rollout 描述符，识别会话元数据和多层关系；与 OMP 共用会话与 IO 上限，不能扫描全部历史冒充活跃会话|
|实时活动|`collectors/agent-activity.ts`、`live-agents.ts`|有界增量 JSONL、截断/替换检测、文件监听清理、首事件 90ms 合并与首完成 16ms 发布窗口、6s 活动过期、最终状态和终止清除|
|launchd|`collectors/launchd.ts`、`schedules.ts`|用户/系统 plist、运行服务及禁用状态、真实命令输出诊断、稳定任务 ID、来源级重试；读取失败不伪造 disabled 或零任务|
|cron/OMP 任务|`collectors/schedules.ts`|保留现有配置发现、计划表达、范围/来源分类及错误边界，不执行任务、不推算无法证明的运行结果|
|Hermes 调度|`hermes-runtime.ts`、`schedules.ts`|只读数据库与进程证据，区分 dispatching、unconfirmed、unsupported 与真正失败；不读取任务正文或凭据|
|执行历史|`hermes-history.ts`、`schedule-history.ts`|每页25、offset≤100000且为25倍数、任务必须在当前快照、受限 job ID、替换查询取消、只读 SQLite、超时可中断|
|本地事件|`events/collector.ts`、`hermes.ts`、`store.ts`|确认的执行/投递失败、持续来源异常/恢复；基线、增量游标、事务 revision/checkpoint、去重、保留淘汰、断档/恢复、稳定分页|
|通知策略|`events/notifications.ts`、journal|默认关闭；来源/任务订阅、安静时段、每分钟3条、任务名 opt-in、持久认领不重放；关闭通知、停用事件、睡眠和退出分别取消/排空；暂停显示不影响后台通知|
|系统监控|`plugins/system-monitor/system.ts`|CPU差分、内存分类、swap、磁盘、默认网络接口和速率、CPU/内存进程排行、60点趋势；未知值保留 null，启用后重新建立基线|
|插件调度|`plugins/registry.ts`、`monitor.ts`|动态注册/卸载、依赖环检查、启动/采样/停用超时、迟到结果不得发布、失败可定位、真实排空后报告停止、停用保留旧快照而卸载清除|
|插件市场|`marketplace/*`|固定官方目录、搜索/筛选、已安装/更新状态、离线包、下载校验、单事务、取消、更新失败恢复旧版、损坏包仍可卸载、重启诊断未完成事务|
|监控订阅|`monitor-subscriptions.ts`|主窗/托盘独立订阅；生产只发可见且订阅窗口，headless仅绕过原生可见性门禁且仍需显式订阅；显示恢复取最新状态，暂停显示不改变后台采集；来源心跳不清掉业务错误|
|主窗/托盘|`index.ts`、`tray-window.ts`|单主窗、按需托盘、定位与屏幕边界、菜单栏图标、关闭隐藏、显式退出、窗口几何防抖保存与失败恢复|
|设置|`settings.ts`、`desktop-settings.ts`|全部现有字段与严格枚举/范围校验、未知字段拒绝、原子持久化、原生效果和采集启停事务、失败回滚和几何错误重试|
|外观与辅助功能|`liquid-glass.*`|六主题/双语/字体/文字大小；原生透明度、增强对比/减少透明度优先；玻璃0释放原生视图，预览取消和单窗单实例|
|登录/Dock/防休眠|`login-items.ts`、desktop settings|真实ServiceManagement状态与批准要求；登录启动不建主窗、本次Dock/防休眠关闭且不改持久偏好；开发拒绝登录项变更；原生效果正确读回与释放|
|Tern 跳转|`tern-navigation.ts`、`tern-present.swift`|快照目标、会话/进程/资源/窗口身份再次验证、子节点沿父链、唯一候选、辅助功能错误可见；无头拒绝外部跳转|
|页面/对象导航|`navigation.ts`|固定页面与对象目标、身份验证、单个可替换待办槽、sequence确认、过期确认不得清除新目标|
|诊断导出|`diagnostics.ts`、`diagnostic-report.ts`|白名单与脱敏、256KiB限制、唯一预览ID、过期拒绝、复制/保存/取消、保存路径仅由原生对话框产生|
|应用更新|`plugins/update-*`、`app-updates.ts`|固定公开发布源、开发/未签名禁用、启动30s/6h检查、显式下载/取消/安装、受限重定向、流式大小/摘要校验、磁盘预检、原生签名校验、退出不自动安装|
|启动恢复|`startup-recovery.ts`|无效/不可读设置进入独立恢复窗口，仅读取故障/重试/退出；正常窗口能力在恢复期不可用|
|3D/2D与其他UI|`src/renderer/src`|保留所有真实页面和交互，以及基准工作区尚未提交的拓扑办公空间改动；验证 WebKit/WebGL、透明度、字体、缩放、选择、上下文菜单和快速切页释放|
|交付与清理|`scripts/local-*`、CI|隔离profile/构建/端口；源码身份、签名与资源检查；仅一个正式应用；归属确认后清理本任务副本；push成功验证后才触发对应清理|

## 类型与 IPC 契约

保留现有前端业务 DTO 和可见结果语义，Rust serde 类型使用 camelCase；输入使用 deny_unknown_fields 和显式长度/枚举校验。公开 Rust 类型与 TS 类型通过契约夹具验证 JSON 字段、null/缺失和错误语义；不建立逐函数跨语言桥接。

五组有限 API 全部迁移：`MonitorApi`（含历史、事件、诊断、导航与订阅）、`SettingsApi`、`UpdatesApi`、`MarketplaceApi`、`StartupRecoveryApi`。新的 Tauri 命令逐项校验窗口标签、当前已登记窗口身份、主帧来源、恢复/退出阶段与参数。Tauri capability 仅授予本地应用窗口必要事件能力；不授予前端文件、shell、通用进程、任意URL或任意 Rust 执行能力。外部导航和新窗口默认拒绝。

主窗拥有变更能力；托盘只能读快照、刷新和请求受限主窗导航；恢复窗只有三项恢复操作。headless 在原生边界拒绝显示窗口、Tern跳转、登录项与通知权限请求。订阅独立解绑，销毁/重载清理；异步监听注册尚未完成即取消时，注册完成后也必须立即解绑。

完整42方法、逐窗权限、取消/订阅所有者、监听就绪屏障及登录/恢复/持久事件验收，冻结在 [api-contract.md](api-contract.md)。React挂载前完成Tauri事件监听；同步本地订阅之后的snapshot必须等待宿主interest握手，避免监听建立期间丢更新或旧snapshot覆盖新分区。单向cancel改成可等待Promise，全部消费者接住真实失败，不保留旧通道。

## 原生插件协议与包

采用受信任官方独立可执行插件，不使用Rust动态库ABI或JS引擎。`.ocplugin`为ZIP，内部是有代码签名封装的`.ocbundle`；manifest放在`Contents/Resources`，由Apple资源封印覆盖，避免裸二进制签名没有认证manifest。正式在线包必须通过完整Developer ID信任验证，并与已经验证的当前宿主Team、固定插件Bundle ID一致；摘要、manifest版本/权限/入口和实际Mach-O架构同时检查。每次启动复验已安装包，不信任可写安装目录中自报的摘要。

无Developer ID的本地构建只允许执行本构建资源目录中固定摘要的离线包；在线可执行安装明确禁用，不接受远端ad-hoc包。验收包使用仅在测试feature编译的独立摘要信任根，生产不得包含测试信任根。无需生成或保存新的发布私钥；正式在线发布仍需要Developer ID凭据，当前不宣称已具备。

完整协议冻结在 [plugin-contract.md](plugin-contract.md)：版本2、有界NDJSON、独立控制读循环、请求ID/代次、host-IO分块与结束确认、取消/stop可抢占、所有宿主IO走唯一资源池；常驻插件槽和协议缓冲单独计入同一预算账本，不长期占一次性命令槽，避免嵌套死锁。插件不继承凭据环境，官方SDK不支持自行spawn/daemonize；可信原生代码不是沙箱。

包预算明确为archive≤2MiB、manifest≤16KiB、入口≤8MiB、总展开≤9MiB、条目≤16、中央目录≤64KiB；安装最多16包，所有已安装/下载/展开暂存/回滚合计≤32MiB。每次解压写入复核实际累计量，安装前预留完整事务峰值。上述为必须证明的上限，不表示当前原生产物已构建合格；真实release系统插件测量不合格则先修订并评审，不能静默放宽。

当前CJS包只作移植依据；新宿主明确拒绝旧格式。安装目录版本化，旧包与个人数据不自动删除。

## 数据与资源约束

保留已有 JSON 设置与 SQLite 业务存储格式中仍有效的字段及事务，不引入历史格式转换脚本或兼容路径。新插件包格式独立；旧 Electron专属状态不加载。

全局命令/文件/socket槽各8；命令输出预留32MiB、文件16MiB、socket512KiB；总排队256、单来源128、来源32、排队10s；至少保留现有可观测 current/peak/outcome/wait/execution 指标。租约通过 RAII 释放，但必须在工作真正结束后释放；不能只 drop future 就假定系统调用已取消。

业务边界：会话128；历史每页25；事件每批100/每条2KiB/最多10000条/7天/磁盘20MiB；事件页50；诊断256KiB/64来源/128诊断/32资源；通知来源64/任务24。具体文件、进程、plist、JSONL行、socket回复等上限逐项从原采集器移植，并在契约测试中证明超限可见。

读文件使用预检、限制读取和增量游标；大文件不整文件加载。JSONL跨块与超长单条使用有界缓冲；数据库查询有LIMIT、超时、取消与只读模式；HTTP下载流式写入独占临时文件，检查内容长度、实际长度和摘要，fsync后提交。取消/失败时清理失败必须可见。

输入兼容的是仍有效的公开业务契约，而非旧执行路径：ID字符上限按原JS UTF-16 code unit计算，字段另设UTF-8字节上限；Hermes时间排序保留UTC秒与纳秒，不降为字符串或毫秒比较；原始stderr、prompt、工具参数与结果正文不进入快照。任何清理失败优先于取消报告。

持久目录显式沿用旧应用实际使用的 `~/Library/Application Support/OC Chan`（已核对原宿主`app.setName('OC Chan')`及userData用法），保留设置、事件数据库、游标与通知claim，不能依赖Tauri默认目录碰巧一致。仅开发实例使用隔离目录，不读正式数据库做写入验收。新插件目录单独版本化，旧包不自动删除。

## 应用更新与发布决策

移除 Electron/Squirrel。优先复用成熟更新组件，但必须同时满足流式有界下载、取消、显式安装和Developer ID约束。Tauri官方updater要求新的签名密钥且其下载API/内存行为需要确认，不把尚未配置的密钥写成已就绪。

Rust更新控制器与可信独立安装助手沿用固定GitHub发布仓库；受限JSON元数据包含版本、arm64资产、大小与SHA-512。正式候选必须验证Apple Developer ID信任、完整代码签名、固定Bundle ID、实际架构、严格升级版本及与已验证当前应用同Team；最终暂存位置复验。助手持独占安装锁，父进程和路径绑定出生/文件身份，写入持久事务记录后同卷替换，等待带事务身份的真实renderer/IPC/采集/历史就绪回执及持续存活，成功后才提交并删除旧包；崩溃阶段可恢复，失败保留双方现场。完整规则见 [update-contract.md](update-contract.md)。普通退出和后台运行不安装。

本地和CI生成Tauri `.app`、ZIP/DMG、摘要及新更新元数据；正式发布仍要求已有Developer ID/公证凭据，缺少时只能验证ad-hoc包与拒绝路径。实际推送发布源和替换正式应用需独立授权，本次不执行。

## 实施顺序与所有权

1. **冻结基准与评审**：主代理写方案、能力矩阵和验收矩阵；独立reviewer寻找缺失功能、安全与资源反例。所有阻塞项先修订再写产品代码。
2. **前置可行性与共享契约**：先在独立分支验证真实隐藏WKWebView的invoke/listen、React提交、WebGL绘制、截图、输入、尺寸变化及退出；验证插件双向IO/取消和实际release包大小、临时bundle安装回退。再冻结Cargo workspace、公开类型、资源接口、事件接口、插件协议和Tauri配置；前置失败时先修根因，不删除可用基准。
3. **数据核心**：实现代理A负责采集、实时会话、调度/历史、事件/通知策略；按冻结契约实现，关键语义从现有测试迁移。
4. **原生与桌面**：实现代理B负责原生桥接、设置、Tern、诊断、窗口/托盘；主代理整合Tauri命令和前端适配器。
5. **插件与交付**：实现代理C负责新插件SDK、系统插件、市场事务、更新与构建脚本中明确分配的文件；共享manifest和Cargo依赖由主代理维护。
6. **集成切换**：主代理处理依赖、公共接口和调用方；收齐实现后运行定向检查，替换开发/发布入口，移除旧生产实现。中间阶段源码可以共存用于对照，但最终不留兼容执行路径。
7. **端到端验收与交付**：真实WKWebView、插件市场、资源压力、同负载前后对照、包检查；更新文档和handoff。代理不在实施中自行跑build/lint/tests/formatter，由主代理统一集成验证。

上述切片将按最终契约重新分配文件，不能多个代理同时写Cargo根配置、宿主入口或同一共享模型。发现公共接口冲突由主代理决定。

## 验收矩阵与证据

### 核心正确性

- 从现有行为测试提取真实输入夹具；Rust跑发现、身份/父链、JSONL分块/替换、未知状态、source重试、历史分页/取消/锁库、事件去重/保留/revision、通知认领、设置回滚、资源公平/上限/取消及插件代次。
- 不能只比较fixture原样转发；必须断言用户可见状态、边界、错误、迟到结果和释放后状态。
- 现有纯前端拓扑/导航测试继续运行；旧Electron绑定或源码文字测试随旧实现移除，不为让测试变绿保留宿主。

### 真实应用

- 默认`npm run dev`启动隔离、无可见窗口的真实Tauri/WKWebView，独立profile、构建路径与驱动端口，禁止访问正式个人profile。
- 已核对tauri-plugin-wdio-webdriver 1.5.1源码：没有认证/会话/并发总量边界，port=0不能取得实际端口；公开接口无法满足私有有界驱动要求。改用仅验收feature编译的私有Unix socket原生驱动，绑定实例目录、当前UID、nonce及固定窗口；显式限制请求/结果字节、待处理数和超时。仍以真实WKWebView eval、React提交、WebGL与原生截图为证据，不退回Chromium或mock。
- 完整场景：所有页面与双语/主题、2D/3D选择/搜索/拖动/切换、真实Agent采集和移除、真实SQLite历史、事件筛选/分页、来源停用/恢复、设置失败/重试、诊断预览/取消、更新拒绝/下载取消、插件首次未装/安装/启用/更新失败恢复/卸载/重启。
- 内容区880×640、1280×860、断点两侧、分屏/全屏等效尺寸、200%文字、长内容/空/错误；真实DOM交互与截图并用。无头不证明原生焦点/Dock/托盘物理呈现、系统授权框或物理动效。

### 资源与性能

- 同机同负载、基准与候选顺序运行；采用原有C/libproc采样器及修正后的全进程树口径，区分采样缺口、短命进程和权限不足，不填零。
- WKWebView的WebContent/Networking/GPU可能由系统XPC启动，不能只用父子树采样便声称完整。验收必须取得可核验的宿主关联身份并计入；无法建立归属时分别报告已确认进程与未覆盖部分，不按进程名或UID猜归属，不据低报值宣称内存改善。
- Rust/JavaScript时间域需要校准并记录误差；提交证据来自真实React commit，不以收到IPC或下一次rAF代替。原工具关联覆盖、expected/read/published/received/committed分母继续保留。
- 记录启动可交互（区分构建时间与应用启动）、空闲/隐藏CPU与RSS、事件→界面提交p95/p99、主窗/托盘消息次数与载荷、WebGL帧间隔、插件启停后的回落。
- 128会话突发、超长JSONL行、大plist目录、100并发刷新、200历史替换、2000拓扑节点、插件反复启停/取消；记录真实负载与持续时间。SQLite锁和超时、损坏插件/包、网络失败和取消都必须保留诊断。
- 已有冻结预算只用作同口径参考，不无理由放宽。候选不得发生已观测OOM或无界增长；24h、睡眠/网络切换及16GiB硬件无证据时不能宣称通过。

### 构建与交付

- `cargo test`覆盖整个新核心（本次是跨全项目迁移，不能只挑一模块）；前端类型检查和纯逻辑测试；Tauri debug及release构建；真实无头场景；产物资源/依赖/架构/签名/体积检查。
- 发布包核验无Chromium/Electron/Node、无调试驱动、测试、源码、缓存或私有配置；记录新增crate和依赖体积。
- 仅停止本任务实例，按启动身份与工作目录验证退出，再清理本任务临时应用/目录；保留源码worktree、分支、包、证据和个人数据。正式应用路径与其他任务进程只读记录。
- 冻结源码清单同步纳入crates/src-tauri/native、Cargo manifest/lock、工具链、Tauri权限与生成输入；Tauri产物统一进入受控release子树。生产capabilities采用显式列表，应用commands使用AppManifest声明并按窗口授权，运行期仍校验实际窗口身份。验收driver及fixture必须非默认feature，发布脚本禁止该feature并核对构建feature和实际产物。

## 风险与评审关注点

- WKWebView的WebGL、透明背景和隐藏渲染与Chromium不同，必须真实验证，不能把保留TS界面当作零迁移。
- 原生插件大小、启动/取消和共享预算必须先证明；既有2MiB包预算可能与静态原生二进制冲突。
- Rust取消不自动终止阻塞SQLite、OS调用或孙进程，必须有明确worker中断和进程组归属。
- 更新安装属于高风险数据操作；仅完整签名验证与可回退替换代码不等于正式安装验收。
- 当前基准含并行任务未提交源码；迁移后还需按源快照识别后续并行变化，不能覆盖原分支或擅自合并。
- 本工作区固定Rust1.99；macOS27拒绝旧工具链部分release构建期动态库的LINKEDIT布局，升级本项目工具链后release构建通过。Node22.23.4满足前端工具要求，推荐Node24；不修改用户全局默认版本。

## 参考（2026-11-09核对）

- Tauri进程模型：https://v2.tauri.app/concept/process-model/
- macOS WKWebView：https://v2.tauri.app/reference/webview-versions/
- Tauri测试边界：https://v2.tauri.app/develop/tests/
- WebdriverIO Tauri及嵌入式驱动：https://webdriver.io/docs/desktop-testing/tauri
- Tauri官方更新器与签名要求：https://v2.tauri.app/plugin/updater/

本方案的功能依据是当前源码与复制基准；历史性能记录用于设计测量，不能充当新实现验证。评审结果与修订记录写入同目录 `review.md`；实施证据和交接随最终代码更新。
