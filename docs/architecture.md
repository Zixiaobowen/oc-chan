# 架构与插件

[返回首页](../README.md)

OC Chan 使用 Rust 业务核心与 React 19 界面，Tauri 2 在 macOS 的 WKWebView 中承载页面。React Flow 管理 2D 关系图，Three.js 管理项目建筑群。核心维护共享契约、生命周期和资源预算，具体采集能力通过插件接入。工程约束见[工程规则](../AGENTS.md)。

## 实现

- `crates/oc-core/`：Agent 发现与实时会话、任务/历史、事件/通知策略、设置事务、诊断、导航、插件调度和市场；不依赖界面窗口对象。应用更新由 Rust 宿主接入 Sparkle。
- `crates/oc-plugin-sdk/`：原生插件协议、公开数据与有界宿主IO契约。插件只依赖SDK，不读取核心或其他插件私有状态。
- `plugins/system-monitor/`：独立Rust系统采集器、清单及边界测试；不编译为核心内置系统采集实现。
- `crates/oc-installer/`：本地安装就绪库；旧在线安装助手已删除，Sparkle 管理在线更新的安装与重启。
- `src-tauri/`：Tauri 窗口、托盘、启动恢复、受限 IPC、文档 owner、安装就绪与应用退出。
- `src/renderer/`、`src/shared/`、`src/plugins/`：React 页面、设计变量、共享类型、Three.js / React Flow 场景和前端插件贡献。
- `native/`：C ABI的AppKit/UserNotifications/ServiceManagement/IOKit桥接，以及Swift的Tern窗口助手；没有N-API。
- `scripts/build-app.mjs`、`dist.mjs`、`develop.mjs`：受控构建、打包与隔离实例；Node只运行这些开发工具。

WebView/AppKit 主线程处理窗口和平台 UI，异步业务由 Tokio 执行。原生桥与 IPC 请求受在途数量约束，不能无界发布。SQLite 及受限 HTTP 使用独立 `oc-data-worker`，请求计入同一资源池；取消须终止并 wait 真实子进程、排空 stdio，才能归还资源。不能用取消 future 或超时包装假装同步工作已经结束。

生产页面使用打包的 React 资源，CSP 与 Tauri capability 限制入口。IPC 按主窗、托盘、恢复窗限制能力，并验证真实 WebView 来源、文档 key、owner、退出阶段与参数；不信任页面自报的窗口身份。拒绝非法字段/输入时不回显原始载荷。周期采集只输出白名单元数据；任务配置正文仅在用户打开详情时有界读取，不进入周期快照、事件或诊断，不执行任务。

### 采集与资源生命周期

注册表校验稳定ID、能力、采样周期、超时、重复ID、依赖环和来源重试声明。插件按需创建；在途采集合并，慢周期不重叠，手动刷新不推迟原有周期。首轮采集成功才发布已激活状态，迟到结果不能写入新代次。

停用立即撤销该代发布权并取消在途工作，真实采集和清理结束后才报告停止。保留原快照及采集时间；卸载清除对应分区，偏好仍保留。再次启用创建新实例，重新建立CPU、网络与趋势基线。超时不能当作清理成功，失败继续保留归属与可定位错误；退出排空所有插件并汇总失败。

「数据来源」分别控制Agent、任务/历史、系统、本地事件采集。系统未安装时不初始化采集器；暂停显示只控制界面订阅，不停止采集或通知策略。设置启停与市场变更共用串行协调，保存失败恢复原状态，回滚失败显式报告。

全局命令、文件、socket各8槽，排队总量256、单来源128、来源32，排队限时10秒。命令输出、文件、socket及插件协议都有独立字节预算；插件常驻进程和协议缓冲也记入同一账本。Agent会话上限128，历史每页25，事件每页50、最多10000条/7天/20MiB，诊断最多256KiB。读文件、解析单条JSONL、查询数据库及IPC输出均在分配前校验边界，超限明确拒绝。

调度目录按稳定顺序扫描，plist转换每批最多4个，共用上述IO资源池；不为并发提高全局预算。每批真实工作全部收尾后，按原文件排序更新有界缓存并合并重复Label，首轮完整采集成功后才发布快照。窗口初始化仍等待服务就绪，不能通过提前解除首快照屏障掩盖采集耗时。

事件的revision/checkpoint与新增记录原子提交，游标、tombstone、保留裁剪和重启去重保持一致。通知默认关闭，认领日志先持久化再请求原生投递；未确认投递不会因重启重放。系统权限、无头不支持、来源断档和未知状态都保留明确语义。

### 插件市场与独立插件包

系统监控首次运行不自动安装。构建资源包含固定摘要的离线目录和包；安装、检查、更新、取消、卸载由市场统一管理。安装目录使用profile下的`plugins-v2/`，不读取旧CJS格式，不自动删除旧个人插件目录。

`.ocplugin`是有界ZIP，内部为Apple代码签名封装的`.ocbundle`。manifest位于资源封印中，入口是独立Mach-O进程。包校验包含摘要、条目/展开上限、manifest、API版本2、平台、宿主版本、真实架构和签名；每次启动复验，不信任可写目录中自报的校验值。

原生插件使用有界NDJSON，独立控制读取循环使取消和stop不被采集占住。请求绑定ID和代次，宿主IO分块且必须结束确认。插件无凭据环境，官方SDK不提供自行spawn或daemonize；可信原生代码不是安全沙箱。完整消息和资源约束见[插件契约](rust-migration/plugin-contract.md)。

`npm run build:plugins`生成`out/plugin-market/catalog.json`及版本化包；完整应用构建把同批资源和固定摘要打入产物。普通ad-hoc宿主只允许执行本构建固定摘要的离线包，在线执行安装禁用。正式在线包必须具备Developer ID信任链，并与已验证宿主同Team、满足固定插件Bundle ID；没有用户自定义URL或第三方代码导入。测试HTTP目录和测试摘要信任根仅在`acceptance`构建存在。

包上限：压缩2MiB、manifest16KiB、入口8MiB、总展开9MiB、条目16、中央目录64KiB；最多安装16包，已安装、下载、暂存与回滚合计32MiB。事务预留峰值后才能写入，下载与展开逐块复核。更新下载期间旧版继续运行；新代激活失败必须先排空再恢复旧版，取消等待回滚和资源释放。损坏包仍可卸载，重启诊断未完成事务，不能静默丢失错误。

### 视图状态与业务动作

Rust 宿主装配服务并发布有界最新状态，React 通过文档级订阅接收。文档 owner、epoch 与 key 绑定真实 WebView；事件序号与 ACK 限制在途推送，按通道合并最新值。重载或关闭撤销 owner，取消并排空历史、任务配置、事件、诊断和 Tern 请求。订阅屏障防止首快照丢失更新；隐藏/暂停恢复时读取最新状态，不回放全部中间帧。

桌面动作与采集 IO 分别计量：最多 16 个动作在途，普通业务最多 12 个，为取消和恢复退出保留容量。超限立即返回 `OC_DESKTOP_BUSY`。

主窗提供监控、来源重试、任务管理、历史/事件查询、诊断、设置、导航、插件市场及应用更新；托盘只读必要快照与受限导航，恢复窗只有故障读取、重试与退出。任务写入经调度插件调用已安装的 Hermes CLI，固定到默认 profile。调度插件串行核对写入并刷新；子进程受全局 IO 额度约束。诊断复制/保存只接受当前预览 ID，文件位置由原生对话框取得；窗口几何只能由宿主读取。无头实例禁止外部窗口跳转、登录项变更和权限申请。


### 原生与交付边界

Tern助手位于`native/tern-present.swift`，配合`resources/tern-navigation/plugin/`重新核对会话、进程出生身份、签名和唯一原生窗口；缺权限、歧义或目标变更均可见。Liquid Glass采用公开`NSGlassEffectView`，每窗最多一个实例，强度0立即释放，辅助功能设置优先。

应用更新使用 Sparkle 2.10.1 完整官方 framework 和上游签名 helpers，以归档 SHA-256 与逐文件 pin 校验，包括不能裁剪的封印内 Headers/Modules。生产固定读取 GitHub Releases 的 `latest/download/appcast.xml`，Ed25519 签名覆盖 feed 和 ZIP；启用提取前验证及签名 feed，签名过期 fallback 为 0。React 设置显示状态与自动检查选项，下载、安装和重启由 Sparkle 标准界面负责；自动下载关闭，普通退出不自动安装。开发/无头只探测。旧核心更新器、`latest.json` 和在线安装助手不再保留；本地安装就绪库独立保留。应用更新无需付费 Apple 会员，但 ad-hoc 不等于公证或 Gatekeeper 豁免；插件市场的独立信任要求不因此放宽。契约见[应用更新](rust-migration/update-contract.md)，签名与包检查见[发布文档](distribution.md)。

验收驱动和 WebKit 截图钩子只在 `acceptance` feature 编译。默认通过 `npm run dev` 启动隔离、隐藏、不抢焦点的 Tauri 应用；认证 Unix socket 驱动实际 WebView 与 DOM 操作，截图来自真实 WebKit 渲染。单元测试、真实无头应用、签名产物、正式安装、系统权限和可见动效是不同证据，不能互相代替。

## 品牌资源

品牌采用蓝白OC配色，O/C连成观察双眼。仓库首页与侧栏共用`resources/brand/oc-chan-icon.svg`，macOS安装包使用同套图标；菜单栏为22×18点的单色Template Image。可编辑与导出资源均位于`resources/brand/`。
