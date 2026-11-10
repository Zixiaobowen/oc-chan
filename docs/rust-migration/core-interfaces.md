# Rust 核心实施接口

本文件供当前实现切片集成；它描述接口和所有权，不是完成或验收回执。

`oc-core/src/model/` 是共享业务 DTO；`SourceState/AgentKind/AgentState/ActivityKind/JobScope/JobOrigin/JobKind/JobState/JobStateReason/RunResult/ExecutionStatus/DeliveryStatus/LocalEventType/MonitorSection` 用 serde 枚举保留 TS 字面量。可选字段缺失和 null 的区别保留。类型由主代理维护，切片需要新增字段时先报告，不另造同名接口。

`error::Result<T, E = Error>`，`Error::new(code,message)`、`Error::io(operation,ioError)`、`Error::limit(scope,limit,observed)`、`Error::invalid(field)`、`Error::cancelled()`、`Error::aggregate(errors)`；`is_cancelled()`、`is_cleanup()`；`timestamp()` 返回毫秒 UTC ISO；`validate_text(text,UTF16上限,UTF8上限,field)`。

`BoundedIo` 可 clone，共用唯一 `ResourceBudget`。异步方法：

- `read_file(source: &str,path: &Path,max_bytes: usize,nofollow: bool,cancel: &CancellationToken) -> Result<FileRead>`。
- `read_range(source,path,offset: u64,max_bytes,cancel) -> Result<FileRead>`，NOFOLLOW，只读取当前可用有界片段；返回读取后真实身份，调用者核对增量游标。
- `read_directory(source,path,max_entries,max_name_bytes,cancel) -> Result<Vec<PathBuf>>`，枚举包含忽略项，超限显式失败。`read_private_directory` 同签名，NOFOLLOW、同 FD 验证 uid=getuid 和 mode&077=0，显式等待 closedir。
- `metadata(source,path,nofollow,cancel) -> Result<FileMetadata>`：路径元数据（nofollow 时 lstat），含 identity/is_file/is_dir/is_symlink。私密文件必须用 read_file 同句柄返回的身份校验，不能把两次路径查询称为原子校验。
- `command(source,spec: CommandSpec,cancel) -> Result<CommandOutput>`。固定绝对可执行路径、参数向量、不调用 shell；返回非零退出状态由具体采集器分类。`.success()` 要求0，`.stdout_text()` 严格 UTF8。
- `socket(source,path,input: Vec<u8>,max_bytes,timeout: Duration,cancel) -> Result<Vec<u8>>`，读首换行完成，不要求服务端关闭连接；缺失完整行或超限返回明确错误。
- `write_atomic(source,path,bytes,cancel) -> Result<()>`。`OC_ATOMIC_COMMIT` 明确表示 rename 已发生但目录持久同步失败，事务 owner 必须恢复或报告不确定状态。
- `resources()` 返回统一预算；`cancellation()` 返回应用退出子token；`shutdown()` 关闭准入并取消、等待所有真实IO。
- `with_file_budget(source,bytes,cancel,work) -> Result<T>`：受监督私有文件事务；work 接收独立取消 token，完成真实 IO 与清理后释放租约。不能在闭包中嵌套申请其他 IO 租约。

`CommandSpec::new(executable,args,limit,timeout)`，可设 stdout_limit/stderr_limit、input、input_file(InputFile{path,max_bytes,identity})、env。环境默认只含固定PATH/LC_ALL；必须明确加入HOME/TZ等实际需要的字段，不复制凭据。输入文件与命令以一个复合租约原子计费，不能嵌套拿IO额度。

`FileIdentity{dev,ino,size,uid,mode,nlink,mtime,mtime_nanos,ctime,ctime_nanos}`；`FileRead{bytes,identity}`；`ProcessIdentity::read(pid)` 读取真实libproc出生身份，`started_at()` 输出ISO。pid复用不可按pid直接猜身份；Agent UI started_at 保留会话开始时间语义，导航另取采集器内部保存的 ProcessIdentity。

IO监督任务持有租约直到实际操作和清理完成；调用者取消或drop只撤销/发取消，不提前归还。长生命周期插件另用`resources.acquire(source,Request::Plugin{bytes},cancel)`，不能持普通command lease去申请host IO。sources最多32，请复用现有source分组。

共享核心模块不会自行初始化正式应用数据。采集器构造时注入 home、受限source路径、io、worker路径与token；启动器用独立profile。正式持久位置显式是`~/Library/Application Support/OC Chan`。

`worker::DataWorker::new(io,executable)` 与异步 `request(operation,database,input,cancel)` 使用独立原生 `oc-data-worker`：3s 执行截止，stdin≤512KiB，stdout≤4MiB（历史128KiB），stderr≤64KiB。取消由共享 IO 监督 kill/wait/排空；有类型的 Error 在 worker 与宿主之间传输，SQLite 同步操作只允许在 worker 入口调用。
