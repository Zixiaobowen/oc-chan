# 桌面 API 与异步订阅契约

React 通过 `src/renderer/src/desktop-api.ts` 的 Tauri invoke/listen 桥接调用下表命令。唯一桌面宿主为 `src-tauri`；命令白名单在 `src-tauri/src/commands.rs`，权限在 `api.rs`，文档生命周期在 `documents.rs`，分派与状态发布在 `host.rs`。主窗记为 M、托盘 T、恢复窗 R。权限来自真实 WebView、已登记文档的 owner、key 与 epoch，不能由参数伪造；非法参数、未知键、失效文档及退出阶段均拒绝。下表描述当前接口，验收结论以对应运行证据为准。

## 命令与事件

|动作名称|允许窗口|返回与错误语义|取消与释放|
|---|---|---|---|
|`monitor_snapshot`|M/T|当前真实 MonitorSnapshot|不启动额外采集|
|`monitor_refresh`|M/T|合法分区或全部；同分区合并|插件代次与退出|
|`monitor_retry_source`|M|仅已声明可重试来源|对应来源与插件|
|`monitor_focus_agent_in_tern`|M|受控错误；无头拒绝外部跳转|单导航、10s 截止、隐藏或退出取消|
|`monitor_schedule_history`|M|ScheduleHistory；非 Hermes 明确 unavailable|owner 的历史槽，替换前取消排空|
|`monitor_cancel_schedule_history`|M|等待真实 IO 结束|仅本 owner|
|`monitor_schedule_detail` / `monitor_cancel_schedule_detail`|M|按需读取当前任务白名单配置；取消等待真实 IO 排空|文档独立配置槽，与历史槽分离；切换、关闭和离页释放|
|`monitor_events`|M|EventPage；严格查询，停用拒绝|owner 的事件槽|
|`monitor_cancel_events`|M|等待清理，错误保留|仅本 owner|
|`monitor_navigation`|M|NavigationIntent 或 null|单可替换槽|
|`monitor_acknowledge_navigation`|M|旧 sequence 不清除新目标|宿主导航槽|
|`diagnostics_generate`|M|ready/cancelled/error，唯一预览 ID|唯一操作，10 分钟预览到期|
|`diagnostics_copy`|M|只复制当前宿主预览|owner、5s 截止|
|`diagnostics_save`|M|原生对话框选择新文件，不覆盖|对话框 owner；提交后的取消不撤回文件|
|`diagnostics_cancel`|M|撤销预览并等待排空|窗口关闭、导航、退出|
|`settings_snapshot`|M/T|SettingsSnapshot，包含只读 reducedMotion 等系统状态|不隐式申请权限|
|`settings_update`|M|成功快照或明确失败；回滚失败保留|串行事务，退出排空|
|`settings_preview_glass`|M|本窗口临时强度或 null 撤销|失焦、隐藏、离页恢复保存值|
|`settings_retry_geometry`|M|只保存宿主读取的正常几何|设置事务|
|`settings_update_login_item`|M|真实系统状态和回滚结果|开发、无头拒绝；写后读回|
|`settings_request_notification_permission`|M|NotificationState，显式请求|系统 pending 保留到真实回调|
|`settings_accessibility_state`|M|只读授权状态，不弹框|无头明确 unavailable/unknown|
|`settings_open_permission_settings`|M|仅固定辅助功能/通知设置页|无头拒绝外部打开|
|`settings_show_main_window`|M/T|严格导航目标|单主窗、单导航槽；无头拒绝显示|
|托盘组合本地存储|T|React 在当前 profile 中保存组合，失败明确显示|不新增通用文件或托盘偏好 Tauri 命令|
|`updates_snapshot` / `updates_check`|M|宿主更新状态；开发/无头仅探测|生产显式检查由 Sparkle 标准界面处理，自动检查由 Sparkle 调度|
|`updates_set_automatic_checks`|M|设置反映 Sparkle 自动检查状态|自动下载关闭，普通退出不自动安装|
|更新下载、安装与重启|Sparkle|标准更新界面及签名校验结果|不再提供旧核心 `updates_download` / `updates_cancel` / `updates_install` 命令|
|`updates_open_release_notes`|M|固定受限发布 URL|无头拒绝外部打开|
|`marketplace_snapshot`|M/T|MarketplaceSnapshot|只读|
|`marketplace_check`|M|单独占目录检查|30s/退出|
|`marketplace_install` / `marketplace_update`|M|启用时真实首采样后成功；停用时静态验证后提交|单事务；失败排空并回滚|
|`marketplace_uninstall`|M|损坏包也可卸载|先停插件；提交后取消仍完成删除|
|`marketplace_cancel`|M|等待真实回滚及排空|当前市场事务|
|`recovery_snapshot` / `recovery_retry` / `recovery_quit`|R|受控故障、重试结果或退出|关闭先撤销启动权，晚到重试不得复活应用|

取消命令返回可等待的异步 Promise；消费者必须展示真实错误并等待资源排空，不允许把取消发出当作完成。生产只使用 Tauri 命令白名单，不保留 Electron 通道或 GPUI 动作兼容层。

Rust错误的`code`、`message`、`osError`及`causes`须保留在本地受控诊断中，桥接保留真实因果链和聚合原因。界面应显示有界因果摘要；共享诊断另做脱敏投影。64节点、8层、16KiB UTF-8消息上限与明确省略标记仍是错误展示要求，不能静默截断或隐藏错误。

当前宿主最多接收16个在途请求，普通业务最多12个，为取消、推送确认和恢复退出等控制命令保留4个槽位，控制命令仍受16总预算约束。超限返回`OC_IPC_BUSY`，不增加等待队列。业务突发不得饿死取消；完成后新刷新与历史查询应直接可用，不依赖界面重试。

## 状态订阅与首个快照

`desktop_register` 建立文档身份；监听与 `desktop_interest` 声明数据兴趣，`desktop_committed` 报告真实 React 提交，`desktop_ack` 确认推送。宿主按通道/分区保留最新值，每文档最多一个在途推送、13个待处理流和16MiB待处理字节。主窗、托盘、恢复窗通过 `Document` 绑定身份与取消令牌，历史、任务配置、事件和诊断各自拥有释放责任；重载撤销旧 epoch，旧文档不能继续调用。

必须保持原有语义：订阅建立期间不丢最新状态，迟到快照不覆盖较新分区，离页/隐藏取消对应查询，销毁会话禁止晚到结果复活视图；M/T相互独立，恢复窗口不能调用普通业务动作。用户暂停显示独立于后台采集，恢复应呈现最新快照。原生隐藏验收模式不得误当真实可见窗口；生产可见性、最小化、预览取消和资源暂停仍需按实际窗口事件验证。

React 订阅释放与宿主文档销毁相互配合；重复进入和退出不得累积常驻监听。导航事件携带当前 intent，消费者读取待处理目标并按 sequence 确认；重复值比较不得丢失新序号。初始化失败显示真实错误，不生成假快照。

待验收范围仍包括：初始化期间变化、旧快照迟到、100次进入退出、隐藏窗口增量、暂停后零视图回调、恢复最新快照以及M/T互不影响。历史Tauri或GPUI证据不能当作本次恢复实现已通过的证据。

## 登录与启动恢复

登录启动由系统真实状态判定，不接受普通页面伪造。此启动不创建主窗，本次运行关闭Dock和防休眠但不覆盖持久偏好，仅创建托盘。用户打开主窗复用当前应用；requires-approval不等于enabled。

普通启动设置读取只有ENOENT使用默认值；坏UTF-8/JSON、权限、FIFO、链接、身份变化进入恢复流程，原文件不覆盖。验收配置可创建真实隐藏 WKWebView 恢复窗口；生产headless读取失败仍明确失败退出，不冒充已验证恢复UI。恢复窗口拒绝普通命令，修复文件后的并发retry只初始化一次；quit/close先撤销启动权，晚到retry不得复活应用。

## 事件与通知持久不变量

事件数据库保持既有application/schema ID、库身份、DELETE journal、revision CAS、checkpoint+events原子事务及查询触发保留裁剪的revision变化。tombstone最多32768并推进floor；删除/淘汰后不能重放旧异常，stable upper与keyset分页不重复、不跳过已冻结范围。数据库替换和游标断档必须可见。

通知claim写入私有0600日志并fsync先于原生show；未确认投递在重启后不重放。库identity变化重置正确cursor，同实体5分钟冷却与每分钟3条分别有界，恢复事件可解除冷却，静默/睡眠后的摘要保留上限。显示暂停不影响通知；停用事件/关闭通知/退出按各自生命周期取消并排空。journal或原生handle关闭失败优先于取消，禁止假成功。
