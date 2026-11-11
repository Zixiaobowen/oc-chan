# OC Chan 隐式状态机专项审计

本次在当前工作区确认 **48 个状态对象：41 个隐式状态机、7 个混合模型**。混合模型已有明确的 phase/status 名称，但实际转换仍由其他标志、Promise、计时器或资源所有权共同控制。48 是本次语义去重后的清单数量，不是程序数学证明的全部数量。

其中43个属于应用运行链路，5个属于开发/安装/交付/发布工具链（ISM-044—048）。

建模风险优先级：高 13、中 23、低 12。这个等级表示错误转换的影响和复核优先级，**不等于发现了 13 个高危 bug**。本次没有复现生产 bug；4 个隔离转换探针通过。现有测试套件、Electron 窗口、系统权限、Squirrel 安装、长时间运行均未执行。

## 基线与权限边界

- 仓库：`/Users/zvf003/ZStack/oc-chan`
- 分支：`refactor/plugin-system-monitor`
- HEAD：`565093f60fc7add73c085ebc0cd5dc5ff4db59c3`
- OMP session ID：`2026-11-09T07-27-48-558Z_01a1bf34-c34e-7600-bc23-71f44049c38e`；没有创建下级代理。
- 源码基线为工作区，包含未提交修改与未跟踪插件模块。完整 Git 状态在 [baseline.json](baseline.json)，逐文件 SHA-256 在 [coverage.json](coverage.json)。不能把这些结论归于纯 HEAD 实现。
- 已读取自动加载的全局和项目 AGENTS 约定及 `graphify` 技能。根目录没有已有 graphify 图，本次直接审阅源码；未建图、未安装依赖、未启动其他代理。
- 只写本目录审计产物。未修改业务源码、未提交/推送/合并/部署，未操作个人数据、未外发消息、未打开原生窗口。

## 方法、覆盖口径与排除项

使用 Git 的 tracked + untracked（遵循明确的 gitignore）清单枚举实际文件，去掉已删除路径。范围为 `src/`、`scripts/`、`.github/workflows/`、`.githooks/`、`resources/tern-navigation/plugin/` 和根构建配置。共 **240 个文件、21 个目录模块**，其中 58 个测试文件。

每个文件均有候选扫描结果与处置理由。人工审阅以状态字段、写入者/读取者、守卫、异步返回、重试取消、恢复和释放的控制流为单位；未声称逐字符逐行形式化证明。相关长文件先读生命周期块/控制流投影，再补关键上下文与跨层调用。候选命中只是检索入口，不直接计数；清单中同一协议跨 main/preload/renderer 的部分按职责合并，独立拥有提交点或资源的子协议才拆开。

覆盖状态：已审 98，不适用 142，未审 0。不适用包括测试驱动器、性能/烟测工具、类型契约、纯投影/校验和不独立拥有生命周期的装配函数；它不表示这些文件全部做了代码质量审查。性能 harness 仅核对入口与产品边界，不枚举其内部测试状态机。此处“全覆盖”指以上边界的文件与状态候选均有处置，不承诺静态分析无遗漏。

明确排除 `.git/`、`node_modules/`、`out/`、`release/`、`.dev-instances/`、生成 `.node` 与 Swift 可执行产物、品牌大二进制/静态图片、历史文档和其他审计台账。未把旧报告当现状证据。第三方 Electron/React/Three.js/ReactFlow/Squirrel 的内部状态机不属于自有源码清单。

未发现由本应用拥有的账号登录会话/刷新令牌状态机。这里的权限边界是 OS 通知/辅助功能、登录启动登记、IPC来源校验、签名能力与本地socket身份验证；不能将采集到的上游 Agent/任务状态误列为本应用执行状态机。

### 目录覆盖表

| 模块 | 文件 | 行数 | 已审 | 不适用 | 未审 |
|---|---:|---:|---:|---:|---:|
| `(root)` | 3 | 128 | 0 | 3 | 0 |
| `.githooks` | 1 | 3 | 0 | 1 | 0 |
| `.github/workflows` | 1 | 171 | 1 | 0 | 0 |
| `resources/tern-navigation/plugin` | 2 | 15 | 1 | 1 | 0 |
| `scripts` | 27 | 4522 | 8 | 19 | 0 |
| `scripts/performance` | 19 | 3745 | 0 | 19 | 0 |
| `scripts/smoke` | 6 | 1574 | 0 | 6 | 0 |
| `src/main` | 43 | 9802 | 20 | 23 | 0 |
| `src/main/collectors` | 12 | 4252 | 5 | 7 | 0 |
| `src/main/events` | 14 | 3683 | 6 | 8 | 0 |
| `src/main/plugins` | 15 | 2511 | 5 | 10 | 0 |
| `src/native` | 2 | 464 | 2 | 0 | 0 |
| `src/plugins/system-monitor` | 2 | 61 | 0 | 2 | 0 |
| `src/plugins/system-monitor/main` | 5 | 553 | 2 | 3 | 0 |
| `src/plugins/system-monitor/renderer` | 8 | 395 | 2 | 6 | 0 |
| `src/preload` | 1 | 90 | 1 | 0 | 0 |
| `src/renderer` | 1 | 13 | 1 | 0 | 0 |
| `src/renderer/src` | 55 | 8405 | 39 | 16 | 0 |
| `src/renderer/src/plugins` | 5 | 248 | 4 | 1 | 0 |
| `src/renderer/src/plugins/builtin` | 3 | 68 | 0 | 3 | 0 |
| `src/shared` | 15 | 1362 | 1 | 14 | 0 |

逐文件覆盖、原因、候选行数与状态机映射：[coverage.csv](coverage.csv)。可复核检索证据：[candidate-evidence.json](candidate-evidence.json)。证据文件保留行号，不包含运行中私人会话内容。

### 不重复计数的候选

- `AgentInfo.state`、`ScheduledJob.state`、`SourceState`：大部分是一次采集证据的纯映射。持久化连续观测形成状态机的部分归入 ISM-020/021/026。
- `Chart.segmentStart`、`NetworkTraffic.connected`、解析 lsof/plist 的局部变量、图布局 visited 集合：局部算法过程，无跨事件生命周期；不按布尔或循环单独计数。
- `MetricSection.expanded`、系统进程排序、普通主题色选择、纯 loading 展示：单独简单值不计数；如果参与持久化、异步事务或资源释放，则并入相关协议。
- 插件包装器、lazy loader、preload IPC转发：追踪其守卫/取消到实际所有者；不把每层再计一个同名机器。

## 优先复核的具体路径

| 结论 | 触发路径与影响 | 证据性质 | 建议 |
|---|---|---|---|
| 插件超时不等于任务完成（ISM-004） | 插件不响应abort → timed报告failed → stop等实际settle；全局退出期限可能强制结束进程 | 生产逻辑的隔离探针确认；既有契约，非已发现bug | 显式区分 timed-out-draining 与已释放failed，不能以phase替代所有权 |
| 事件提交到通知认领存在丢失窗口（ISM-017） | EventStore commit成功 → 在onCommitted之前取消/崩溃 → 下次只有新added行；认领后未确认也不会重放 | 静态可达路径；尚未做崩溃复现 | 先确认“仅新事件、最多一次”的产品语义；若要求可靠投递，再设计持久化待发送记录 |
| 3D半构造失败的清理所有权不完整（ISM-036） | new TopologyScene已创建renderer/DOM/监听 → 后段初始化异常 → owned赋值尚未发生 → 外层dispose无对象 | 条件静态风险，尚未证明真实设备触发或泄露 | 复核构造失败注入；在构造内部统一清理已取得资源 |
| 发布最后缺独立状态回读（ISM-048） | draft资产核验通过 → gh edit成功 → 直接返回Published | 静态确认缺最终readback；不是发布失败复现 | 将最终draft=false/tag/assets回读作为完成证据 |

以上结论的保护条件、相关测试证据和复核缺口均在对应ID中。未将具备充分守卫的潜在竞态直接判为缺陷。

## 重要对象的转换表

### 插件生命周期（ISM-004，混合模型）

| 前态 | 事件/守卫 | 后态与副作用 |
|---|---|---|
| idle、enabled、无instance | collect；依赖可用；无terminalFailure | 创建controller/generation → starting → factory/start → running |
| starting/collecting | 同源重复collect | 复用Promise；跨源重试串行等待前项 |
| running且collecting | 超时 | terminalFailure，abort，报告failed；Promise仍由插件实际settle结束 |
| enabled | disable且无enabled consumer | enabled=false → stopping，取消历史/定时器/controller，等待在途工作 |
| stopping | stop成功且无保留失败 | 清instance/controller/terminalFailure → disabled |
| stopping | cleanup/stop失败 | stopFailure保留，phase failed，后续enable拒绝 |
| 任意未关闭态 | close | 全部立即abort，依赖逆序排空，registry永久closed |

### 更新安装（ISM-007/012）

| 前态 | 事件/守卫 | 后态与副作用 |
|---|---|---|
| idle/error/available | check；running且非platform禁用，无operation | checking，清candidate，读取/验证元数据 |
| checking | 新版存在/不存在/失败 | available / idle / error；revision增加 |
| available/error且candidate | download；disabledReason为空 | downloading，流式写partial并核验摘要，成功rename为update.zip |
| downloading | cancel | abort+drain，回available，清进度；部分文件清理 |
| downloaded | install且file/candidate存在 | installing → native staging确认 → host排空 → quitAndInstall |
| 任意操作 | stop | running=false；abort；安装不等待自身promise，其余等待；清文件 |

### 通知持久化与回调（ISM-016—019）

| 前态 | 事件/守卫 | 后态与副作用 |
|---|---|---|
| off/events-disabled | start且偏好开启 | starting → 读取journal → 查询权限 → ready/quiet/sleeping/permission-required |
| ready/quiet/sleeping | 新commit批次 | 检查序号/订阅/限频，更新cursor与摘要；待发先写unconfirmed认领 |
| 已认领 | native.show确认全部成功 | 写unconfirmed=false；记录实际发送时间 |
| 已认领 | 崩溃/取消/发送未确认 | 不重放该认领；仅睡眠时未尝试剩余项计入摘要 |
| native OS pending | JS超时/cancel | JS回调释放，OS槽仍保留；新request拒绝 |
| native OS完成且TSFN finalized | Retire | active清空，允许下一操作 |
| active | 停用/stop | abort show/permission，排空drive，native.close及journal清理；失败保留cleanupPending |

### 事件数据库（ISM-021/022/033）

| 前态 | 事件/守卫 | 后态与副作用 |
|---|---|---|
| 无cursor/DB身份变化 | 首次read/reset | baseline不重放旧完成记录，记录coverage |
| 已观察 | append/revisit/pending轮询 | 形成候选新事件和下一checkpoint，尚未提交 |
| 已load revision | commit且DB revision一致 | 同一事务去重/保留清理/写events+checkpoint，revision递增 |
| 已load旧revision | query期间清理已推进revision | commit拒绝stale；不得覆盖新水位 |
| 当前页upper已固定 | next/previous | keyset分页维持upper；新插入不混入历史页 |
| 请求在途 | hidden/unmount/close | renderer generation失效，主进程abort，store实际子进程关闭后释放 |

### 3D视图（ISM-036/037）

| 前态 | 事件/守卫 | 后态与副作用 |
|---|---|---|
| 未装载 | 预算有效 | import → 构造scene；卸载token阻止迟到构造 |
| ready、无frame | invalidate且可见、未failed/disposed | 单RAF渲染并保存camera；无常驻循环 |
| ready | contextlost/render异常 | failed，停止调度，显示重试 |
| pointer idle | primary pointerdown命中员工 | capture并禁用orbit；移动阈值后拖动 |
| pointer active | up/cancel/lostcapture/节点移除 | 恢复orbit；未drag时选择 |
| 任意已构造态 | unmount/retry | dispose观察器、监听器、GPU对象、DOM；半构造异常见风险条目 |

## 完整去重清单

优先级为建模/复核风险；`implicit`是隐式对象，`hybrid`是有phase但组合转换未集中表达的对象。测试文件仅为已存在的源码证据，不能解释为本次测试通过。每项的准确摘录、SHA、完整测试候选在 inventory.json。

### ISM-001 · 应用启动、恢复与退出

类型 `implicit`；风险优先级 **中**；所有者 `main application`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/index.ts:79](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:79)；[src/main/index.ts:331](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:331)；[src/main/index.ts:442](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:442)；[src/main/index.ts:648](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:648)；[src/main/shutdown.ts:8](/Users/zvf003/ZStack/oc-chan/src/main/shutdown.ts:8)。

状态变量/派生状态：`settings/window/recoveryWindow`；`quitting/quitReady`；`installationWork/exitCode`。

写入者：app.whenReady；recoverStartupSettings.finish；before-quit；beforeInstall。读取者：activateApplication；IPC guards；releaseResources。

转换、守卫及副作用：

- ready→readSettings→恢复窗口或正常初始化
- before-quit: quitting守卫→releaseResources→quitReady→exit
- beforeInstall→排空→允许Squirrel退出

初始化：模块初始化空窗口与quitting=false。终止：before-quit排空后app.exit或Squirrel交接。恢复：设置读取失败进入恢复窗口；不可恢复startup错误退出。

跨层/对象依赖：ISM-002, ISM-003, ISM-007, ISM-008, ISM-009, ISM-010, ISM-023。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/shutdown.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/shutdown.test.ts)；[src/main/startup-recovery.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/startup-recovery.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-002 · 设置应用、持久化与回滚

类型 `implicit`；风险优先级 **中**；所有者 `SettingsStore`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/settings.ts:253](/Users/zvf003/ZStack/oc-chan/src/main/settings.ts:253)；[src/main/index.ts:449](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:449)；[src/main/index.ts:516](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:516)。

状态变量/派生状态：`current/queue/pendingUpdates/isUpdating/fatalError`；`appliedSettings`。

写入者：update operation；apply；save；rollback；finally。读取者：value；idle；broadcastSettings；renderer snapshot。

转换、守卫及副作用：

- update验证→串行apply→save→current提交
- 失败→apply(previous)；回滚失败→fatalError永久拒绝
- idle等待队列稳定

初始化：复制initial，空串行队列。终止：idle等队列稳定；fatalError永久拒绝。恢复：save失败apply previous；回滚失败触发退出。

跨层/对象依赖：ISM-004, ISM-014, ISM-015, ISM-030。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/settings.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/settings.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：隔离探针通过指定转换；不是生产故障复现。

### ISM-003 · 设置损坏重试恢复

类型 `implicit`；风险优先级 **低**；所有者 `StartupSettingsRecovery`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/startup-recovery.ts:28](/Users/zvf003/ZStack/oc-chan/src/main/startup-recovery.ts:28)；[src/main/index.ts:331](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:331)。

状态变量/派生状态：`pending/ready/closed/failure`；`settled/closeRecovery`。

写入者：retry completion；close。读取者：retry；recoverStartupSettings IPC。

转换、守卫及副作用：

- retry合并→ready缓存或failed更新
- close→closed→等待pending→清ready
- ready且未退出→关闭恢复窗→正常启动

初始化：failure已记录、closed=false。终止：close置closed并等待pending。恢复：retry合并；成功ready缓存直到宿主消费。

跨层/对象依赖：ISM-001。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/startup-recovery.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/startup-recovery.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-004 · 插件注册、运行、重试和卸载

类型 `hybrid`；风险优先级 **高**；所有者 `CollectionPluginRegistry Entry`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/plugins/registry.ts:19](/Users/zvf003/ZStack/oc-chan/src/main/plugins/registry.ts:19)；[src/main/plugins/registry.ts:198](/Users/zvf003/ZStack/oc-chan/src/main/plugins/registry.ts:198)；[src/main/plugins/registry.ts:291](/Users/zvf003/ZStack/oc-chan/src/main/plugins/registry.ts:291)；[src/main/plugins/registry.ts:415](/Users/zvf003/ZStack/oc-chan/src/main/plugins/registry.ts:415)；[src/main/plugins/registry.ts:459](/Users/zvf003/ZStack/oc-chan/src/main/plugins/registry.ts:459)；[src/main/plugins/registry.ts:499](/Users/zvf003/ZStack/oc-chan/src/main/plugins/registry.ts:499)。

状态变量/派生状态：`phase/enabled/generation/controller`；`starting/collecting/sampling/retries/transition/stopping/removing`；`terminalFailure/stopFailure/closed`。

写入者：initialize；collect；setEnabled；cancel；timed；stopEntry；close。读取者：assertAvailable；dependencyFailure；publish；statuses；diagnostics。

转换、守卫及副作用：

- start→initialize→running
- 同源重试合并；跨源collect串行
- 禁用/移除→abort→drain→stop→disabled；失败锁定
- timeout设置terminalFailure并abort，等待原任务实际结束

初始化：entries idle/enabled、无instance。终止：close abort所有并逆序stop；失败保留。恢复：terminalFailure需disable清理再enable；stopFailure禁止重启。

跨层/对象依赖：ISM-005, ISM-011, ISM-016, ISM-024, ISM-026, ISM-027。

风险：插件collect/start忽略signal→期限报告failed但promise未settle→禁用/关闭一直等待；应用5秒shutdown期限会退出，不能声称已正常清理。现有测试明确覆盖这种保留所有权策略。

建议：用单个生命周期状态联合操作所有权，明确timed-out-draining与failed可重试的区别。

现有相关测试：[src/main/plugins/registry.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/plugins/registry.test.ts)。

缺口：独立复核非合作插件及依赖关闭顺序；probe已验证超时仍持有pending。

验证状态：隔离探针通过指定转换；不是生产故障复现。

### ISM-005 · 采集刷新、来源重试与发布

类型 `implicit`；风险优先级 **中**；所有者 `Monitor`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/monitor.ts:30](/Users/zvf003/ZStack/oc-chan/src/main/monitor.ts:30)；[src/main/monitor.ts:84](/Users/zvf003/ZStack/oc-chan/src/main/monitor.ts:84)；[src/main/monitor.ts:129](/Users/zvf003/ZStack/oc-chan/src/main/monitor.ts:129)；[src/main/monitor.ts:201](/Users/zvf003/ZStack/oc-chan/src/main/monitor.ts:201)。

状态变量/派生状态：`pending/sourceRetries/collectionErrors/stopped/stopping`；`section.data/error/refreshing/lastAttemptAt/lastSuccessAt`。

写入者：observer.onSnapshot/onError/onState；refresh；retrySource；stop。读取者：update；readHistory；readEvents；IPC snapshot。

转换、守卫及副作用：

- 刷新按section合并；来源重试按source合并
- onSnapshot/onError/onState→更新派生状态
- 内容相同仅发heartbeat；stop→abort/drain/清state

初始化：createEmptySnapshot、插件目录注册。终止：stop清队列/快照/监听。恢复：refresh/retrySource通过registry重采。

跨层/对象依赖：ISM-004, ISM-006, ISM-032, ISM-041。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/monitor.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/monitor.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-006 · 可见窗口订阅

类型 `implicit`；风险优先级 **低**；所有者 `MonitorSubscriptions + preload listeners`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/monitor-subscriptions.ts:13](/Users/zvf003/ZStack/oc-chan/src/main/monitor-subscriptions.ts:13)；[src/preload/index.ts:16](/Users/zvf003/ZStack/oc-chan/src/preload/index.ts:16)。

状态变量/派生状态：`entries.visible/updates/sources`；`WebContents销毁/导航`。

写入者：register；visibility；reset；set；release；subscribe cleanup。读取者：publish；updateSubscription。

转换、守卫及副作用：

- register→visibility/兴趣更新→有条件publish
- 导航/崩溃重置兴趣；关闭移除监听

初始化：register建立最多两个窗口条目。终止：closed/destroyed/dispose移除监听。恢复：导航重置兴趣；preload重新订阅。

跨层/对象依赖：ISM-032。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/monitor-subscriptions.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/monitor-subscriptions.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-007 · 更新查询下载与安装

类型 `hybrid`；风险优先级 **高**；所有者 `UpdateController + AppUpdatesPlugin`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/plugins/update-controller.ts:17](/Users/zvf003/ZStack/oc-chan/src/main/plugins/update-controller.ts:17)；[src/main/plugins/app-updates.ts:21](/Users/zvf003/ZStack/oc-chan/src/main/plugins/app-updates.ts:21)；[src/main/index.ts:596](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:596)；[src/main/plugins/update-source.ts:91](/Users/zvf003/ZStack/oc-chan/src/main/plugins/update-source.ts:91)。

状态变量/派生状态：`phase/revision/disabledReason`；`candidate/downloaded/operation(kind,abort,cancelled)/running/timer`；`plugin.stopped/verification`。

写入者：start；run；check；download；cancel；install；stop；nativeError。读取者：snapshot；IPC actions；UpdatesProvider。

转换、守卫及副作用：

- start→idle；check→checking→available/idle/error
- download→downloading→downloaded/error；cancel→available
- install→installing→stageNative→host排空→quitAndInstall
- stop中install不等待自身promise避免死锁

初始化：disabled快照→start能力判定。终止：stop取消操作、移除IPC、清下载；安装跳过自等待。恢复：error可check；有candidate可重新download；安装交接失败退出。

跨层/对象依赖：ISM-001, ISM-012, ISM-031。

风险：downloaded→installing→native staging成功→beforeInstall排空（包括更新插件stop）→quitAndInstall；任一顺序变化可能导致自等待或过早删除文件。当前stop特意跳过等待install，native staging先完成。

建议：明确staging、host-draining、handoff三阶段与不可取消点。

现有相关测试：[src/main/app-updates.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/app-updates.test.ts)。

缺口：现有测试覆盖查询/取消/未签名，未见真实Squirrel交接的本次运行证据。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-008 · 托盘窗口加载与最新显示意图

类型 `implicit`；风险优先级 **低**；所有者 `TrayWindowController`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/tray-window.ts:12](/Users/zvf003/ZStack/oc-chan/src/main/tray-window.ts:12)。

状态变量/派生状态：`current/pending/cancelLoad/requested/stopped`。

写入者：ensure/createAndLoad；toggle；hide；gone；closed；dispose。读取者：present；pending guard。

转换、守卫及副作用：

- toggle翻转requested；ensure合并加载
- ready+load完成且requested→present
- blur/Escape/close→hide；gone→destroy→下次重建

初始化：current/pending空、requested=false。终止：dispose取消load并destroy。恢复：加载/renderer失败销毁；下一toggle重新创建。

跨层/对象依赖：ISM-006, ISM-043。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/tray-window.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/tray-window.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-009 · 窗口位置延迟保存

类型 `implicit`；风险优先级 **低**；所有者 `WindowGeometry`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/window-geometry.ts:36](/Users/zvf003/ZStack/oc-chan/src/main/window-geometry.ts:36)。

状态变量/派生状态：`timer/pending/active/lastNormal/saved/error/stopping/detached/disposal`。

写入者：capture；save；flush；retry；detach；dispose。读取者：normal；settingsSnapshot；geometryError。

转换、守卫及副作用：

- move/resize→覆盖pending→250ms flush
- save成功更新saved；失败保留error可retry
- dispose→capture→detach→flush

初始化：读取normal bounds与settings保存值。终止：dispose detach并flush最后pending。恢复：retry重新保存lastNormal。

跨层/对象依赖：ISM-002。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/window-geometry.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/window-geometry.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-010 · 诊断预览及保存事务

类型 `implicit`；风险优先级 **中**；所有者 `Diagnostics + DiagnosticPanel`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/diagnostics.ts:43](/Users/zvf003/ZStack/oc-chan/src/main/diagnostics.ts:43)；[src/main/diagnostics.ts:74](/Users/zvf003/ZStack/oc-chan/src/main/diagnostics.ts:74)；[src/renderer/src/DiagnosticPanel.tsx:37](/Users/zvf003/ZStack/oc-chan/src/renderer/src/DiagnosticPanel.tsx:37)；[src/main/index.ts:103](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:103)。

状态变量/派生状态：`preview/expires/active/closed/cleanupFailure`；`renderer.operation/revision/mounted/releaseBarrier`。

写入者：run；clear；generate；cancel；close；saveDiagnosticReport；panel revision。读取者：current；act；isCurrent；preview rendering。

转换、守卫及副作用：

- generate→TTL预览；copy/save检查ID和单操作
- save:选择文件→临时文件sync→link提交→unlink
- cancel/卸载→abort/drain；cleanup失败锁定

初始化：无preview和active。终止：cancel清预览并等待active；close永久关闭。恢复：expired需generate；cleanupFailure锁定。

跨层/对象依赖：ISM-001, ISM-023。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/diagnostics.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/diagnostics.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-011 · 历史读取替换与排空

类型 `implicit`；风险优先级 **中**；所有者 `ScheduleHistoryReader + ScheduleHistory`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/schedule-history.ts:28](/Users/zvf003/ZStack/oc-chan/src/main/schedule-history.ts:28)；[src/main/collectors/hermes-history.ts:88](/Users/zvf003/ZStack/oc-chan/src/main/collectors/hermes-history.ts:88)；[src/renderer/src/ScheduleHistory.tsx:22](/Users/zvf003/ZStack/oc-chan/src/renderer/src/ScheduleHistory.tsx:22)。

状态变量/派生状态：`active/pending/closed/drainFailure/idleWaiter`；`renderer.phase/page/current/offset/restoreCachedPage`。

写入者：read；cancel；execute.finally；close；effect cleanup。读取者：idle；diagnostics；provider supports；renderer page identity。

转换、守卫及副作用：

- 新请求取消active并替换一个pending
- provider释放后才启动下一请求
- 卸载/隐藏/取消→reject+abort→idle；身份offset校验接受结果

初始化：无active/pending、closed=false。终止：close取消并idle排空。恢复：普通失败下一read；新请求替换pending；排空失败保留。

跨层/对象依赖：ISM-004, ISM-023, ISM-034。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/schedule-history.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/schedule-history.test.ts)；[src/main/collectors/hermes-history.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/collectors/hermes-history.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-012 · 原生更新暂存与回执

类型 `implicit`；风险优先级 **中**；所有者 `stageNativeUpdate closure`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/plugins/native-update.ts:18](/Users/zvf003/ZStack/oc-chan/src/main/plugins/native-update.ts:18)。

状态变量/派生状态：`server/baseUrl/finished`；`signal/native events`。

写入者：server.listen；native event callbacks；cleanup。读取者：finished guard；host install await。

转换、守卫及副作用：

- stat→listen loopback→register listeners→checkForUpdates
- downloaded→cleanup→resolve；error/unavailable/abort→cleanup→reject

初始化：验证本地包后创建loopback server。终止：任一终态移除监听并关server。恢复：上层重试下载/安装；此调用一次性。

跨层/对象依赖：ISM-007。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/app-updates.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/app-updates.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-013 · 登录启动系统状态与回滚

类型 `hybrid`；风险优先级 **中**；所有者 `LoginItems + LoginItemSetting`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/login-items.ts:19](/Users/zvf003/ZStack/oc-chan/src/main/login-items.ts:19)；[src/renderer/src/LoginItemSetting.tsx:9](/Users/zvf003/ZStack/oc-chan/src/renderer/src/LoginItemSetting.tsx:9)；[src/renderer/src/LoginItemSetting.tsx:32](/Users/zvf003/ZStack/oc-chan/src/renderer/src/LoginItemSetting.tsx:32)。

状态变量/派生状态：`OS.status/openAtLogin/availability`；`before/state/rollbackFailed`。

写入者：OS write；rollback；request result。读取者：readState；snapshot；wasOpenedAtLogin；page UI。

转换、守卫及副作用：

- read→验证一致性；write→readback
- 失败且状态改变→write(before)→验证回滚

初始化：OS读取权威状态，未知明确返回。终止：页面卸载不接受迟到返回；系统登记跨应用退出保留。恢复：write失败回滚；requires-approval等用户系统操作。

跨层/对象依赖：ISM-001, ISM-039。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/login-items.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/login-items.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-014 · 桌面休眠阻止器生命周期

类型 `implicit`；风险优先级 **低**；所有者 `DesktopSettings`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/desktop-settings.ts:20](/Users/zvf003/ZStack/oc-chan/src/main/desktop-settings.ts:20)。

状态变量/派生状态：`blocker`；`settings.preventSleep/headless`。

写入者：apply；dispose。读取者：blocker guard；powerSaveBlocker.isStarted。

转换、守卫及副作用：

- 开启→start并核验
- 关闭/dispose→stop并核验→清句柄

初始化：blocker undefined。终止：dispose核验stop后清句柄。恢复：SettingsStore回滚重新apply previous。

跨层/对象依赖：ISM-002。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：未单列专门测试；可能由集成smoke覆盖，不能据此断言完全无覆盖。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-015 · 玻璃预览、提交与原生视图所有权

类型 `implicit`；风险优先级 **中**；所有者 `SettingsProvider + main + NativeGlass`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/settings.tsx:49](/Users/zvf003/ZStack/oc-chan/src/renderer/src/settings.tsx:49)；[src/main/index.ts:216](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:216)；[src/main/index.ts:480](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:480)；[src/main/liquid-glass.ts:11](/Users/zvf003/ZStack/oc-chan/src/main/liquid-glass.ts:11)；[src/native/liquid-glass.mm:123](/Users/zvf003/ZStack/oc-chan/src/native/liquid-glass.mm:123)；[src/renderer/src/LiquidGlassSetting.tsx:11](/Users/zvf003/ZStack/oc-chan/src/renderer/src/LiquidGlassSetting.tsx:11)。

状态变量/派生状态：`glassRequest/Worker/Revision/Failure/Active`；`main.glassPreview/applied WeakMap`；`native关联glass view`。

写入者：previewGlass/flushGlass/save；cancelGlassPreview/applyWindowMaterial；SetGlass。读取者：revision checks；settings.isUpdating；applied WeakMap；native associated view。

转换、守卫及副作用：

- slider→最新值合并串行IPC→revision校验
- 保存等待预览→设置事务→取消预览
- blur/hide/accessibility→cancel；intensity=0移除native view

初始化：预览空、原生无glass或按保存强度设置。终止：blur/hidden/unmount取消；强度0移除原生view。恢复：预览失败显式retry；保存后取消预览。

跨层/对象依赖：ISM-002, ISM-030。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：未单列专门测试；可能由集成smoke覆盖，不能据此断言完全无覆盖。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-016 · 通知服务调度与启停

类型 `hybrid`；风险优先级 **高**；所有者 `EventNotifications service`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/events/notifications.ts:16](/Users/zvf003/ZStack/oc-chan/src/main/events/notifications.ts:16)；[src/main/events/notifications.ts:126](/Users/zvf003/ZStack/oc-chan/src/main/events/notifications.ts:126)。

状态变量/派生状态：`active/sleeping/operation/pendingRefresh/pendingPermission/pendingBatch/processingBatch`；`controller/native/journal/blocked/cleanupPending`。

写入者：start/refresh/requestPermission/stop/drive/initialize/release/recordFailure。读取者：availability；preferences；snapshot。

转换、守卫及副作用：

- drive优先停用→refresh→permission→batch
- 初始化读取journal与权限；错误blocked
- stop→abort→native.close→清摘要→释放；cleanup失败保留重试

初始化：active=false、初始notification state。终止：stop abort→release；失败保留cleanupPending。恢复：refresh初始化journal/native；cleanupPending先重试release。

跨层/对象依赖：ISM-017, ISM-018, ISM-019, ISM-022。

风险：permission或batch正在运行时停用→abort→drive再执行release；native.close或journal写清摘要失败→cleanupPending阻止安全重启。需避免UI off被理解为已清理。

建议：将运行控制、权限和清理失败拆成正交状态，保留drive串行执行。

现有相关测试：[src/main/events/notifications.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/events/notifications.test.ts)。

缺口：已有停用/清理失败单测；独立检查permission与batch交错、重复start不同signal。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-017 · 通知认领、抑制、发送确认和恢复

类型 `implicit`；风险优先级 **高**；所有者 `EventNotifications journal`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/events/notifications.ts:255](/Users/zvf003/ZStack/oc-chan/src/main/events/notifications.ts:255)；[src/main/events/notification-journal.ts:90](/Users/zvf003/ZStack/oc-chan/src/main/events/notification-journal.ts:90)；[src/main/events/collector.ts:173](/Users/zvf003/ZStack/oc-chan/src/main/events/collector.ts:173)。

状态变量/派生状态：`identity/cursor(sequence,unconfirmed)/summaryCount/cooldowns/sentAt`；`lastClock/showController/attempted`。

写入者：consume/writeNotificationJournal；native.show acknowledgement。读取者：cursor comparison；selected；cooldown+rate guards；initialize。

转换、守卫及副作用：

- 数据库commit→onCommitted；新序号→筛选/冷却/限频→journal先写认领
- 最多3条/分钟、64冷却key；quiet/sleep合并摘要
- show全部确认→unconfirmed=false落盘；未确认不重放
- 数据库身份变化重置cursor；时间倒退调整窗口

初始化：读journal或empty journal。终止：每次发送认领先持久化；服务stop清summary。恢复：重启不重放unconfirmed；DB identity变更重置cursor。

跨层/对象依赖：ISM-016, ISM-020, ISM-021, ISM-022。

风险：静态可达丢失窗口：store.commit已成功但onCommitted前取消/崩溃；下轮added仅新插入行，不会重发该批。认领后崩溃也按设计不重放。需确认产品接受at-most-once语义；未复现。

建议：显式记录事件提交与通知认领的提交点；文档确认允许漏发的at-most-once语义，再决定是否需要持久化待处理出站记录。

现有相关测试：[src/main/events/notifications.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/events/notifications.test.ts)；[src/main/events/notification-journal.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/events/notification-journal.test.ts)；[src/main/events/collector.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/events/collector.test.ts)。

缺口：现有测试覆盖claim先写与restart不重放；commit→onCommitted间崩溃窗口需单独验证。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-018 · 通知权限跨JS与OS回调释放

类型 `implicit`；风险优先级 **高**；所有者 `Native permission JS and C++`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/events/native-notifications.ts:67](/Users/zvf003/ZStack/oc-chan/src/main/events/native-notifications.ts:67)；[src/native/notification-permission.mm:10](/Users/zvf003/ZStack/oc-chan/src/native/notification-permission.mm:10)；[src/native/notification-permission.mm:43](/Users/zvf003/ZStack/oc-chan/src/native/notification-permission.mm:43)；[src/native/notification-permission.mm:235](/Users/zvf003/ZStack/oc-chan/src/native/notification-permission.mm:235)。

状态变量/派生状态：`JS.cancelPermission/settled/token/cleanupError`；`native.active/osPending/authorizationPending/cancelled/finalized/callback/stopping`。

写入者：permission.finish/cancel；Start/Finish/FinalizeCallback/Cancel/Cleanup。读取者：assertOpen；Retire；CallJS；state.active guard。

转换、守卫及副作用：

- query→OS settings；显式request且not-determined→授权→重新查询
- timeout/abort释放JS回调；OS槽仍等待完成
- 仅!osPending && finalized才Retire；env cleanup终止JS访问

初始化：JS未加载binding、native.active空。终止：JS cancel释放回调；OS完成+finalized后Retire。恢复：OS pending拒绝重试；槽释放后可查询；cleanup重试。

跨层/对象依赖：ISM-016, ISM-019。

风险：取消后重试可能仍ERR_NOTIFICATION_PERMISSION_PENDING；这是OS未完成前的保护，不是泄露的复现证据。需覆盖JS finalize先/后于OS回调两种顺序。

建议：画清JS-owned、OS-pending、finalized三方所有权；Retire不变量保留。

现有相关测试：[src/main/events/native-notifications.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/events/native-notifications.test.ts)。

缺口：现有adapter测试使用替身；原生N-API finalize与真实OS回调顺序未在本次运行验证。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-019 · 原生通知显示与句柄释放

类型 `implicit`；风险优先级 **中**；所有者 `Native live notification entries`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/events/native-notifications.ts:128](/Users/zvf003/ZStack/oc-chan/src/main/events/native-notifications.ts:128)。

状态变量/派生状态：`live/settled/disposed/cleanupError/lastPermission`。

写入者：show/settle/dispose/onClick/close。读取者：live limit；disposed+closed；lastPermission。

转换、守卫及副作用：

- show→等待实际show确认；failed/close/click/abort/3s timeout→dispose
- 点击保存的target导航；超过8条释放最旧
- close失败保留无监听句柄给close重试

初始化：live空、lastPermission unknown。终止：每entry dispose；adapter.close清所有。恢复：关闭失败保留handle给close再试，错误期间拒绝新工作。

跨层/对象依赖：ISM-018, ISM-029。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/events/native-notifications.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/events/native-notifications.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-020 · 来源不可用持续时间和恢复事件

类型 `implicit`；风险优先级 **中**；所有者 `SourceEventCursor reducer`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/events/collector.ts:23](/Users/zvf003/ZStack/oc-chan/src/main/events/collector.ts:23)。

状态变量/派生状态：`state/unavailableSince/announced/generation/observedAt`。

写入者：observeSourceEvents。读取者：EventCollector；persisted checkpoint。

转换、守卫及副作用：

- 明确error持续60秒→announced+generation→unavailable
- healthy且announced→recovered；partial保留故障
- 观测倒退/间隔>120秒重建持续窗口；每轮16事件其余延期

初始化：无前序cursor、announced=false。终止：不健康状态转换保留/清故障；服务停止checkpoint留存。恢复：后续healthy生成recovered；间隔断档重置持续时间。

跨层/对象依赖：ISM-021, ISM-022。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/events/collector.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/events/collector.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：隔离探针通过指定转换；不是生产故障复现。

### ISM-021 · 事件增量游标与迟写回查

类型 `hybrid`；风险优先级 **高**；所有者 `HermesEventReader cursor + EventCollector`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/events/hermes.ts:73](/Users/zvf003/ZStack/oc-chan/src/main/events/hermes.ts:73)；[src/main/events/collector.ts:118](/Users/zvf003/ZStack/oc-chan/src/main/events/collector.ts:118)。

状态变量/派生状态：`identity/baseline/high/revisit/floor/pending/pendingIndex`；`collector.pending/closing/controller`。

写入者：readerScript baseline/append/revisit；collectOnce；close。读取者：validateCursor；executionEvents；next poll。

转换、守卫及副作用：

- 首次/DB替换→baseline不重放旧完成记录
- 每次16 append+16 revisit+8基线pending轮询
- 失败保留cursor；commit成功才接受；close取消并排空

初始化：null cursor建立baseline，排除历史完成事件。终止：collector.close abort→pending排空→store.close。恢复：DB替换/水位回退重建；失败保留旧checkpoint。

跨层/对象依赖：ISM-020, ISM-022, ISM-023。

风险：执行行先running后failed/投递迟写→append/revisit/pending轮询；数据库换inode或rowid回退→baseline重建。覆盖断档/保留水位升高会排除旧行；不能把observing解释为所有历史均完整。

建议：把cursor推进/重置/排除水位作为集中转换函数，显式输出coverage原因。

现有相关测试：[src/main/events/hermes.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/events/hermes.test.ts)；[src/main/events/collector.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/events/collector.test.ts)。

缺口：已有基线/轮询/替换相关测试索引；独立验证迟写与floor提升相遇。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-022 · 事件存储队列、事务和去重保留

类型 `implicit`；风险优先级 **高**；所有者 `EventStore + SQLite transaction`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/events/store.ts:122](/Users/zvf003/ZStack/oc-chan/src/main/events/store.ts:122)；[src/main/events/store.ts:205](/Users/zvf003/ZStack/oc-chan/src/main/events/store.ts:205)；[src/main/events/store.ts:361](/Users/zvf003/ZStack/oc-chan/src/main/events/store.ts:361)。

状态变量/派生状态：`queue/active/pendingEvents/closed/drained`；`DB revision/checkpoint/tombstones/floor/inTransaction`。

写入者：enqueue/pump/execute/close；prune/advance/COMMIT/ROLLBACK。读取者：load/query/commit revision checks；notification added rows。

转换、守卫及副作用：

- enqueue限量→独立Node SQLite事务→revision CAS→commit/rollback
- 删除行→墓碑；墓碑容量超限→提升floor并记录gap
- close拒绝排队项→abort active→drained

初始化：queue空，SQLite按版本校验/初始化。终止：close拒绝排队、取消active并等子进程关闭。恢复：事务失败rollback；新load获得revision；损坏不重建掩盖。

跨层/对象依赖：ISM-021, ISM-023, ISM-033。

风险：分页query也可能按年龄清理并提升revision/floor；旧collector commit随后CAS拒绝→重试load。若把query当纯读或去掉CAS，会让旧checkpoint覆盖水位。当前CAS与事务防护存在。

建议：明确query-pruning提交与collector提交共享revision，保留原子事件+checkpoint不变量。

现有相关测试：[src/main/events/store.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/events/store.test.ts)。

缺口：现有query-time pruning/stale writer测试；独立核对close在队列准入与child close阶段。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-023 · 资源预算排队、租约和取消

类型 `implicit`；风险优先级 **高**；所有者 `ResourceBudget + IO ownership`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/resource-budget.ts:135](/Users/zvf003/ZStack/oc-chan/src/main/resource-budget.ts:135)；[src/main/resource-io.ts:48](/Users/zvf003/ZStack/oc-chan/src/main/resource-io.ts:48)；[src/main/collectors/agents.ts:362](/Users/zvf003/ZStack/oc-chan/src/main/collectors/agents.ts:362)；[src/main/collection-limits.ts:18](/Users/zvf003/ZStack/oc-chan/src/main/collection-limits.ts:18)。

状态变量/派生状态：`queues/source order/draining/waitingSignals`；`lease.active/current计数；child callback/close result/cancelled`。

写入者：acquire/admit/remove/unqueue/drain/release；child close；socket close。读取者：fits；AsyncLocalStorage active；budget snapshots。

转换、守卫及副作用：

- 请求验证→admit或queue→容量释放drain
- 排队abort/超时→移除并扣计数；lease release幂等
- command在child close之后resolve/reject；socket在close后结算

初始化：计数0、空队列。终止：每租约release一次；取消队列移除；IO关闭后结算。恢复：配额释放后drain；超限拒绝需调用方重试。

跨层/对象依赖：ISM-004, ISM-024, ISM-026, ISM-027。

风险：command带inputFile同时占命令/文件预算→两队列按order仲裁；取消在排队、执行和child close三个时点发生。错误释放会重复扣账或提前准入。当前lease幂等和close结算提供保护。

建议：保留简单队列；将queued/admitted/releasing/released状态与计费不变量集中断言。

现有相关测试：[src/main/resource-budget.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/resource-budget.test.ts)；[src/main/resource-io.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/resource-io.test.ts)。

缺口：已有资源预算/IO边界测试；复核复合请求取消与子进程异常关闭。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-024 · 活跃会话发现、文件监听与增量发布

类型 `implicit`；风险优先级 **高**；所有者 `LiveAgents SessionWatch`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/live-agents.ts:41](/Users/zvf003/ZStack/oc-chan/src/main/live-agents.ts:41)；[src/main/live-agents.ts:153](/Users/zvf003/ZStack/oc-chan/src/main/live-agents.ts:153)；[src/main/live-agents.ts:229](/Users/zvf003/ZStack/oc-chan/src/main/live-agents.ts:229)。

状态变量/派生状态：`entries/bySession/base/pending/stopped`；`entry.active/dirty/reading/revision/watcher/closing/controller`；`publishTimer/reads/closing`。

写入者：reconcile/attach/enqueue/read/fail/drainEntry/close/stop。读取者：emit；revision and active guards；diagnostics。

转换、守卫及副作用：

- 发现会话→attach→文件事件合并→read→revision校验→publish
- rename/error→drain→下一次发现重挂
- stop→abort所有→等待read/watch close→清引用

初始化：空entries/base；reconcile发现当前会话。终止：stop取消timer/watch/read并等待真实关闭。恢复：watch失败drain后下一轮发现重挂。

跨层/对象依赖：ISM-004, ISM-025。

风险：文件rename/error与在途read相遇→revision改变+drain→后续发现重挂；旧read或旧watcher close晚到可能影响新挂载。当前identity/revision/closing集合防护存在。

建议：集中SessionWatch状态与generation；明确watcher关闭和read结束的双重排空。

现有相关测试：[src/main/live-agents.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/live-agents.test.ts)。

缺口：已有真实watcher/100次启停等测试源码；本次未重跑这些系统IO场景。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-025 · 会话活动记录与文件游标

类型 `implicit`；风险优先级 **中**；所有者 `SessionActivityReader`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/collectors/agent-activity.ts:26](/Users/zvf003/ZStack/oc-chan/src/main/collectors/agent-activity.ts:26)；[src/main/collectors/agent-activity.ts:95](/Users/zvf003/ZStack/oc-chan/src/main/collectors/agent-activity.ts:95)。

状态变量/派生状态：`calls/model`；`cache identity/size/modified/offset/state/issues；inFlight`。

写入者：consumeActivityRecord/recentActivity/readFile/retainPaths。读取者：read cache identity；LiveAgents projection。

转换、守卫及副作用：

- tool start/model→记录；tool result/turn结束/user→清对应活动
- 6秒到期清理；文件替换/缩短/省略记录→重置
- 不完整尾行保留偏移下次再读；坏记录清状态

初始化：每路径空cache与calls。终止：retainPaths删离开路径并abort；reader生命周期由LiveAgents拥有。恢复：文件身份变化/截断重置；不完整尾行下次补读。

跨层/对象依赖：ISM-024, ISM-042。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/collectors/agents.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/collectors/agents.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-026 · 调度配置与launchd域重试缓存

类型 `implicit`；风险优先级 **中**；所有者 `ScheduleCollector and LaunchdCollector`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/collectors/schedules.ts:495](/Users/zvf003/ZStack/oc-chan/src/main/collectors/schedules.ts:495)；[src/main/collectors/launchd.ts:121](/Users/zvf003/ZStack/oc-chan/src/main/collectors/launchd.ts:121)。

状态变量/派生状态：`configuration/plistCache/disposed/controller`；`readings.services/disabled/loadedKnown/disabledKnown`。

写入者：readConfiguration/read/collect/retry/dispose。读取者：compose；supports；launchState。

转换、守卫及副作用：

- 完整配置+域读取→compose→缓存配置
- 域失败保留条目但known=false；单来源重试须已有完整配置
- dispose abort并清缓存；迟到collect再次清理

初始化：无完整configuration与空域/文件cache。终止：dispose abort并清缓存；迟到结果清理。恢复：域失败known=false；有配置才可retrySource。

跨层/对象依赖：ISM-004, ISM-011, ISM-023。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/collectors/schedules.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/collectors/schedules.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-027 · 系统采样基线与计数器连续性

类型 `implicit`；风险优先级 **低**；所有者 `SystemCollector + NetworkReader`。置信度：高：实现证据；风险未经动态复现。

证据：[src/plugins/system-monitor/main/system.ts:109](/Users/zvf003/ZStack/oc-chan/src/plugins/system-monitor/main/system.ts:109)；[src/plugins/system-monitor/main/network.ts:40](/Users/zvf003/ZStack/oc-chan/src/plugins/system-monitor/main/network.ts:40)。

状态变量/派生状态：`previousCpu/history/controller`；`network.previous(iface,counters,at)`。

写入者：collect/read/dispose。读取者：counter continuity；diff sample；history rendering。

转换、守卫及副作用：

- 首样本无速率；连续同接口且计数递增→差分
- 读取失败/计数回退/换接口→基线失效
- dispose→abort/清基线与60条历史

初始化：无CPU/network前一采样，history空。终止：dispose取消读取并清基线历史。恢复：读取失败或计数不连续→下一样本重建基线。

跨层/对象依赖：ISM-004, ISM-023。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/plugins/system-monitor/main/system.test.ts](/Users/zvf003/ZStack/oc-chan/src/plugins/system-monitor/main/system.test.ts)；[src/plugins/system-monitor/main/network.test.ts](/Users/zvf003/ZStack/oc-chan/src/plugins/system-monitor/main/network.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-028 · Tern导航验证、聚焦与取消

类型 `implicit`；风险优先级 **高**；所有者 `TernNavigation + helper`。置信度：高：实现证据；风险未经动态复现。

证据：[src/main/tern-navigation.ts:192](/Users/zvf003/ZStack/oc-chan/src/main/tern-navigation.ts:192)；[src/main/tern-present.swift:181](/Users/zvf003/ZStack/oc-chan/src/main/tern-present.swift:181)；[src/main/tern-present.swift:273](/Users/zvf003/ZStack/oc-chan/src/main/tern-present.swift:273)；[resources/tern-navigation/plugin/window.luau:4](/Users/zvf003/ZStack/oc-chan/resources/tern-navigation/plugin/window.luau:4)。

状态变量/派生状态：`active/closed/controller/deadline/timedOut`；`helper remainingElements/focusedSince`。

写入者：focus/navigate/command/cancel/close；helper focus polling。读取者：verifyResources/verifyPane/pluginReady；native identity checks。

转换、守卫及副作用：

- 验证资源→probe身份→inspect pane→必要时安装插件→重验身份和pane→focus→原生present回执
- busy拒绝并发；cancel/close等待命令释放

初始化：active空、closed=false。终止：cancel等命令关闭；close永久拒绝。恢复：失败后可再次focus；每次重验身份与资源。

跨层/对象依赖：ISM-023, ISM-029, ISM-035, ISM-036。

风险：用户点定位后外部Tern重启或pane复用→前后probe/inspect身份不一致→拒绝；命令超时与原生聚焦可能交错。当前双重验证与总期限降低错窗风险。

建议：集中resolve/validate/focus/present/confirmed阶段，确认点必须是helper回执。

现有相关测试：[src/main/tern-navigation.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/tern-navigation.test.ts)；[src/main/tern-present.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/tern-present.test.ts)。

缺口：本次不执行外部窗口操作；需要独立阅读验证PID/会话路径与最终回执。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-029 · 跨窗口导航意图与身份失效

类型 `implicit`；风险优先级 **低**；所有者 `PendingNavigation + view states`。置信度：高：实现证据；风险未经动态复现。

证据：[src/shared/navigation.ts:42](/Users/zvf003/ZStack/oc-chan/src/shared/navigation.ts:42)；[src/renderer/src/App.tsx:66](/Users/zvf003/ZStack/oc-chan/src/renderer/src/App.tsx:66)；[src/renderer/src/view-state.ts:61](/Users/zvf003/ZStack/oc-chan/src/renderer/src/view-state.ts:61)；[src/renderer/src/AgentsView.tsx:144](/Users/zvf003/ZStack/oc-chan/src/renderer/src/AgentsView.tsx:144)；[src/renderer/src/SchedulesView.tsx:219](/Users/zvf003/ZStack/oc-chan/src/renderer/src/SchedulesView.tsx:219)；[src/renderer/src/AgentsView.tsx:80](/Users/zvf003/ZStack/oc-chan/src/renderer/src/AgentsView.tsx:80)。

状态变量/派生状态：`main.intent/sequence；receivedNavigation/consumed`；`selectedId/identity/open/unavailable/sourceTarget`。

写入者：put/acknowledge/openTarget/reconcileAgentView/reconcileScheduleView。读取者：navigation IPC；consumed sequence；selected identity。

转换、守卫及副作用：

- put覆盖最新意图→renderer取并路由→按sequence ack
- 对象身份不匹配→失效说明而非跳转到复用ID
- 重复意图去重；旧ack不可删除新意图

初始化：intent空、sequence0、view初始未选中。终止：对应sequence ack清意图；视图身份消失标失效。恢复：新导航覆盖旧意图；重新选中当前证据对象。

跨层/对象依赖：ISM-001, ISM-032, ISM-034。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/navigation.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/navigation.test.ts)；[src/renderer/src/view-state.test.ts](/Users/zvf003/ZStack/oc-chan/src/renderer/src/view-state.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：隔离探针通过指定转换；不是生产故障复现。

### ISM-030 · 设置连接、保存队列与焦点恢复

类型 `implicit`；风险优先级 **中**；所有者 `SettingsProvider`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/settings.tsx:42](/Users/zvf003/ZStack/oc-chan/src/renderer/src/settings.tsx:42)；[src/renderer/src/settings.tsx:182](/Users/zvf003/ZStack/oc-chan/src/renderer/src/settings.tsx:182)；[src/renderer/src/settings.tsx:206](/Users/zvf003/ZStack/oc-chan/src/renderer/src/settings.tsx:206)；[src/renderer/src/ThemePicker.tsx:11](/Users/zvf003/ZStack/oc-chan/src/renderer/src/ThemePicker.tsx:11)；[src/renderer/src/SettingsSaveError.tsx:110](/Users/zvf003/ZStack/oc-chan/src/renderer/src/SettingsSaveError.tsx:110)。

状态变量/派生状态：`snapshot/loadError/attempt/received/active`；`pending/queued/saving/error/retryFocus/restoreFocus/themePreview`。

写入者：subscription/load effect；save/update/retry；previewTheme。读取者：snapshot UI；pending guard；focus restore。

转换、守卫及副作用：

- subscribe先于snapshot；已收到事件则忽略初始响应
- save中合并后续patch；成功用主进程snapshot，失败保存重试patch
- retry后仅焦点未被用户移动时恢复原控件

初始化：snapshot空、load attempt0、pending=false。终止：effect卸载退订；玻璃预览由独立清理处理。恢复：加载失败attempt++；保存错误保留patch重试。

跨层/对象依赖：ISM-002, ISM-015。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：未单列专门测试；可能由集成smoke覆盖，不能据此断言完全无覆盖。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-031 · 更新界面连接与动作仲裁

类型 `implicit`；风险优先级 **中**；所有者 `UpdatesProvider`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/updates.tsx:21](/Users/zvf003/ZStack/oc-chan/src/renderer/src/updates.tsx:21)；[src/renderer/src/UpdateSettings.tsx:7](/Users/zvf003/ZStack/oc-chan/src/renderer/src/UpdateSettings.tsx:7)。

状态变量/派生状态：`latest.revision/generation/operation/pendingRef/failure/attempt`。

写入者：accept/connect/run/reconnect/effect cleanup。读取者：generation/operation/revision guards；UpdateSettings。

转换、守卫及副作用：

- subscribe+snapshot以revision接受最新
- check/download/install互斥；download pending允许cancel抢占
- reconnect递增generation；卸载失效旧返回

初始化：snapshot空、pending snapshot、generation0。终止：卸载generation++并退订。恢复：reconnect/动作重试；revision拒绝旧快照。

跨层/对象依赖：ISM-007。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/app-updates.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/app-updates.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-032 · 可见性、暂停和监控快照同步

类型 `implicit`；风险优先级 **中**；所有者 `App/Tray/SourcePanels subscriptions`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/App.tsx:83](/Users/zvf003/ZStack/oc-chan/src/renderer/src/App.tsx:83)；[src/renderer/src/App.tsx:135](/Users/zvf003/ZStack/oc-chan/src/renderer/src/App.tsx:135)；[src/renderer/src/TrayView.tsx:18](/Users/zvf003/ZStack/oc-chan/src/renderer/src/TrayView.tsx:18)；[src/renderer/src/SourcePanels.tsx:85](/Users/zvf003/ZStack/oc-chan/src/renderer/src/SourcePanels.tsx:85)；[src/preload/index.ts:16](/Users/zvf003/ZStack/oc-chan/src/preload/index.ts:16)。

状态变量/派生状态：`pausedAt/hiddenAt/active/received(section)`；`heartbeat/snapshot/bridgeError`。

写入者：visibilitychange；pause action；receive/snapshot；cleanup。读取者：frozenAt；section received set；page data consumers。

转换、守卫及副作用：

- 可见且未暂停→订阅先行→snapshot按section合并
- 隐藏/暂停→退订与冻结时间；恢复→重取snapshot
- 来源页独立heartbeat订阅；tray相同合并策略

初始化：空monitor snapshot、初始可见性。终止：hidden/paused退订；卸载active=false。恢复：恢复重新订阅并按section合并初始snapshot。

跨层/对象依赖：ISM-005, ISM-006, ISM-040, ISM-042。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/main/monitor-subscriptions.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/monitor-subscriptions.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-033 · 事件页面筛选、固定水位和分页恢复

类型 `hybrid`；风险优先级 **中**；所有者 `EventsView`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/EventsView.tsx:126](/Users/zvf003/ZStack/oc-chan/src/renderer/src/EventsView.tsx:126)；[src/main/index.ts:552](/Users/zvf003/ZStack/oc-chan/src/main/index.ts:552)。

状态变量/派生状态：`phase/generation/requestId/lastRequestId`；`draft/applied/query/page/history/request/error/readAt`。

写入者：requestPage；query completion；effect cleanup；visibilitychange。读取者：generation token；canRead；pagination upper。

转换、守卫及副作用：

- 显式请求→generation++并cancel旧请求→loading
- 返回generation匹配且upper一致→ready
- 隐藏/停用→inactive；恢复刷新成功页而不推进失败请求游标

初始化：默认filters/query、无page、phase loading。终止：hidden/停用/卸载cancel并使generation失效。恢复：恢复成功页；失败请求显式retry；latest重置upper。

跨层/对象依赖：ISM-022, ISM-029。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[scripts/smoke/events-scenarios.mjs](/Users/zvf003/ZStack/oc-chan/scripts/smoke/events-scenarios.mjs)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-034 · 任务抽屉、退出保留与滚动焦点

类型 `implicit`；风险优先级 **低**；所有者 `SchedulesView drawer`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/SchedulesView.tsx:138](/Users/zvf003/ZStack/oc-chan/src/renderer/src/SchedulesView.tsx:138)；[src/renderer/src/ScheduleHistory.tsx:40](/Users/zvf003/ZStack/oc-chan/src/renderer/src/ScheduleHistory.tsx:40)。

状态变量/派生状态：`open/unavailable/selected/retainedJob`；`revealPending/focusPending/restoreDetail/documentHidden`。

写入者：selectJob/close/intents/restore effects/retained timer。读取者：selectedVisible；open；history onSettled。

转换、守卫及副作用：

- select/导航→打开并聚焦；history settled→恢复滚动
- 关闭→暂存retainedJob至退出动画结束
- 用户滚动取消自动恢复；隐藏取消history

初始化：初始view关闭；memory已有滚动可恢复。终止：关闭保留离场数据至timer结束；卸载保存滚动。恢复：重开同对象恢复；身份失效清history offset。

跨层/对象依赖：ISM-011, ISM-029。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[scripts/smoke/scenarios.mjs](/Users/zvf003/ZStack/oc-chan/scripts/smoke/scenarios.mjs)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-035 · 2D拓扑测量、布局和视口仲裁

类型 `implicit`；风险优先级 **高**；所有者 `TopologyCanvas`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/AgentTopology.tsx:212](/Users/zvf003/ZStack/oc-chan/src/renderer/src/AgentTopology.tsx:212)；[src/renderer/src/view-state.ts:83](/Users/zvf003/ZStack/oc-chan/src/renderer/src/view-state.ts:83)。

状态变量/派生状态：`pendingDimensions/measurementFrame/appliedDimensions/layoutKey`；`fitRequest/fittedRequest/fitTarget/revealAllowed/hadNodes`；`manualPositions/memory.viewport/mounted`。

写入者：onNodesChange/scheduleMeasurements/layout effects/fitAll/relayout/chooseViewport。读取者：initialized/measured/pendingDimensions/layoutKey/revealAllowed。

转换、守卫及副作用：

- 节点尺寸事件→RAF合并→layout→尺寸全就绪才fit
- 筛选改变清手动布局；页变更重建测量；普通采样保留视口
- 用户视口操作取消自动reveal；隐藏取消RAF，恢复补测量

初始化：空nodes，导入保存viewport/position。终止：卸载/隐藏取消measurement RAF与监听。恢复：重新测量后layout；fit/relayout为显式动作。

跨层/对象依赖：ISM-029, ISM-037, ISM-042。

风险：布局尺寸回报、筛选、用户拖动、自动定位同帧发生→手动坐标与fit请求竞争；当前measurementFrame、layoutKey和revealAllowed仲裁。

建议：抽出测量→布局→可fit状态和用户视口优先规则；不引入常驻模拟。

现有相关测试：[src/renderer/src/agent-topology.test.ts](/Users/zvf003/ZStack/oc-chan/src/renderer/src/agent-topology.test.ts)；[src/renderer/src/view-state.test.ts](/Users/zvf003/ZStack/oc-chan/src/renderer/src/view-state.test.ts)；[scripts/smoke/topology-scenarios.mjs](/Users/zvf003/ZStack/oc-chan/scripts/smoke/topology-scenarios.mjs)。

缺口：布局纯函数测试不证明交互；已有smoke场景，动态尺寸与快速反向未在本次运行。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-036 · 3D场景异步装载、失败重试与GPU释放

类型 `implicit`；风险优先级 **高**；所有者 `AgentTopology3D + TopologyScene`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/AgentTopology3D.tsx:61](/Users/zvf003/ZStack/oc-chan/src/renderer/src/AgentTopology3D.tsx:61)；[src/renderer/src/agent-topology-scene.ts:105](/Users/zvf003/ZStack/oc-chan/src/renderer/src/agent-topology-scene.ts:105)；[src/renderer/src/agent-topology-scene.ts:426](/Users/zvf003/ZStack/oc-chan/src/renderer/src/agent-topology-scene.ts:426)；[src/renderer/src/agent-topology-scene.ts:665](/Users/zvf003/ZStack/oc-chan/src/renderer/src/agent-topology-scene.ts:665)。

状态变量/派生状态：`loading/failure/attempt/disposed/owned/scene`；`scene.frame/visible/failed/disposed/graph/session.camera`。

写入者：import callback；constructor；update；invalidate；contextLost；dispose。读取者：budget；disposed；failed；document.hidden；intersection visible。

转换、守卫及副作用：

- 预算检查→import→未卸载则构建scene→update→按需RAF
- contextlost/render异常→failed停止调度→用户重试重建
- 隐藏/离屏取消帧；卸载dispose GPU/observer/listeners

初始化：预算通过后异步import，loading=true。终止：dispose释放scene资源；contextlost停止帧。恢复：attempt重建scene；保留session视口/楼层记忆。

跨层/对象依赖：ISM-029, ISM-037。

风险：静态条件风险：TopologyScene构造过程创建WebGLRenderer、DOM和监听器后，若后续observer/resize初始化抛错，new尚未赋值给外层owned；外层catch的owned?.dispose无法清理半构造实例。字段几何对象本身可由GC回收，但监听/DOM/GPU所有权需单独核验。未动态复现。

建议：用工厂或try/finally统一构造失败和已构造dispose责任；区分loading/ready/context-lost/disposing。

现有相关测试：[src/renderer/src/agent-topology-3d-layout.test.ts](/Users/zvf003/ZStack/oc-chan/src/renderer/src/agent-topology-3d-layout.test.ts)；[scripts/smoke/topology-scenarios.mjs](/Users/zvf003/ZStack/oc-chan/scripts/smoke/topology-scenarios.mjs)。

缺口：需注入ResizeObserver/resize等构造后半段失败并统计DOM监听/GPU释放；本次仅静态定位。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-037 · 3D指针选择、拖动与轨道控制

类型 `implicit`；风险优先级 **中**；所有者 `TopologyScene pointer gesture`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/agent-topology-scene.ts:598](/Users/zvf003/ZStack/oc-chan/src/renderer/src/agent-topology-scene.ts:598)。

状态变量/派生状态：`pointerStart/dragged/controls.enabled/dragPlane/dragOffset`；`session.positions/floorByAgent`。

写入者：pointerDown/pointerMove/pointerUp/pointerCancel。读取者：pointer identity；dragged threshold；floor bounds；controls.enabled。

转换、守卫及副作用：

- pointerdown命中员工→禁用orbit并capture
- 移动>4px→drag并限制在楼层；pointerup未drag→选择
- pointercancel/lostcapture/节点消失→清pointer并启用orbit

初始化：pointerStart空、controls.enabled=true。终止：pointerup/cancel/lostcapture清手势；scene销毁清监听。恢复：下次pointerdown重建；对象消失时cancel。

跨层/对象依赖：ISM-036。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：未单列专门测试；可能由集成smoke覆盖，不能据此断言完全无覆盖。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-038 · 侧栏拖动与键盘宽度提交

类型 `implicit`；风险优先级 **低**；所有者 `SidebarResizeHandle`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/SidebarResizeHandle.tsx:11](/Users/zvf003/ZStack/oc-chan/src/renderer/src/SidebarResizeHandle.tsx:11)。

状态变量/派生状态：`drag/frame/preferredWidth/currentWidth/maximum`；`keyboardTimer/keyboardWidth/persisted`。

写入者：startDrag/moveDrag/finishDrag/onKeyDown/saveKeyboardWidth。读取者：current drag；persisted save status；maximum width。

转换、守卫及副作用：

- pointermove→RAF更新；up→保存；cancel/Escape/compact→回滚
- 键盘增减→250ms合并保存；容器变化夹取
- blur/hidden/unmount中断拖动并清帧

初始化：读取保存sidebarWidth，无drag/keyboard pending。终止：取消/失焦/隐藏/卸载终止拖动与RAF。恢复：保存失败沿用SettingsProvider重试；断点夹取宽度。

跨层/对象依赖：ISM-030。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[scripts/smoke/scenarios.mjs](/Users/zvf003/ZStack/oc-chan/scripts/smoke/scenarios.mjs)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-039 · 权限设置页面异步动作

类型 `implicit`；风险优先级 **中**；所有者 `Permission setting components`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/AccessibilitySetting.tsx:7](/Users/zvf003/ZStack/oc-chan/src/renderer/src/AccessibilitySetting.tsx:7)；[src/renderer/src/NotificationSettings.tsx:60](/Users/zvf003/ZStack/oc-chan/src/renderer/src/NotificationSettings.tsx:60)。

状态变量/派生状态：`alive/mounted/pending/busy/failure`；`permissionPending/requesting/openingSettings/availability`。

写入者：request/requestPermission/openSettings；focus+visibility effects。读取者：pending/mounted guards；capability；OS state。

转换、守卫及副作用：

- 聚焦/可见→查权限；打开系统设置后再查
- busy守卫合并/拒绝重复点击；失败保留动作重试
- 卸载后不接受返回；通知请求与打开设置互斥

初始化：state未知，pending=false。终止：卸载alive/mounted=false。恢复：返回页面/聚焦重新查；失败动作显式重试。

跨层/对象依赖：ISM-013, ISM-018, ISM-030。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：未单列专门测试；可能由集成smoke覆盖，不能据此断言完全无覆盖。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-040 · 渲染插件装载、禁用和错误边界

类型 `implicit`；风险优先级 **中**；所有者 `RendererRegistry + ContributionBoundary`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/plugins/registry.ts:18](/Users/zvf003/ZStack/oc-chan/src/renderer/src/plugins/registry.ts:18)；[src/renderer/src/plugins/index.tsx:18](/Users/zvf003/ZStack/oc-chan/src/renderer/src/plugins/index.tsx:18)；[src/renderer/src/plugins/ContributionBoundary.tsx:9](/Users/zvf003/ZStack/oc-chan/src/renderer/src/plugins/ContributionBoundary.tsx:9)。

状态变量/派生状态：`installed/registrations/pending/errors/listeners`；`load token；boundary.error`。

写入者：reconcile/register/retry/dispose；getDerivedStateFromError。读取者：pending token；registration identity；getSnapshot；boundary render。

转换、守卫及副作用：

- reconcile启用→load token→注册；停用删除token并移除contribution
- 晚到import因token失效丢弃；error阻止自动重试；retry清error
- render错误boundary显示重试；dispose清注册和监听

初始化：installed/pending/errors空。终止：dispose清token、注册、订阅；停用剔除非retain项。恢复：retry清errors并reconcile；boundary retry清error。

跨层/对象依赖：ISM-004, ISM-032。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/renderer/src/plugin-registry.test.ts](/Users/zvf003/ZStack/oc-chan/src/renderer/src/plugin-registry.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-041 · 来源重试动作与操作控件保留

类型 `implicit`；风险优先级 **低**；所有者 `SourceSection + SourceRow`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/SourcePanels.tsx:27](/Users/zvf003/ZStack/oc-chan/src/renderer/src/SourcePanels.tsx:27)；[src/renderer/src/components.tsx:227](/Users/zvf003/ZStack/oc-chan/src/renderer/src/components.tsx:227)。

状态变量/派生状态：`request/pending/error/mounted/keepAction/changing`。

写入者：toggle/retry/finally。读取者：canRetry/request/mounted/saving；keepAction。

转换、守卫及副作用：

- toggle→设置保存；retry→采集刷新或单source重试
- 结果更新来源后保留操作入口；unmount使返回失效

初始化：pending/error空、request=false。终止：unmount mounted=false；finally释放请求锁。恢复：失败保留error，用户重试；启用状态控制可执行。

跨层/对象依赖：ISM-004, ISM-005, ISM-030。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[scripts/smoke/scenarios.mjs](/Users/zvf003/ZStack/oc-chan/scripts/smoke/scenarios.mjs)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-042 · 最近活动过期与可见动效

类型 `implicit`；风险优先级 **低**；所有者 `useRecentAgents + motion observers`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/components.tsx:44](/Users/zvf003/ZStack/oc-chan/src/renderer/src/components.tsx:44)；[src/renderer/src/components.tsx:70](/Users/zvf003/ZStack/oc-chan/src/renderer/src/components.tsx:70)；[src/renderer/src/AgentTopology.tsx:168](/Users/zvf003/ZStack/oc-chan/src/renderer/src/AgentTopology.tsx:168)；[src/renderer/src/agent-topology.css:294](/Users/zvf003/ZStack/oc-chan/src/renderer/src/agent-topology.css:294)；[src/renderer/src/styles.css:245](/Users/zvf003/ZStack/oc-chan/src/renderer/src/styles.css:245)。

状态变量/派生状态：`expiry/pausedAt/nextExpiry`；`observer intersection + motion visibility`。

写入者：expiry timer；intersection callback。读取者：pausedAt；recent activity age；CSS data-motion and reduced-motion。

转换、守卫及副作用：

- 最近活动→定时到期清投影；暂停按frozen时间计算
- 离屏停止motion；卸载disconnect/clearTimeout

初始化：按当前活动最早expiry安排timer。终止：卸载清timer/observer；暂停冻结展示时间。恢复：恢复重新按时间计算，不恢复过期活动。

跨层/对象依赖：ISM-025, ISM-032。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：未单列专门测试；可能由集成smoke覆盖，不能据此断言完全无覆盖。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-043 · 托盘显示组合持久化

类型 `implicit`；风险优先级 **低**；所有者 `Tray selection`。置信度：高：实现证据；风险未经动态复现。

证据：[src/renderer/src/TrayView.tsx:23](/Users/zvf003/ZStack/oc-chan/src/renderer/src/TrayView.tsx:23)；[src/renderer/src/TrayView.tsx:58](/Users/zvf003/ZStack/oc-chan/src/renderer/src/TrayView.tsx:58)；[src/renderer/src/plugins/tray-selection.ts:4](/Users/zvf003/ZStack/oc-chan/src/renderer/src/plugins/tray-selection.ts:4)。

状态变量/派生状态：`selection.excluded/preferenceError/localStorage`。

写入者：storage load；selectPanel；updateTraySelection。读取者：parseTraySelection；isTrayPanelSelected；tray contribution render。

转换、守卫及副作用：

- mount解析存储→选择集
- toggle→校验上限→写localStorage→更新selection；失败显示错误

初始化：parse localStorage或默认excluded空。终止：组件卸载；偏好存储跨应用保留。恢复：存储失败显示preferenceError；下次显式修改重试。

跨层/对象依赖：ISM-008, ISM-040。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[src/renderer/src/tray-selection.test.ts](/Users/zvf003/ZStack/oc-chan/src/renderer/src/tray-selection.test.ts)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-044 · 开发实例进程组与清理

类型 `implicit`；风险优先级 **中**；所有者 `develop launcher`。置信度：高：实现证据；风险未经动态复现。

证据：[scripts/develop.mjs:17](/Users/zvf003/ZStack/oc-chan/scripts/develop.mjs:17)；[scripts/develop.mjs:101](/Users/zvf003/ZStack/oc-chan/scripts/develop.mjs:101)。

状态变量/派生状态：`child/requestedSignal/forceTimer/instance`。

写入者：main/run/stop/signalGroup/finally。读取者：requestedSignal；child PID group liveness。

转换、守卫及副作用：

- 创建独立目录→构建→运行
- signal→组SIGTERM→期限后SIGKILL
- 子进程退出→核对组已结束→删除本实例；仍存活保留现场

初始化：创建独立instance，无child或signal。终止：终止进程组后才删除instance。恢复：异常保留存活实例目录，失败非自动成功。

跨层/对象依赖：ISM-001。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：未单列专门测试；可能由集成smoke覆盖，不能据此断言完全无覆盖。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-045 · 本机安装替换、就绪握手和还原

类型 `implicit`；风险优先级 **高**；所有者 `local installer + installation probe`。置信度：高：实现证据；风险未经动态复现。

证据：[scripts/install-local.mjs:92](/Users/zvf003/ZStack/oc-chan/scripts/install-local.mjs:92)；[scripts/install-local.mjs:129](/Users/zvf003/ZStack/oc-chan/scripts/install-local.mjs:129)；[scripts/install-validation.mjs:46](/Users/zvf003/ZStack/oc-chan/scripts/install-validation.mjs:46)；[src/main/installation-check.mts:113](/Users/zvf003/ZStack/oc-chan/src/main/installation-check.mts:113)。

状态变量/派生状态：`install lock/staging/movedPrevious/installed/keep paths`；`request nonce/PID/executable/version/status/controller`。

写入者：replaceBundle；application；runInstallationCheck；result publish。读取者：verifyInstallBundle/verifyInstallationResult；lock；executable+PID match。

转换、守卫及副作用：

- 验证source/bundle→同盘stage→停止旧应用→rename旧包和新包→启动→实际就绪回执
- 失败→停止新包→还原旧包；还原失败保留现场
- probe期限→ready/failed→临时结果sync+rename

初始化：校验目标并独占安装锁、准备staging。终止：验收成功删previous；失败回滚/保留现场。恢复：新启动失败还原旧包；回滚失败人工检查证据。

跨层/对象依赖：ISM-001, ISM-046。

风险：旧应用停止后新包rename成功，但就绪回执超时/身份不符→撤销新包并还原旧包；回滚也失败则保留现场。必须区分installed与ready，防止删除唯一可用备份。

建议：保留事务flags但集中枚举prepared/old-moved/new-installed/verified/rollback-failed；每阶段记录证据。

现有相关测试：[scripts/install-local.test.mjs](/Users/zvf003/ZStack/oc-chan/scripts/install-local.test.mjs)；[src/main/installation-check.test.ts](/Users/zvf003/ZStack/oc-chan/src/main/installation-check.test.ts)。

缺口：已有replaceBundle与握手测试；本次未执行安装、启动或回滚真实应用。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-046 · 本地交付验证及失败保留

类型 `implicit`；风险优先级 **中**；所有者 `local delivery`。置信度：高：实现证据；风险未经动态复现。

证据：[scripts/local-delivery.mjs:21](/Users/zvf003/ZStack/oc-chan/scripts/local-delivery.mjs:21)；[scripts/local-delivery.mjs:125](/Users/zvf003/ZStack/oc-chan/scripts/local-delivery.mjs:125)；[scripts/local-delivery.mjs:157](/Users/zvf003/ZStack/oc-chan/scripts/local-delivery.mjs:157)；[scripts/delivery-source.mjs:80](/Users/zvf003/ZStack/oc-chan/scripts/delivery-source.mjs:80)。

状态变量/派生状态：`controller/snapshot/failure/receipt/mounted`；`source initial/final identity`。

写入者：createLocalDelivery；snapshotSource；command；verifyDmg；cleanup。读取者：source identity before-after；receipt complete；artifact digests。

转换、守卫及副作用：

- 固定源码→隔离构建→包/签名/zip/dmg验证→源码未变→完整receipt
- 取消→终止所属进程组；镜像弹出后删除临时目录
- 失败写failure.json，不写完成receipt

初始化：新专属输出目录、固定源码manifest。终止：成功delivery receipt最后写；失败failure记录。恢复：取消释放所属进程/挂载；不复用不完整交付为成功。

跨层/对象依赖：ISM-045, ISM-047。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[scripts/local-delivery.test.mjs](/Users/zvf003/ZStack/oc-chan/scripts/local-delivery.test.mjs)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-047 · ZIP验证worker与流关闭

类型 `implicit`；风险优先级 **中**；所有者 `ZIP worker`。置信度：高：实现证据；风险未经动态复现。

证据：[scripts/delivery-zip.mjs:189](/Users/zvf003/ZStack/oc-chan/scripts/delivery-zip.mjs:189)；[scripts/delivery-zip.mjs:241](/Users/zvf003/ZStack/oc-chan/scripts/delivery-zip.mjs:241)。

状态变量/派生状态：`worker/deadline/stream/decoder/closed/failure`。

写入者：verifyDeliveryZip；verifyInWorker；stream close；worker terminate。读取者：deadline；identity；worker result。

转换、守卫及副作用：

- 预检中央目录→worker逐项流式hash→回执
- 120秒/错误→finally terminate；每流等待close
- 前后文件identity一致才接受

初始化：固定ZIP identity，启动有界worker。终止：finally terminate worker、关stream/file。恢复：失败整次验证重做；不接受部分digest。

跨层/对象依赖：ISM-046。

风险：未识别具体缺陷；静态审计不证明不存在风险

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[scripts/delivery-zip.test.mjs](/Users/zvf003/ZStack/oc-chan/scripts/delivery-zip.test.mjs)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

### ISM-048 · 发布草稿、资产核验与公开提交点

类型 `hybrid`；风险优先级 **中**；所有者 `release workflow`。置信度：高：实现证据；风险未经动态复现。

证据：[scripts/prepare-release.mjs:55](/Users/zvf003/ZStack/oc-chan/scripts/prepare-release.mjs:55)；[scripts/publish-release.mjs:20](/Users/zvf003/ZStack/oc-chan/scripts/publish-release.mjs:20)；[.github/workflows/build.yml:128](/Users/zvf003/ZStack/oc-chan/.github/workflows/build.yml:128)。

状态变量/派生状态：`release.draft/prerelease/assets/expected`；`CI build→release依赖`。

写入者：prepareRelease；gh draft create/upload/edit。读取者：requireReleaseEnvironment；inspectReleaseAssets；draft readback asset checks。

转换、守卫及副作用：

- tag/version/环境校验→本地digest→draft创建→upload
- readback draft资产size/digest/state完整→edit公开
- 中途失败保留draft；不clobber旧资产

初始化：tag/version/资产与公开仓库检查通过。终止：最后gh edit提交公开；中途失败保留draft。恢复：现有同tag草稿会冲突拒绝，不自动clobber。

跨层/对象依赖：ISM-007, ISM-046。

风险：静态风险：最后gh release edit后直接返回Published，没有再次读回最终draft=false/latest状态；命令成功不等同独立读取最终状态。

建议：保留现有局部状态；用类型约束、命名清晰的转换函数和取消/清理不变量即可，不必引入状态机库。

现有相关测试：[scripts/prepare-release.test.mjs](/Users/zvf003/ZStack/oc-chan/scripts/prepare-release.test.mjs)。

缺口：所列测试仅为相关源码证据，不表示本次执行通过；建议复核本文转换表中的失败、重复事件和卸载后返回边界。

验证状态：静态确认状态对象；未复现生产bug。

## 显式模型边界

- **BOUND-01 PluginPhase枚举**：阶段已显式命名，但Entry组合及转换守卫仍隐式，计入hybrid。证据：[src/main/plugins/contracts.ts:12](/Users/zvf003/ZStack/oc-chan/src/main/plugins/contracts.ts:12)。
- **BOUND-02 UpdatePhase枚举**：状态快照明确，candidate/operation/running组合隐式。证据：[src/shared/updates.ts:1](/Users/zvf003/ZStack/oc-chan/src/shared/updates.ts:1)。
- **BOUND-03 NotificationState.phase**：可用性投影不是完整生命周期模型。证据：[src/shared/notifications.ts:21](/Users/zvf003/ZStack/oc-chan/src/shared/notifications.ts:21)。
- **BOUND-04 来源、Agent、任务及历史状态**：上游证据的纯派生值；本应用不拥有任务执行转换，不单独计数。证据：[src/shared/types.ts:6](/Users/zvf003/ZStack/oc-chan/src/shared/types.ts:6)；[src/main/collectors/hermes-runtime.ts:75](/Users/zvf003/ZStack/oc-chan/src/main/collectors/hermes-runtime.ts:75)；[src/main/collectors/launchd.ts:81](/Users/zvf003/ZStack/oc-chan/src/main/collectors/launchd.ts:81)。
- **BOUND-05 GitHub Actions jobs/needs/if DAG**：外部引擎显式流程；发布脚本跨命令事务计hybrid。证据：[.github/workflows/build.yml:18](/Users/zvf003/ZStack/oc-chan/.github/workflows/build.yml:18)。
- **BOUND-06 UI加载phase union**：与generation/current/page组合共同建模，不每个phase再计一次。证据：[src/renderer/src/EventsView.tsx:127](/Users/zvf003/ZStack/oc-chan/src/renderer/src/EventsView.tsx:127)；[src/renderer/src/ScheduleHistory.tsx:33](/Users/zvf003/ZStack/oc-chan/src/renderer/src/ScheduleHistory.tsx:33)。

## 验证与限制

实际执行：

1. `git status --short --branch`、`git rev-parse HEAD`，以及 tracked/untracked 文件枚举；只读。
2. `node --import tsx docs/audits/implicit-state-machines-20261109-omp/probe.mts`：4条转换断言通过，输出在 [probe-result.json](probe-result.json)。插件使用无IO的延迟promise、设置使用注入save拒绝；未读取/修改个人设置。其余两个直接调用生产纯函数。首次探针错误匹配被包装的异常文本，修正为检查stage/cause后通过，未改实现。
3. `node docs/audits/implicit-state-machines-20261109-omp/verify-audit.mjs`：聚合3批清单、检查ID/职责去重、依赖引用、测试路径、139处代码行摘录和全体240文件哈希，结果在 [verification.json](verification.json)。扫描期间源码未发生变化。

未执行已有仓库测试、构建、lint、formatter、Electron/UI、真实OS权限、真实通知、网络更新、应用替换或发布。静态结论不能替代这些场景的验收。没有测量CPU/内存/帧率，也没有宣称性能提升、无OOM或无竞态。

## 复核入口与后续动作

本阶段是主审计，不包含验收要求中的独立复核。由开发负责人另开OMP只读会话，禁止直接按此报告重构或合并。建议独立复核：

1. 重新核对branch/HEAD与coverage哈希，若工作区变化仅重审变更及受影响依赖。
2. 复核ISM-017的commit→onCommitted间隔，区分既定不重放语义与真正可靠性缺陷。
3. 复核ISM-036构造后半段失败的资源所有权，用隔离注入证明或排除残留。
4. 复核ISM-004超时排空及ISM-018原生回调释放，不把故意保留所有权误报泄露。
5. 抽查coverage中“不适用”的纯投影、插件包装器和交付脚本，寻找遗漏对象或过度合并；尤其检验ISM-039是否应拆为两个UI协议。
6. 复核ISM-022 query清理提升revision与旧commit拒绝；核对现有测试真实断言。
7. 逐条接受/驳回静态风险并补证据；任何实现变更另行立项。

恢复提示与更细验收清单：[handoff.md](handoff.md)。报告和清单都保留在本任务耐久目录，未公开托管；不生成额外HTML。
