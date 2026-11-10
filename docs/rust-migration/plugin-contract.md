# 原生插件包与运行协议 v2

本文件是Rust迁移实施约束。仅可信官方插件；原生进程不是沙箱。删除CommonJS执行器及Rust动态库ABI方案。

## 包认证与文件布局

`.ocplugin`为ZIP，唯一根目录`<id>.ocbundle`，其中只有`Contents/Info.plist`、`Contents/MacOS/collector`、`Contents/Resources/manifest.json`及codesign生成的`Contents/_CodeSignature/CodeResources`。目录项允许，其他入口/可执行文件/资源拒绝。Info.plist固定CFBundleExecutable=collector、CFBundleIdentifier=`local.oc-chan.plugin.<id>`，版本与manifest一致。manifest使用apiVersion=2与target=`aarch64-apple-darwin`。

manifest位于Apple签名资源封印内；正式候选验证完整bundle签名、所有架构、Apple Developer ID信任、固定Bundle ID，以及与已完整验证当前宿主相同的Team ID。不能用codesign display字符串替代签名验证。宿主只信已绑定的catalog字段，安装/更新必须同时匹配版本、权限、入口、目标、大小和SHA256。

离线bundled包的可信摘要随宿主资源封装，允许ad-hoc本地构建执行这一精确构建产物；ad-hoc宿主不接受网络原生包，UI明确说明正式签名要求。正式在线包使用上述Developer ID链，manifest也受封印保护。重启前重新校验原始已安装archive及展开内容与对应可信根，私有安装目录中记录的digest不能自行成为信任根。验收feature可编入独立fixture摘要根，发布禁用该feature且产物无测试根。

## 预算与解压

|预算|上限|
|---|---:|
|archive原始字节|2MiB|
|manifest|16KiB|
|Mach-O入口|8MiB|
|总展开普通文件|9MiB|
|ZIP条目（含目录）|16|
|中央目录|64KiB|
|已登记插件|16|
|整个安装目录所有状态合计|32MiB|

全部上限在分配/写入之前检查。解析ZIP前检查文件总大小和EOCD/中央目录；拒绝ZIP64、多卷、加密、未知压缩法、绝对路径、点段、NUL、反斜线、Unicode规范化后冲突、重复条目、符号/硬链接及其他非普通类型。只支持stored/deflate。不能相信头部uncompressed size，每次读取/写入检查实际累计量，匹配CRC、原始长度和最终文件摘要。

市场安装前为`现有current+rollback+pending+下载archive+解压staging+新runtime所需文件`原子预留磁盘额度；旧包改名不重复计算同一文件，但copy必须计入。32MiB包含展开内容，不能只统计压缩包。按真实release系统插件测量archive、入口、展开总量、签名资源和事务峰值；未测量不得声称满足预算。

安装目录私有0700、文件0600、执行入口验证后0700；NOFOLLOW/NONBLOCK/EXCL、普通单链接，读取前后核验dev/ino/size/mtime/ctime。stage文件与目录fsync后再提交，失败清理不能静默忽略。

## 消息与双向分派

协议使用有界NDJSON。每帧编码后≤64KiB（包含换行、JSON转义和信封）；二进制chunk为base64，原始块≤16KiB。每条消息必须有`v:2`与`generation`；collect有单调`call`，host IO另有`io`。安全整数范围与过期代次明确校验；未知消息、重复完成、错序chunk、旧代回复视为协议失败，不伪造成功。

|方向|消息|语义|
|---|---|---|
|host→plugin|initialize|可信id、appVersion、generation、受限能力和协议预算|
|plugin→host|ready|确认当前代初始化完成；不得自行修改权限|
|host→plugin|collect|本代唯一采样call和剩余deadline|
|plugin→host|ioRequest|绑定call/io的宿主命令、受限文件或socket请求；参数、总输出和deadline在准入前冻结|
|host→plugin|ioChunk|stdout/stderr/data、连续seq、base64块；写入遵守背压|
|host→plugin|ioEnd|最终字节总量、退出状态/身份；仅实际子进程与stdio结束后发送|
|host→plugin|ioError|有界错误码；失败/取消不能产生ioEnd成功|
|plugin→host|resultChunk/resultEnd|采样结果UTF8 JSON分块，连续seq、声明总量≤1MiB、最终摘要；宿主有界重组后校验业务DTO|
|plugin→host|error|有界采样/协议错误，不含敏感原始输出|
|host→plugin|cancel|撤销指定call的发布与新IO权利，必须能在等待IO时处理|
|plugin→host|cancelled|plugin已排空该call；host仍要等待自己启动的IO真实结束|
|host→plugin|stop|关闭新工作，撤销全代，清理并退出|
|plugin→host|stopped|插件业务清理结束；host最后仍wait进程与管道|

读循环、写队列与collect执行分离；插件不能在等待hostIO结果时停止读控制帧。每插件一个collect、最多8项hostIO，写队列最多4个编码帧；读缓冲最多一帧。stdin/stdout使用流式读取，换行超过64KiB立即失败；总结果超过1MiB立即拒绝。stderr每代保留≤64KiB，超限明确失败。

SDK只提供已授权的固定命令和只读路径能力；host按manifest能力重新校验，不接受通用shell。环境从明确白名单创建，不复制宿主完整环境或凭据。官方插件禁止自行spawn、daemonize、改变进程组或创建未登记常驻资源；这是一方代码契约，不称作OS强制隔离。

## 全局准入与取消

唯一资源账本同时管理原有command/file/socket预算，以及pluginProcesses≤16、pluginProtocolBytes≤8MiB；不能为每个插件另开独立“全局”池。插件进程槽不占一次性command槽，插件等待IO时不持该IO的另一个lease，避免嵌套申请。

协议的队列/读缓冲/结果重组在启动或collect前预留；原始hostIO输出与插件重组是两份内存，均计入申请，base64/JSON暂存以最大帧预留。原有4MiB ps输出通过ioChunk传输，不放宽帧限制，也不截短合法结果。

host启动的每项命令登记`pluginId/generation/call/io/pid/birth/pgid`；它可能不是plugin子进程，取消不能只杀plugin进程组。取消顺序：撤销发布和新IO准入→取消该call所有已登记IO→发送cancel→等待IO/stdio/插件确认。deadline到期按已登记身份终止并wait；归属不明时保留诊断，不按PID或进程名盲杀。清理失败使代次不可重启、文件不可卸载，应用退出继续清理其他插件并聚合失败。

## 安装事务

沿用download/validate→pending fsync→stop旧代→current改rollback→pending改current→按目标分区启用状态注册→删除rollback的提交顺序。安装与设置启停共用串行协调锁，提交依据锁内一致状态：启用时启动新代并等待真实首采样成功；停用时只验证静态契约并登记dormant，不spawn、不initialize、不采样即可提交，后续显式启用再真实初始化，失败如实报告。下载和验证阶段旧版继续工作；下载或签名错误不停止旧版。激活失败先排空新代再恢复旧目录与runtime；停不掉不得删除文件或并行运行另一版。

恢复记录绑定目录和archive身份；启动存在rollback优先恢复旧版并显示interrupted，只有pending无current恢复未安装。损坏包保持已安装标记且可显式卸载。卸载stop完成后进入文件删除提交阶段，此后取消不留下半删除状态。close关闭准入并等待单事务真实结束。

前置证明：真实system插件SDK请求4MiB输出、collect期间cancel/stop、乱序/超帧/截断、管道背压、宿主IO子进程回收、100启停后预算归零；真实release包大小与签名资源覆盖；篡改manifest/入口/版本拒绝；启用和停用两种状态下的安装、升级失败回退、设置切换竞争、取消、重启恢复与卸载；停用安装全程没有插件进程或采样。
