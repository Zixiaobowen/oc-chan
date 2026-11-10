# Rust / Tauri 迁移方案评审

日期：2026-11-09。评审对象：`plan.md` 及当前源代码。两个独立 reviewer 分别覆盖功能/验收与插件/更新/资源边界。本文件记录方案问题，不把尚未实现的代码描述为已有缺陷。

## 第一轮：功能与验收

评审者：RustMigrationPlanReview。结论：无P0，存在一个P1和一个P2；修订前不可进入全量实施。

|优先级|发现|处理要求|状态|
|---|---|---|---|
|P1|“仅向可见窗口推送”与默认无头验收冲突|headless仅绕过原生可见性门禁，仍要求真实订阅；隐藏收到增量、退订停止、恢复取最新状态都要验证|已修订，待复核|
|P2|通知行把“暂停显示”误写为取消通知|显示暂停不影响后台采集或通知；关闭通知/停用事件/睡眠/退出分别处理|已修订，待复核|
|契约缺口|42个方法未逐项列明；listen注册与初始snapshot竞态|api-contract.md逐项列明；React挂载前监听就绪、snapshot等待interest握手|已修订，待复核|
|契约缺口|登录启动与启动恢复场景不完整|登录不建主窗、Dock/防休眠本次关闭；隐藏recovery独立验收|已修订，待复核|
|契约缺口|事件和通知持久语义过于概括|明确revision CAS、tombstone/floor、数据库identity、claim先于show、未确认不重放|已修订，待复核|
|前置证明|隐藏WKWebView、插件协议、原生包大小、原生状态、安装回退|实施先验证真实链路；证明前不能删除可用基准|已纳入修订要求|

已确认不再阻塞：独立Rust SQLite worker、原持久目录、UTF-16长度与纳秒排序、WebKit XPC归属和Rust/JS时钟问题。Developer ID/公证/外部发布权限只限制对应生产验收，不阻断本地实现。

复核结论：RustMigrationPlanReview已阅读四份修订文档，确认上一轮P1/P2及列出的契约缺口全部关闭，未发现新的阻塞；允许进入实施，前置探针仍为第一步，未宣称运行通过。

## 第二轮：边界与交付

评审者：RustMigrationBoundaryReview。结论：有三个P1和一个P2，修订前不可冻结插件及更新器契约。

|优先级|发现|修订|状态|
|---|---|---|---|
|P1|裸可执行签名未认证独立manifest，重启信任根不明|采用Apple签名.ocbundle资源封印覆盖manifest；正式完整Developer ID同宿主Team；ad-hoc仅bundled固定摘要，执行前复验|已修订，待复核|
|P1|ZIP压缩/展开/事务峰值预算混淆|archive2MiB、manifest16KiB、入口8MiB、展开9MiB、16项、central64KiB；全部安装与事务32MiB，逐写检查|已修订，待实产物证明|
|P2|1MiB消息无法携带合法4MiB命令结果|改64KiB编码帧、16KiB块、ioChunk/End/Error及结果分块；序号/总量/代次验证，独立控制循环|已修订，待复核|
|P1|更新rename不等于成功且缺崩溃恢复|独占锁、路径/出生身份、持久阶段、真实就绪回执+2s存活后提交；每个中断点恢复规则|已修订，待复核|
|契约缺口|常驻插件占工作槽、孙进程取消、开发驱动权限、构建输入|同一账本分插件槽；登记每项hostIO归属；AppManifest和显式capabilities；发布feature门禁和完整冻结输入|已纳入|

详细修订位于api-contract.md、plugin-contract.md、update-contract.md及plan.md。已请求两位评审者复核；前置探针属于实施第一步，文档修订不冒充探针通过。

边界复核新增两个具体问题：更新rename已完成而阶段记录未落盘的崩溃窗口，以及停用插件安装不应强制首采样。已分别补写前意图/双合法身份组合的幂等恢复，以及enabled首采样、disabled dormant不启动的双路径；对应故障注入和设置协调验收已补。请求最终定点复核。
