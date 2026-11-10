# 桌面 API 与异步订阅契约

这是全量迁移的实施清单，覆盖原有42个公开方法及内部订阅协议。主窗记为M、托盘T、恢复窗R。授权来自宿主登记的真实WebView身份，不能由前端传label决定；所有命令均拒绝非法参数、未知键、失效窗口和退出阶段。恢复态只能R调用恢复三项。

## 命令与事件

|API方法|允许窗口|返回与错误语义|取消/释放所有者|
|---|---|---|---|
|monitor.snapshot|M/T|MonitorSnapshot；只读当前真实快照|无需新采集|
|monitor.refresh(section?)|M/T|void；合法分区或全部；同分区在途合并|插件代次/应用退出|
|monitor.retrySource(sourceId)|M|void；仅已声明可重试来源|对应来源/插件|
|monitor.focusAgentInTern(agentId)|M|{error:null或受控错误}；headless拒绝|单导航；10s总截止；窗口关闭/隐藏导航/退出|
|monitor.scheduleHistory(jobId,offset?)|M|ScheduleHistory；非Hermes返回unavailable|窗口；单active+单最新pending|
|monitor.cancelScheduleHistory|M|Promise<void>；取消必须等真实IO结束|当前窗口历史，不得取消其他owner|
|monitor.events(query?)|M|EventPage；严格查询、事件停用拒绝|新查询替换旧查询、窗口关闭/退出|
|monitor.cancelEvents|M|Promise<void>；清理失败显式拒绝|当前窗口事件查询|
|monitor.generateDiagnostics|M|ready/cancelled/error；唯一UUID预览|唯一操作、10分钟预览到期|
|monitor.copyDiagnostics(id)|M|copied/cancelled/error；只复制宿主预览|窗口、5s截止|
|monitor.saveDiagnostics(id)|M|saved/cancelled/error；系统选新文件，不覆盖|原生dialog owner、5s IO截止；提交后取消不撤回|
|monitor.cancelDiagnostics|M|Promise<void>；撤销预览并等清理|窗口关闭/导航/退出|
|monitor.navigation|M|NavigationIntent或null|单可替换槽|
|monitor.acknowledgeNavigation(sequence)|M|void；旧sequence不清新目标|宿主导航槽|
|monitor.onNavigation(listener)|M|同步幂等退订函数；无payload提醒|本组件listener；窗口销毁统一清理|
|monitor.subscribe(listener)|M/T|同步退订；MonitorUpdate分区事件|本组件listener与订阅计数|
|monitor.subscribeSources(listener)|M|同步退订；SourceHeartbeat|本组件listener与订阅计数|
|desktopSettings.snapshot|M/T|SettingsSnapshot，包含真实原生状态|不隐式申请权限|
|desktopSettings.update(patch)|M|ok snapshot或ok:false error；回滚失败fatal|最多16队列；串行事务；退出排空|
|desktopSettings.previewGlass(intensity|null)|M|void；仅当前窗口，错误可见|blur/hide/导航/取消恢复已保存值|
|desktopSettings.retryGeometry|M|SettingsUpdateResult；只保存宿主当前正常几何|同设置事务|
|desktopSettings.updateLoginItem(enabled)|M|LoginItemUpdateResult含actual state/rollbackFailed|headless/开发拒绝；写后读回|
|desktopSettings.requestNotificationPermission|M|NotificationState；仅显式请求|30s调用等待；系统pending直到真实回调释放|
|desktopSettings.showMainWindow(target?)|M/T|void；严格导航目标；headless拒绝|单主窗/导航槽|
|desktopSettings.subscribe(listener)|M/T|同步退订；SettingsSnapshot|本组件listener|
|appUpdates.snapshot|M|UpdateSnapshot|只读|
|appUpdates.check|M|UpdateSnapshot；禁用不发网络；30s|单operation|
|appUpdates.download|M|UpdateSnapshot；流式摘要/大小校验；15min|单operation；取消删除part并释放|
|appUpdates.cancel|M|UpdateSnapshot；取消下载后保留available|等下载与文件关闭|
|appUpdates.install|M|UpdateSnapshot；只能已下载且验证通过，120s|排空业务后移交可信安装助手；不await自身形成死锁|
|appUpdates.openReleaseNotes|M|void；固定受限发布URL；headless拒绝|系统外部打开|
|appUpdates.subscribe(listener)|M|同步退订；revision防旧状态覆盖|本组件listener|
|pluginMarketplace.snapshot|M/T|MarketplaceSnapshot|只读|
|pluginMarketplace.check|M|MarketplaceSnapshot；单exclusive|30s/退出|
|pluginMarketplace.install(id)|M|MarketplaceSnapshot；启用时真实首采样后成功，停用时静态验证后dormant提交且不启动进程|市场单事务；与设置启停共用串行协调|
|pluginMarketplace.update(id)|M|MarketplaceSnapshot；严格高版本；旧版验证下载期间运行|失败停止新代后恢复旧版；清理失败保留现场|
|pluginMarketplace.uninstall(id)|M|MarketplaceSnapshot；损坏包可卸载|先stop；进入删除提交后取消仍完成删除|
|pluginMarketplace.cancel|M|Promise<void>；等事务rollback/drain|市场当前operation|
|pluginMarketplace.subscribe(listener)|M/T|同步退订；真实状态|本组件listener|
|startupRecovery.snapshot|R|StartupRecoverySnapshot|只读受控故障|
|startupRecovery.retry|R|{ready:true}或{ready:false,snapshot}|合并重试；关闭后晚完成不启动正常宿主|
|startupRecovery.quit|R|void|关闭admission、取消retry、退出|

所有原有单向cancel方法迁为可等待Promise；全部消费者同步更新，事件处理器明确接住拒绝并展示真实诊断，不能留下未处理rejection。API方法数量不变，无旧Electron取消通道。

Rust错误对象的`code`、`message`、`osError`及`causes`由桌面适配器保留。聚合错误转换为`AggregateError`，普通错误消息同时包含有界因果摘要，来源页能够显示具体超限或权限原因。转换最多检查64个节点、8层及16KiB UTF-8消息；深度、节点、字节或重复引用导致省略时明确标注。无效错误对象显式报格式错误。该本地受控错误与可分享诊断报告的脱敏投影分别处理。

宿主最多接收16个在途桌面请求，其中普通业务请求最多12个，为文档登记、订阅握手、消息确认、取消和恢复窗口退出保留4个槽位。控制请求仍受同一个16槽总预算约束，超限明确返回`OC_IPC_BUSY`，不增加等待队列。业务请求并发突增不能饿死消息确认；突发全部完成后，下一次刷新及历史查询必须直接成功，不依赖前端重试。

## 监听就绪与首个快照

1. `desktop-api.ts` 在React挂载前初始化当前窗口允许的Tauri事件监听；全部 `listen()` 完成后才能挂载正常页面。恢复入口只初始化恢复API。
2. UI的subscribe向本地listener集合同步加入监听，并产生幂等退订函数；同一个回调重复注册也各自拥有独立订阅，退订一份不删除另一份。仅首个订阅/最后退订改变宿主兴趣。宿主interest只有一个在途更新和一个最新待提交状态，不能无界排队。
3. `snapshot()` 等待当时已请求的interest更新被宿主确认后才读快照。全局Tauri监听早已存在，因此注册期间不会丢更新；消费者保留现有“期间已更新分区不被旧snapshot覆盖”逻辑。
4. `desktop_interest` 上报当前文档对 monitor、sources、settings、updates、marketplace、navigation 六类消息的订阅兴趣；仅登记窗口允许的通道，sources 仅主窗可用。该内部命令不属于面向页面的业务 API，renderer 不能指定其他窗口。
5. `desktop_register` 返回必需的 `owner`、`view`、`headless`；前端严格验证后才挂载。生产推送要求原生可见且未最小化、当前document已登记且有对应订阅。无头窗口默认允许逻辑展示，仍要求显式订阅；统一的文档展示状态驱动数据、拓扑和预览的暂停恢复。性能探针只在无头模式显式覆盖该状态并发送可见性变更通知，不改写浏览器的 `document.hidden` 或 `visibilityState`。正常窗口继续服从真实原生可见性，用户暂停显示独立生效。
6. 退订即刻移除本地listener；宿主迟到事件不能回调已退订组件。文档重载/窗口销毁撤销整个登记。React StrictMode反复mount/unmount不增加常驻监听数量。
7. 初始注册失败阻止页面进入正常就绪，展示真实连接错误；不使用轮询snapshot或默认假数据兜底。

验收：监听建立期间真实数据变化、订阅握手期间变化、旧snapshot迟到、100次订退订、卸载先于listen完成、隐藏窗口增量、暂停后零回调、恢复最新快照、M/T互不影响。

## 登录与启动恢复

登录启动由系统真实状态判定，不接受普通页面伪造。此启动不创建主窗，本次运行关闭Dock和防休眠但不覆盖持久偏好，仅创建托盘。用户打开主窗复用当前应用；requires-approval不等于enabled。

普通启动设置读取只有ENOENT使用默认值；坏UTF-8/JSON、权限、FIFO、链接、身份变化进入恢复流程，原文件不覆盖。真实隐藏recovery场景使用验收专用配置创建隐藏恢复WebView；生产headless读取失败仍明确失败退出，不冒充已验证恢复UI。恢复窗口拒绝所有普通commands，修复文件后的并发retry只初始化一次；quit/close先撤销启动权，晚到retry不得复活应用。

## 事件与通知持久不变量

事件数据库保持既有application/schema ID、库身份、DELETE journal、revision CAS、checkpoint+events原子事务及查询触发保留裁剪的revision变化。tombstone最多32768并推进floor；删除/淘汰后不能重放旧异常，stable upper与keyset分页不重复、不跳过已冻结范围。数据库替换和游标断档必须可见。

通知claim写入私有0600日志并fsync先于原生show；未确认投递在重启后不重放。库identity变化重置正确cursor，同实体5分钟冷却与每分钟3条分别有界，恢复事件可解除冷却，静默/睡眠后的摘要保留上限。显示暂停不影响通知；停用事件/关闭通知/退出按各自生命周期取消并排空。journal或原生handle关闭失败优先于取消，禁止假成功。
