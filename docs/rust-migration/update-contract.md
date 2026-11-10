# 更新与安装事务契约

Rust更新控制器替换Electron/Squirrel。该实现不发布资产、不替换本机正式应用；正式接受路径需要Developer ID、公证与相应用户操作。本文件要求本地隔离环境完成真实文件/进程事务测试，不能只mock成功。

## 发布源与下载

固定仓库`Zixiaobowen/oc-chan`；新元数据`latest.json`，schema2、严格稳定semver、最多8资产，每资产固定arm64目标、匹配文件名、实际大小及SHA512。未知字段拒绝。元数据≤64KiB；下载≤512MiB；仅HTTPS的github.com/release-assets.githubusercontent.com/objects.githubusercontent.com，最多5次跳转，禁止credentials、用户输入源和生产测试地址。

check30s、download15min、install120s；仅完整更新资格启动30s和每6h自动检查。开发/未Developer ID签名保留disabledReason，但初始phase为idle，允许显式手动检查、查看结果和错误重试，禁止下载和安装；不支持的平台phase为disabled且不发网络。手动检查调整下一次截止；不自动下载、安装。一个operation，revision单调，旧回调不能覆盖新状态。

下载前磁盘可用≥size×5+256MiB；独占0600 part文件，流式写入并逐块检查声明/总上限，SHA512一致且fsync/close后rename提交。250ms节流进度。cancel等网络reader、文件和清理结束后回available；清理失败显示error。普通退出丢弃暂存且不安装。

## 信任验证

可信当前应用先通过完整代码签名及Apple Developer ID要求验证，再读取Team identity。候选的固定Bundle ID=`local.oc-chan.desktop`，必须严格高版本且等于元数据版本、目标arm64、结构与Mach-O一致，完整签名与Apple信任有效且同Team。manifest/资源属于签名封印，不能只读取codesign display文本判断有效。

解压采用有界、安全文件规则，拒绝链接越界/路径冲突/重复条目/非法模式；只允许标准bundle内合法相对symlink且其解析完全位于候选bundle，无法证明则拒绝。最终同卷暂存位置重新核验签名、内容摘要及路径身份，阻止验证后替换。安装助手来自当前已验证应用的资源，不能执行下载包提供的安装脚本。

## 持久事务

独占安装锁属于目标目录，锁文件和父目录验证私有/合法身份；当前目标、暂存、备份、父进程都绑定realpath及dev/ino或pid/birth。用户取消仅能发生移交前；进入替换后按事务完成或恢复，不能半途丢弃。

在目标同卷创建私有事务目录，记录UUID、预期版本、目标/旧包/新包身份、父进程出生身份、各阶段和摘要；记录原子写+fsync，阶段转换同时fsync父目录。阶段：

1. `prepared`：验证旧/新签名与身份并预留空间；旧应用仍运行。
2. `waiting-parent`：业务已关admission、排空真实任务；助手再次验证父身份并等待退出，超时不替换。
3. `backup-intent` / `old-backed-up`：先持久化源/目标身份与备份意图并fsync，再核对身份执行旧包rename、fsync目录，最后记录完成；记录落盘后到rename前、rename后到完成记录前都允许崩溃恢复。
4. `install-intent` / `new-installed`：先持久化暂存到正式目标的意图、身份和摘要，再rename、fsync目录并记录完成；旧包仍保留。
5. `verifying-startup`：使用唯一事务UUID和私有回执路径启动新应用；等待真实就绪。
6. `committed`：验证就绪后持久提交，才允许清理旧包和事务目录。
7. `rolling-back` / `rolled-back`：启动失败、超时或验证不符先停止且确认新实例身份/退出，再恢复旧包；恢复失败保留两份现场并非零退出。

崩溃恢复同时检查写前意图和实际身份，接受操作尚未发生与已经发生两种合法组合：waiting-parent/backup-intent时若登记旧包仍在目标则保留，若旧包已在登记备份且目标缺失则恢复旧包；old-backed-up/install-intent时若登记新包仍在stage且目标缺失则恢复旧包，若登记新包已在目标则按未提交新版停止并回滚。new-installed/verifying-startup没有持久commit一律恢复旧包；committed只保留已验证新目标并清理登记备份。回滚rename也遵循写前意图、目录fsync和幂等身份判定。真正未知身份或不可能组合才停止并保留现场，不将正常崩溃窗口误报为篡改。恢复不需要运行不可信candidate。

## 成功回执

回执来自被启动的新应用，0600独占文件/私有目录，包含事务UUID、bundle realpath、版本、pid与birth、宿主版本、真实renderer入口提交、IPC往返、已启用采集分区就绪、Hermes历史可用性及system未装/已装状态。未知/unsupported按真实来源表达，不能强求用户没有的来源成功，也不能跳过已安装但失败的插件。

助手校验全部字段和当前NSWorkspace运行实例、真实可执行路径、出生身份及finishedLaunching，再等待2秒确认持续存活。只spawn、只rename、只首帧或只snapshot不算安装成功。最大等待45s，受120s整体事务截止约束；过期/伪造/其他实例回执拒绝。

## 临时环境验收

仅在本任务临时目标目录用真实app bundle/进程验证：正常替换、父实例变更、目标inode变化、候选篡改、锁竞争、磁盘不足、每个阶段及每次rename之后/完成记录之前/记录已写但未fsync的中断恢复、新应用启动失败/迟到回执/假回执、恢复失败保留双方、成功后旧包清理。测试信任根仅测试feature，正式签名接受路径没有凭据时明确未验证，不以ad-hoc接受冒充Developer ID。

本地安装脚本和自动更新复用同一事务与就绪协议；`push:main`仍必须等GitHub实际接收且远端确认后才清理归属明确的资源，不把pre-push视为成功。所有新构建应用归入受控release目录，源码worktree、分支、用户数据、ZIP/DMG和证据不自动删除。
