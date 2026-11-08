# OC Chan 清单串行实施交接 · 2026-11-04

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：本轮合并在独立工作树 `/Users/zvf003/tmp/oc-chan-backlog-master-20261106` 的 `master` 完成；原工作树仍在 `fix/oc-chan-r04-admin-sampler-20261106`，保留其未提交和并行改动。历史重构分支和阶段记录见下文。
- 目标：按依赖串行执行 `docs/oc-chan-todolist.md` 的本期工作，保留37卡台账。已接续[用户四项范围决定](2026-11-04-owner-scope-decisions.md)：仅M系列arm64本地自用；F-07只读接口调研；D-01正式签名公证与O-01多人试用延期；D-02区分本地材料与延期正式发布，D-03仅arm64本地开发包。延期与局部交付不等于整卡完成。
- 授权：实施和必要本地验证；2026-11-05用户明确选择“安装并做原生验收”，当时的arm64修复包已安装。2026-11-06用户追加“提交到master”“推送到github”，本轮只提交、合并和推送代码，单次跳过本机安装hook，不重装应用；正式发布及外部联系仍无授权。注销和睡眠专项须避开长测。
- 当前：27/37卡已有本地完成证据，剩余卡仍按实际条件保留未完成。R-04三轮长测均失败；管理员采样器已有定向与真实权限证据，但两次预验在macOS系统认证阶段超时，Electron未启动，当前无24h长测。通知权限denied，U-05/U-07/U-08/F-06/D-03原生专项未完整验收。提交及推送结果见[master合并交接](2026-11-06-backlog-master-integration.md)。

## F-01 完成证据

修改 `src/main/collectors/hermes-runtime.ts`：只读SQLite事务内按任务选择一条最新执行，按真实毫秒时间、原始时间文本、执行ID排序。避免SQLite日期函数舍入改变毫秒边界；不读取正文。返回数量受任务数约束，删除累计4096记录限制。256任务、3秒超时、8MiB SQLite堆、4MiB输出限制保留。

修改 `hermes-runtime.test.ts`：4096/4097/100000旧历史，毫秒边界、同时间/时区tie-break、多任务隔离、无效排序证据；保留真实进程、PID复用、心跳、暂停和投递结果语义覆盖。README同步实际边界。

实际命令：

- `node --import tsx --test src/main/collectors/hermes-runtime.test.ts src/main/collectors/schedules.test.ts`：37/37通过。
- `npm run typecheck`：通过。
- 独立临时SQLite脚本实际执行collectHermesRuntime：总计10万条历史，1/128/256任务各3次，修复后全部为ok/waiting并保留最近succeeded。

同机前后顺序测量：macOS arm64、Node24.22.1，固定数据库；ps每10ms采样runner及其后代，排除采样器本身。CPU/RSS是采样下界，不能代表整应用峰值。未与测试并发。旧实现遇大历史提前partial，新实现完成查询，两者耗时不代表同等成功工作量，不声称加速。

| 任务数 | 旧耗时范围 ms | 新耗时范围 ms | 旧子进程采样峰值 MiB | 新子进程采样峰值 MiB | 旧/新子进程采样CPU ms |
| --- | --- | --- | --- | --- | --- |
| 1 | 30.14–31.77 | 61.58–90.64 | 16.69 | 62.13 | 10 / 40–60 |
| 128 | 34.46–35.41 | 121.29–160.33 | 16.69 | 54.92 | 10 / 110–120 |
| 256 | 32.92–33.08 | 74.08–122.25 | 16.69 | 54.98 | 10 / 70 |

runner+子进程采样峰值最大129.25MiB。真实应用常驻、插件压力和R-04验收尚未完成。临时测量目录由本任务创建并在记录后清理。

## U-01 完成证据

新增 `src/shared/navigation.ts`：有限页面/Agent/任务/来源目标、输入白名单与长度边界、单槽待处理导航。主窗口读取后确认消费；旧确认不能清掉新请求，StrictMode首次挂载取消不会丢目标。Agent身份含运行时/PID/会话/开始时间；任务身份含来源/运行域/文件/执行入口。未公开的身份变化无法推断；名称与状态变化不改变身份。

修改共享API、preload/main、App、AgentsView、SchedulesView、AgentTopology、components及TrayView/tray.css。概览点击与托盘入口携带目标，详情保留筛选并可清除定位，关闭返回真实行/节点或搜索。来源可定位、关闭；重复导航/采样不重新抢焦点。补齐F-01英文来源说明。README和DESIGN同步。

实际验证：

- `npm run typecheck`：最终通过。
- `node --import tsx --test src/main/navigation.test.ts src/renderer/src/agent-topology.test.ts`：17/17通过。确认消费调整后只重跑navigation3项，全部通过。
- 真实headless Electron：概览第三个Agent鼠标打开、第三个任务Enter打开，详情ID一致；筛选遮挡不清条件，清除定位后聚焦关闭按钮；关闭返回正确节点/任务。
- 通过本实例Node Inspector的现有闭包向单槽放入目标、经真实IPC消费；重复3次通知不抢侧栏焦点，普通来源采样不抢焦点；放入后刷新Renderer仍打开目标且pending为空。
- 仅停止本开发实例采集并改内存快照，注入对象删除、同ID不同会话/文件；详情显示失效，不高亮替换对象。用户显式点击替换行可打开新对象。没有修改真实数据源。
- 来源行正确定位、失效来源可关闭并回侧栏；中英/深浅色检查，F-01英文来源说明实际可见。
- 内容视口1280×860、880×640：选中对象与关闭按钮可达，无全页横向溢出。托盘380×560实际链接12项（各前5+全部入口），200%文字无全页溢出，固定底部入口可达。
- 托盘实际点击返回无头原生显示拒绝；主进程确认两个BrowserWindow均visible=false、focusable=false。非法URL目标被输入边界拒绝。页面和托盘错误记录为空（预期拒绝显示为产品错误状态）。

开发启动器：npm的RTK包装服务未进入启动输出，停止该service后用同一`node scripts/develop.mjs --inspect`成功。唯一实例 `instance-xTqfTy`，service `oc-backlog-navigation-direct`；U-01验收后退出清理。主进程/Renderer端口随热重启变化，不能复用旧端口。

本卡是无头链路验收，未进行物理托盘、原生焦点、VoiceOver、完整可见动画或整应用性能基准；这些不由类型检查或截图替代。

## P-01 完成证据

测量资产、规定场景和数值预算已完成。结果见 `docs/performance-baseline.md` 与 `docs/performance-baseline.json`；产品SLO差距、短命进程采样缺口和未验收范围保留，不能当作R-04通过。

- 工具目录：`scripts/performance/`。包括固定seed夹具、有界日志/计时/统计、libproc进程树采样器、独立Vite探针及真实Electron运行器。复现和测量限制见 `docs/performance-baseline.md`。
- `scripts/develop.mjs` 支持测量配置的独立profile；退出遇EPERM时独立核对进程组成员，不能确认退出则保留目录并报错。正常开发不加载测量探针。
- 已通过：采样器编译、受控进程树归属、CPU单位与 `process.cpuUsage()` 对照（约0.23%差异）、最终 `node --test scripts/performance/core.test.mjs` 6/6。
- 完整短测：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/oc-chan-performance-mfxgNc/result.json`，`complete:true`，四个实例均清理；日志3663260字节。L1的256个事件读取/发布/IPC/提交均256，事件到提交p95为358.5ms，未达到建议250ms目标。L2覆盖突发、4096/4097配置、并发刷新、历史替换、拓扑规模、超长记录、锁库和真实查询超时，超时约3006.5ms且恢复后返回25条历史。
- 取消验收：`oc-chan-performance-cmXlBT/result.json` 明确记录SIGTERM、退出码1、`complete:false`，无cleanup/evidence错误；旁边独立对照进程存活，随后由本任务正常停止。
- 首次完整模式：`bg_22` 已结束，输出 `/tmp/oc-chan-p01-baseline-1793799317613`。10次冷启动、L0及五轮L1各2分钟预热+10分钟采样已完成；L2在约29秒突发时触及64MiB日志上限，退出码1。总日志67108818字节，`complete:false`、无cleanup错误；不得改写为成功。
- 已定位日志占用：IPC到达18.70MiB、读取13.90MiB、发布8.69MiB，记录逐行重复运行名/阶段名。仅修改 `scripts/performance/run.mjs`：schema2以至多128个scope编号引用上下文，保留每条事件和时间戳；增加 `--scenario all|startup|idle|daily|stress`。不提高64MiB上限，不丢样本。
- 修改前核对原清单80个源码文件，全部与长测开始时摘要一致。产品、夹具、探针、采样器和统计公式未改；已完成的冷启动/L0/L1不重跑。补测与首次长测具有不同runner摘要，交付必须保留两份来源，不能伪称一次完整运行。
- 首次L2补测 `bg_23` 因读取开始比事件早0.425ms中止，证据保留 `oc-chan-p01-stress-1793803718322`。根因是异步open/stat/read可在途中看到新事件；统计改为事件→读取完成，重叠读取单列，旧watch时间不填零。五轮L1用原始时间戳重算，原端到端百分位和计数不变。
- 长测L1结果：每轮输入19200条，五轮共95991/96000条到达读取、发布、IPC和提交；事件→提交p95为300–302.75ms，p99为306.5–312ms，仍未达到建议p95≤250ms。各轮应用RSS采样最大值1171.44–1261.98MiB，不能据此宣称绝对峰值或24小时验收通过。
- 资源口径：RSS为1秒采样下界，短命进程另有10ms生命周期记录；不能相加伪造同时刻峰值。全系统权限缺口与应用自身可读区间分别解释；未知值不填零。CPU只统计相邻身份与读数完整的区间，启动短阶段可能无有效CPU区间。无头可见性模拟不等于原生窗口验收。
- 最终完整L2 `bg_24` 已通过，目录 `/tmp/oc-chan-p01-stress-1793804212931`。2分钟预热+60秒突发及全部边界完成，源码指纹一致，无cleanup/evidence错误；日志15095446字节。输入76800次，53403次提交，98次重叠读取，104个读取issue；不宣称压力正确性通过。
- 已接受场景归并到 `/tmp/oc-chan-p01-accepted-BSXIOt/evidence`：841638条、15块、60263242字节（57.47MiB），无损解码SHA `012fb9f3e376d49bc550fa3a0bf68711540d30a31ecc60d8e86665c695e539be` 与原记录一致。文件清单、统计模块SHA、两次工作区来源已保存在仓库JSON。
- 冻结同环境开发基准回归线：L0 RSS1024MiB、L1 1536MiB、L2 1792MiB；CPU p95/p99分别10/20%、60/100%、200/250%，单核100%。L1事件提交p95≤350ms为现状回归线，产品建议250ms目标仍未通过；完整延迟指标见报告。
- 全部本任务测量实例均释放；原始证据保留。未提交/推送/安装/发布，未跑全仓套件，未宣称24h或原生窗口验收。

## F-02 完成证据

- 根因：本机 `/bin/launchctl print system` 退出0、stderr为空、输出65598字节；435行服务表有1行状态列为 `?`，旧解析器不接受该标记而拒绝整表。不是权限或输出上限失败；诊断仅记录列形状，不保留原始命令输出。
- 新增 `src/main/collectors/launchd.ts`：解析 `?` 和括号标记，保留PID、不伪造退出码；每表8192项、标签1024字节、输出8MiB上限。服务和禁用表独立成功/失败，固定诊断字段sourceId/operation/stage/code/retryable/observedAt及可选数值退出码；source保留最近尝试/最近成功时间。
- `ScheduleCollector` 持有投影配置和三域最近观察；失败表旧条目仅保留身份，清除本轮PID/运行证据，不能从未知推导未加载。Hermes运行时查询与plist读取继续并行。配置失败仍由Monitor保留旧快照和错误，单域恢复不清除此错误。
- `Monitor.retrySource`、preload及main的 `monitor:retry-source` 接通精确白名单路由；同来源合并，跨来源等待同一调度读槽，避免整轮结束误删后续请求的所有权。没有兼容导出，smoke调用方已迁入新collector。`SourceStatus`增加诊断时间字段，来源说明中英一致。`tsconfig`增加已支持的ES2024.Promise类型，新增测试使用withResolvers。
- 定向验证：`node --import tsx --test src/main/collectors/schedules.test.ts src/main/monitor.test.ts` 32/32通过。最后并行调整后只重跑schedules的26项，全部通过；最终 `npm run typecheck` 通过。覆盖未知状态列、错误分类/脱敏、部分成功、旧条目、恢复时间、8192/8193与单条上限、真实临时plist、配置故障、重试竞争和未知来源拒绝。
- 真实headless Electron实例 `instance-YSsDY3`：通过 `window.monitor.snapshot/retrySource` 验证gui/user/system为ok，服务数482/76/435，禁用覆盖22/22/8；1059个任务/服务、144个system运行对象。100次并发重试system共约30.5ms，其他来源内容和时间未变；非法域被拒绝。中英来源行显示Connected/已连接，Renderer错误为空；预期非法IPC拒绝写入主进程日志。截图 `/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15c1178dcc13d74f.png`。
- 本实例已释放browser接管并停止，启动器明确输出 `已清理开发实例 .../instance-YSsDY3`；没有停止其它实例。
- 同机同seed的L1短测：`/tmp/oc-chan-f02-before-20261104/result.json` 与 `/tmp/oc-chan-f02-final-20261104/result.json` 均complete，无cleanup/evidence错误。M4 Max、macOS27.2、Node24.22.1，32会话/1000plist、2秒预热+8秒采样；各256/256事件到提交、0 read issues。
- 前/后启动可交互1738.83/1357.32ms，RSS采样最大1101.41/1100.80MiB，CPU单核p95为53.25/37%，事件提交p95为293.25/345ms；交互roundtrip各仅1样本177.85/266.45ms。均在P-01现状回归预算内；延迟短测上升，不能据此宣称性能提升或确定稳定回归，产品250ms目标仍未达。中间候选 `/tmp/oc-chan-f02-after-20261104` 也保留，恢复元数据并行后已由final替代，不能混为同一源码。RSS为采样下界、短命进程覆盖缺口继续保留；未完成常驻/全应用OOM验收。
- README同步边界。未运行全仓套件、安装包/原生窗口验收，未提交、推送、安装或发布。F-03负责来源页按钮/能力矩阵。

## U-02 完成证据

- 新增 `src/renderer/src/view-state.ts` 和行为测试；App受控保存Agent/任务筛选、选择身份、详情开关、任务历史offset、系统排序及六页滚动。页面照常卸载；拓扑保存有限坐标、手动位置、视口和折叠，离场节点按完整快照回收。搜索1024字符、位置/折叠4096项、ID512字符；不存历史正文或旧监控快照，不持久化临时查看状态。
- 修改 `App.tsx`、`AgentsView.tsx`、`AgentTopology.tsx`、`SchedulesView.tsx`、`ScheduleHistory.tsx`、`SystemView.tsx`、`components.tsx`。删除被替代的useDetails路径。任务历史返回时重读同offset，核对jobId/offset；空页保留返回入口，恢复滚动可由用户操作中止。README和DESIGN同步，test脚本纳入Renderer行为测试。
- `npm run typecheck` 通过；`node --import tsx --test src/renderer/src/view-state.test.ts src/renderer/src/agent-topology.test.ts src/main/navigation.test.ts` 21/21通过。含同ID身份替换、对象消失、容量拒绝、1000轮对象换代且无旧坐标/折叠遗留。最初集成有一个JSX闭合遗漏，已修正后通过；未重跑全仓套件。
- 真实headless Electron `instance-UTnf52`：搜索“日报”+personal+waiting跨页保留，系统进程memory排序保留；实际Hermes任务历史第二页重新读取，详情scrollTop 820→820、主内容1300→1300。返回焦点保留导航；离页时历史和画布DOM卸载。
- 实际节点拖动由(0,0)到(66,39)，视口translate(281.5,116.667)/zoom0.833333跨页不变；稳定内存夹具验证折叠跨页、键盘移动、主动筛选重新布局、普通快照不重排。离页删除任务后无新增历史请求；同ID换session后不选中新对象，失效提示可关闭。
- 仅本实例内存注入有界历史延迟/空页/错误jobId：取消触发AbortSignal，释放晚到响应后不污染返回页面；用户滚轮事件完成后恢复目标取消，结果到达仍停0而非旧820；offset25空页显示上一页/首页并可回第一页。错误jobId明确显示读取失败。reload后query空、scope/status为all、详情关闭；Renderer错误记录为空，主进程保留预期AbortError日志。
- 1280×860、880×640内容视口无新增全页横向溢出。无头窗口初始visibility一直visible，CDP focus开关未产生hidden；因此隐藏仅注入DOM可见性事件验证状态保持，不能称原生隐藏/焦点/动效通过。实际横向滚动范围为0，未伪称验证非零横向恢复；后续几何/原生专项继续负责对应矩阵。
- UI证据 `/tmp/oc-chan-u02-smoke-20261104.json`；截图 `/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15c11dfef1e8c038.webp`。截图后仅澄清Agent失效原因文案，行为未改。释放CDP/browser后启动器确认已清理本任务实例，没有停止其它实例。
- L1同机同seed比较复用上一卡紧邻基线 `/tmp/oc-chan-f02-final-20261104/result.json`，本卡 `/tmp/oc-chan-u02-final-20261104/result.json`：M4 Max/macOS27.2/Node24.22.1，32会话/1000plist、2秒预热+8秒采样；均256/256提交、0 read issues。本卡complete且无cleanup/evidence错误，源码摘要 `e42c436c8426689b08cde463edd0f435a9ad6b894682de7ebcf1190484c3c397`。
- 前/后启动可交互1357.32/1793.24ms、RSS采样最大1100.80/1122.27MiB、CPU单核p95 37/45.25%、事件提交p95 345/338ms、交互roundtrip266.45/262.84ms（各仅1样本）。短测数值未越P-01回归线；启动差值主要出现在全部首快照就绪前，单轮不能判定稳定回归或提升。保留采样下界/短命进程缺口，不宣称250ms产品SLO、24h或OOM验收通过。
- 未提交、推送、安装替换或发布。

## Q-01 本地完成证据 · 2026-11-05

- `.github/workflows/build.yml` 覆盖main/master push与目标PR，保留v*和手动；完整checkout历史、不保留凭据。新增`npm run test:ci`在dist之前，dist已有typecheck→Swift→Vite→打包，不重复typecheck。双架构、固定action SHA、contents:read、取消旧构建与产物校验保留。
- 新增`scripts/ci-tests.mjs`及其8项行为测试：路径→有限套件；公共契约/依赖/跨模块入口扩大范围并打印原因；文档无产品测试，安装/hook必选安装事务；Git精确base→HEAD且关闭外部diff及rename折叠。新增测试或未知代码路径必须更新映射，缺失基准明确失败。标签/手动/新分支首次构建执行完整确定性套件。测试并发2，无个人环境smoke。
- 核对现有Hermes测试使用临时SQLite、Tern使用注入命令、安装使用临时.app；没有把个人数据或真实Tern加入CI。新测试校验manifest与当前测试文件一致、路径边界、事件范围、重命名及实际子进程退出门禁。
- `npm run test:ci -- scripts/ci-tests.mjs` 首轮7/8通过；失败根因是夹具子进程继承Node测试运行器的`NODE_TEST_CONTEXT=child-v8`，Node明确警告递归调用并跳过文件。仅在夹具创建独立CI进程时移除此内部上下文；`node --test --test-name-pattern='a real failing test' scripts/ci-tests.test.mjs` 1/1通过。真实失败测试返回1，下游标记不生成；成功测试才生成。
- `npm run test:ci -- scripts/install-local.mjs` 实际选择安装事务，9/9通过；`npm run test:ci -- --plan README.md` 清单为空。临时Gitfixture提交身份为固定用户身份，测试后目录释放。未跑全仓套件。
- 本机无actionlint；使用已有js-yaml进行YAML语法与结构断言：main/master push/PR、v*、手动、矩阵、固定SHA、权限和test→dist→upload均通过，所有步骤无continue-on-error。README同步。
- 未提交、推送、触发云端构建或替换安装；本卡验收按计划仅完成本地门禁，真实CI回执需后续授权推送，不能由本地结果冒充。

## S-01 完成证据 · 2026-11-05

- 新增`src/main/ipc-boundary.ts`统一10个invoke和1个send的来源、窗口权限、参数数量/类型/范围。移除index内旧来源校验和分散参数检查；主窗口独占设置写入、来源重试、Tern跳转、历史读/取消和导航消费。主/托盘可读快照与刷新；headless始终拒绝显示主窗/跨应用跳转。
- 真实修改前证据：托盘可将主窗语言设为en，未知设置键进入错误详情；均在独立profile重现并恢复设置。证据`/tmp/oc-chan-s01-before-20261105/ipc-reproduction.json`。
- 共享types统一Agent/任务/来源ID为512/256/128字符、Hermes原ID128字符，历史25条/页、offset 0–100000且为25倍数；reader/provider/renderer调用同步，不保留旧re-export/重复分页常量。设置对象拒绝异常原型，未知字段错误不回显输入，校验不先分配Object.entries全量副本。README逐条记录通道和副作用；CI新增ipc套件。
- 首次typecheck和定向CI入口40/40通过。真实Electron随后发现BrowserWindow已销毁而webContents尚存活时，读取window.webContents会抛原生TypeError。已补会抛异常的生命周期fixture，单独运行明确失败；修正为先检查窗口销毁状态，再访问属性，类型检查和IPC 7/7通过。其他已通过检查未重复。
- 真实Electron证据`/tmp/oc-chan-s01-smoke-20261105/result.json`：13项坏参数/headless请求拒绝；托盘5类越权invoke拒绝但2个快照正常；同URL真实子frame、退出中、错误view、异源和外来webContents拒绝；真实销毁时序修复后category=source，底层调用次数1→1。真实Hermes页offset0/25返回8/0行且limit25。三类订阅解绑后计数保持129/1/1。preload公开方法未扩大，没有window.ipcRenderer或require，所有窗口保持隐藏。
- 测试临时frame/preload已删除；本卡全部普通开发实例退出并删除其独立目录。目录检查只剩原有的instance-vbt4w7，不属于本卡；不得停止/清理。
- 标准L1 smoke（seed20261104、128会话、256事件）前→首轮后→独立后：交互启动1958→1805→2038ms；事件提交P95 304.5→357.75→335.5ms；RSS采样峰值1144.42→1121.73→1123.58MiB；CPU P95 39.5→41.25→71%。三轮256/256全部提交。首轮后同时运行本卡验收实例；独立后8个有效CPU区间含一次70.864%峰值，主要为Electron Helper pid61660，该区间主进程CPU约1.92%，不能宣称IPC性能回归已排除或性能提升。
- 保留三次原始结果：`/tmp/oc-chan-s01-before-20261105`、`-after-`、`-final-`。为避免用8个区间的最大值代替稳定P95，临时复制runner，只将smoke daily预热2秒→30秒、采样8秒→60秒；负载、采样器、指标、预算未改。扩展结果`/tmp/oc-chan-s01-confidence-20261105/result.json` complete=true，1920/1920事件提交、60个有效CPU区间；CPU P95/P99 34.75%/68.75%、提交P95/P99 300.5/307.25ms、RSS采样峰值1204.4375MiB、输入提交P95 155.5ms、启动可交互1745.88ms，均在冻结预算内。62次资源采样仍有短命子进程覆盖限制，不当成绝对峰值或OOM全验收。核对source.files：与首轮后产物的产品/测量源码完全一致，仅多临时runner；已删除此runner，未修改正式run.mjs，未重跑P-01长测，不将不同预热时长的数据称为性能提升。
- 未全仓测试、提交、推送、替换安装或发布；这是真实headless IPC验收，不代表物理窗口、Dock、Tern聚焦或VoiceOver验收。

## S-02 完成证据 · 2026-11-05

- `src/main/settings.ts`：64KiB预算，O_NOFOLLOW/O_NONBLOCK，同一描述符stat→分块read→stat；预算内按初始大小+1分配，拒绝非普通文件、增长/改写、无效UTF-8/JSON/字段。缺失仍用默认；失败不覆盖原文件。0600、wx、sync、原子rename保留，关闭/清理/回滚错误按真实阶段聚合。
- 新增`src/shared/diagnostics.ts`与定向测试；移除describeError递归和裸错误日志。白名单字段，不读取message/stack/stderr/path或自定义toString；8层/16条/16KiB，循环/重复、访问器/撤销Proxy、超限标记。主进程启动/退出、设置IPC、renderer连接失败接入；本地恢复保留完整路径，复制区只显示摘要。SettingsFailureReason增加timeout，SettingsSaveError双语说明同步。
- 失败前脚本确认oversizedAccepted=true、symlinkAccepted=true、循环RangeError、原始错误正文暴露；仅合成fixture，不表示发生过真实用户数据泄露。`npm run typecheck`通过；`npm run test:ci -- src/main/settings.ts src/shared/diagnostics.ts src/main/ipc-boundary.test.ts scripts/ci-tests.mjs`33/33通过。新增shared测试已接入npm test及CI映射；旧文案断言删除。
- 真实Electron `instance-xojAVO`：EISDIR复制摘要261字节、EACCES186字节，无私人路径；实际设置回滚、排除目录/权限故障后重试保存、0600及焦点返回均验证。中英/深浅色，内容区1280×860及880×640、实际webContents zoom=2；后者CSS440×320，root scrollWidth440、错误区client/scrollWidth391，无全页溢出。元素跨视口截图会裁切，最终改用滚动后视口截图核对文字和可滚动诊断。
- 最后将本实例配置写为9字节合成损坏JSON并触发正常HMR重启；应用日志只有OC_SETTINGS_INVALID/settings-decode/SyntaxError，无敏感标记，按预期exit1。`oc-s02-recovery-before failed exit1`通知属于此故障注入，不是新回归；开发启动器已清理整个本任务profile。已释放browser和Node Inspector。原始日志、UI结果在`/tmp/oc-chan-s02-smoke-20261105/startup-log.json`及`result.json`。
- `/tmp/oc-chan-s02-smoke-20261105/pressure.json`：32并发、2560次实际读取（64KiB合法、1MiB超限、链接/目录/FIFO），另1万次循环大错误格式化；耗时179.62ms、峰值78.625MiB、FD15→15、输入SHA256不变、摘要最大264字节。仅Node边界压力，不代表常驻Electron或全部资源验收。临时fixture和执行脚本已清理。
- 性能复用S-01-final作为前态，源码指纹对照仅本卡10个源/测试/配置文件变化，测量器/负载未变。Apple M4 Max/macOS27.2/Node24.22.1，L1固定seed20261104、128会话、256事件；前→后启动2038.21→1957.25ms、事件提交P95 335.5→334ms、整应用RSS采样峰值1123.58→1113.66MiB、CPU均值34.52→35.00%、8区间P95 71→71.5%。两轮256/256均提交。短测CPU波动及短命进程采样缺口保留，不宣称性能提升或完整OOM通过。后态`/tmp/oc-chan-s02-after-20261105/result.json` complete=true、无cleanup/evidence错误。
- 未全仓测试、提交、推送、替换安装、发布或原生可见窗口验收。

## S-05 本地完成证据 · 2026-11-05

- 新增`scripts/check-package.mjs`、`dependency-review.mjs`、`bundled-licenses.ts`及定向测试；新增`docs/package-baseline.json`与`dependency-review-policy.json`。检查实际ASAR/extraResources白名单、许可、插件逐字节一致性、架构/权限、资源引用、manifest/lock/运行依赖/bundle一致性与冻结预算。读取/遍历/摘要/子进程有数量、字节、深度和时限上限；超过预算给出最大新增/增长项，不改写基线或锁文件。
- package中5个渲染依赖移入devDependencies，生产只外置systeminformation；已有传递依赖`@electron/asar 3.4.1`显式声明dev，419个锁定模块version/resolved/integrity均未变。实际保留的19个渲染模块包生成完整许可文本与bundle清单。`afterPack`按目标架构和Info.plist最低系统编译helper；不复制开发目录的旧二进制。发布配置`publish:null`移除未使用的app-update.yml，Electron/Chromium许可资源仍强制保留。
- 接续此前仅落盘的四项用户决定，已合入主清单、README、本交接和CI：本期arm64本地自用；D-01/O-01延期；D-02先本地材料；D-03仅arm64；F-07只调研。保留37卡。CI从双架构收敛为arm64，并接入审查、包门禁与报告上传；旧Q-01双架构记录是历史状态。
- `npm run build:app`通过typecheck及Vite生产构建。`node --import tsx --test scripts/check-package.test.mjs scripts/dependency-review.test.mjs scripts/ci-tests.test.mjs scripts/install-local.test.mjs`70/70通过；最后补齐Electron许可必需项后仅重跑`node --test scripts/check-package.test.mjs`，38/38通过。已通过而未受影响的审查/CI/安装测试未重复；未跑全仓套件。
- 真实npm查询首次报告合法循环`Cyclic npm audit propagation: app-builder-lib`，已改为有界迭代、去重和完整来源追溯；保留无来源循环与超密图拒绝测试。最终`node scripts/dependency-review.mjs --output /tmp/oc-chan-s05-final-20261105/dependency-review.json`通过：419个许可证节点、15个受影响构建依赖节点，均传播自GHSA-g3hv-75wg-m249。报告保留npm范围与GitHub原公告差异、可达性理由；未升级/降级依赖，不能称无漏洞。锁SHA为`da54ebe250176e9103c62a4a14056472822fd0b662dbf2d17fe23a7ab0d819dc`。
- 最终`npm exec --no -- electron-builder --mac dmg zip --arm64 --publish never --config.directories.output=/tmp/oc-chan-s05-final-20261105`通过；`check-package`实际测量并执行冻结预算均通过。app 271907543、ASAR 2249003、helper 87136、systeminformation 711049、DMG 120901787、ZIP 117414516字节；308个逐文件/归档项。ASAR前态36484874字节，减少34235871字节（93.84%），不是运行性能提升声明。预算分别为app300MiB、ASAR3MiB、helper128KiB、systeminformation768KiB、DMG130MiB、ZIP125MiB。
- 最终目录中的package-manifest-arm64.json含文件清单/摘要，runtime-smoke.json含实际运行证据；docs/package-baseline.json保存冻结清单及前态来源。DMG SHA256 `e2598358735aceff6c3fa6d01ff9bc2bb0305a8a67f32ebf467b6e3e4c8c79b6`，ZIP SHA256 `cb510a771e232fbdddc7b84b6ce46bcbe2aaf41bff57326f57cf15ec7a7584ff`。Node构建工具实际v24.22.1；Eval的Bun模拟Node版本不能作为构建版本。
- 实际包内Electron45.2.1以RUN_AS_NODE读取ASAR内systeminformation5.33.19，取得真实内存/CPU并验证范围；实际Swift helper非法参数退出1，无Tern激活。普通headless开发实例`instance-rcQXfm`真实显示拓扑节点和Lucide图标，agents/schedules/system均有数据、分区error=null，页面无全局横向溢出、Renderer错误为空。读取preload桥接用CDP主世界；工具默认evaluate隔离世界中的undefined不是产品故障。browser接管已释放，service退出143，启动器确认目录清理；仅保留原有他人实例instance-vbt4w7。
- YAML语法、固定SHA/权限、arm64范围、build→audit→package gate→upload顺序与受影响测试选择通过；37卡索引/正文及范围断言通过。无云端执行回执、完整打包应用首启、安装替换或原生窗口验收；这些留给相应后续卡。旧范围下生成的x64临时产物不作为支持证据，其Swift工具链缺x86_64 compatibility库警告保留，不纳入最终arm64目录。未提交、推送、安装或发布。

## R-01 完成证据 · 2026-11-05

- `src/main/resource-budget.ts` 建立全局额度：命令/文件/socket各8路；命令双流合计32MiB、文件16MiB、socket512KiB；总队列256、每来源128、来源32、等待10秒。按来源轮转，较大请求保留轮次；嵌套申请拒绝，取消移除排队项；当前/峰值/拒绝及排队、执行耗时分别统计。
- 命令在获准后开始原有执行计时，真实子进程和双流关闭后释放；文件非阻塞打开且拒绝非普通文件，socket按UTF-8字节而非字符计费。活动读取、元数据、调度、系统、历史使用同一资源池，保留现有单飞/dirty/一active一pending语义。数据来源显示资源诊断。系统采集改用内置API及有界macOS命令，删除systeminformation运行依赖；包门禁随之收敛为无外置运行依赖。
- 同机同seed标准L1：`/tmp/oc-chan-r01-before-20261105` → `/tmp/oc-chan-r01-final-20261105`；启动可交互1800.46→1856.98ms、事件提交P95 298→301ms、RSS采样最大1176.67→1166.89MiB、CPU P95 36.75→65.25%。均256/256提交，0 read issues。首轮after的启动2394.84ms来自plist沿用每流8MiB预留；单独校准plutil每流4MiB后启动恢复，launchctl仍每流8MiB、总预算不变。短测只有8个CPU区间，65.25%高于冻结60%回归线；已按此前30秒预热/60秒采样方式补充分布证据，保留短测结果和原预算。
- `/tmp/oc-chan-r01-stress-20261105/result.json` complete=true，无cleanup/evidence错误，源码摘要与final一致（`e99483c2eb74d7c0d2aa167b003997ecd21f0f73c7a69848dddc15e0e1471bd3`）。128会话突发、100次refresh、200历史替换、4096/4097配置、拓扑128/500/2000、超长记录、锁库和约3006ms查询超时恢复均执行。资源峰值命令6、文件8、输出32MiB、文件2097154字节、队列116；最大排队36.43ms，结束各项归零。socket不在此合成负载内，单独真实Unix socket边界/取消测试覆盖。
- 压力突发只有1742/2560个事件进入读取/发布/IPC/提交，2个read issues，保留为后续P-02正确性风险；不能将runner完整执行称为突发事件无损通过。突发CPU P95 179.5%，整场景采样最大RSS1356.80MiB；短命进程和1秒采样仍有覆盖缺口，不冒称绝对峰值或长期OOM验收。
- 扩展L1 `/tmp/oc-chan-r01-confidence-20261105/result.json` complete=true，无cleanup/evidence错误；1920/1920事件全部提交、0 read issues，CPU P95/P99 35%/67.75%（60区间）、事件提交P95/P99 295.5/302.5ms、RSS采样最大1073.55MiB、输入提交P95 157.75ms、启动1894.55ms，均在冻结现状预算内。source-comparison.json确认产品及正式测量源码未变，仅新增延长时长的临时runner；该runner已删除。不将不同预热时长的结果称为性能提升。
- 最终可定位定向回执：`node --import tsx --test --test-concurrency=2` 指定resource-budget/resource-io/network/agents/schedules/hermes-runtime/hermes-history/system/live-agents/monitor/schedule-history/check-package/ci-tests，共166/166通过（本会话artifact 283）。包含真实Unix socket UTF-8分块、64KiB边界、8路连接取消、队列取消不连接；真实子进程溢出/超时/终止后槽位归零。未运行全仓套件。
- `npm run package -- --config.directories.output=/tmp/oc-chan-r01-package-20261105` 通过类型检查、生产构建及arm64目录打包；`check-package`实际ASAR/资源/许可/架构及冻结预算通过。app271213544、ASAR1555004、helper87136字节，无外置运行依赖；报告为该目录package-manifest-arm64.json。未重做DMG/ZIP、替换安装或宣称已安装版本通过。
- 真实headless实例instance-qjQsk0：三个分区error=null，资源来源展示真实额度/峰值/排队/双流预留并携带15个来源统计。1280×860中文和880×640英文无全页横向溢出、Renderer错误为空；证据`/tmp/oc-chan-r01-source-ui-20261105.json`，截图`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15c1426907f231c0.png`。npm包装器未输出就绪回执，停止后按现有约定直接用node scripts/develop.mjs --inspect；启动器正常退出143并明确已清理本实例，目录仅剩非本任务instance-vbt4w7。未进行原生窗口、常驻或全应用OOM验收；未提交、推送、安装或发布。

## R-02 完成证据 · 2026-11-05

- 新增 `src/main/collection-limits.ts`：有界opendir，全部调度目录合计4096条并包含过滤项；固定来源、任务/缓存/单字段/日历上限。`schedules.ts`跨配置、三个运行域、OMP/Hermes/cron合计4096任务和8MiB投影，失败不替换Monitor旧快照。缓存4096项/8MiB、单投影64KiB，按dev/ino/size/mtime/ctime失效，删除/销毁回收；diagnostics及来源行显示额度。
- `resource-budget.ts`、`resource-io.ts`、`launchd.ts`：plist文件上限1MiB，O_NONBLOCK普通文件分块读、前后身份验证，受限Buffer送真实plutil stdin；命令/文件槽及字节原子预留，跨kind按先后保留所需容量，取消/超时解除优先权。预留持续至输入fd和命令双流实际关闭。队列中修改options不能更换文件、身份或额度。
- `agents.ts`：私有host registry4096条含过滤项、32host读取、4KiB记录与字段，ownership/host/pane/活动对象有数量边界；不连接不安全、超限或身份不符的记录。`system.ts`将CPU/history绑定实例，首次/不连续采样为null；CPU/RSS各10项、history60项。Monitor停止时dispose调度/系统实例；完整异步排空属于R-03。共享types、概览/系统/托盘/图表与smoke调用同步，无兼容导出。
- 定向检查共148项不同测试分轮通过：首轮resource-budget/resource-io/collection-limits为28/29，其他agents/schedules/system/network/monitor/live-agents/ci/performance-core为111/119；修复组合请求抢占更早file队首、host文件名被同名局部变量遮蔽、缓存字节夹具被任务字节额度提前挡住后，resource-budget14/14及失败的8项全部通过。其余已通过检查未重跑。最终`npm run typecheck`通过；修正测试StatsFs.frsize/数值类型。删除新增的CPU SVG坐标快照测试，用真实应用检查未知值与断点，不保留实现坐标断言。CI映射纳入新资源测试与目录模块，未运行全仓套件。
- L1同机同seed比较：`/tmp/oc-chan-r01-final-20261105` → `/tmp/oc-chan-r02-after-20261105`，M4 Max/macOS27.2/Node24.22.1、32事件会话/1000plist、2秒预热+8秒采样。启动交互1856.98→2241.99ms、事件提交P95 301→332ms、RSS采样最大1166.891→1127.875MiB、CPU P95 65.25→48.75%。均256/256提交、0 read issues；后态complete且无cleanup/evidence错误，摘要`c0245f967fc8e5815df18b201bf6fcc34de13c38117f6b4e363105c24957c15a`。短测仅8个CPU区间，不宣称稳定性能提升或250ms产品目标达成；启动增加包含有界输入读取/身份检查，仍低于2500ms现状线。
- 真实L2：`/tmp/oc-chan-r02-stress-final-20261105/result.json` complete、无cleanup/evidence错误。3996plist+100Hermes=4096成功；3997/4096plist因总任务4097/4196明确拒绝，4097plist因目录超限拒绝，旧jobs与collectedAt不变；恢复1000plist后1100任务成功。100刷新、200历史替换、128/500/2000拓扑、超长记录、锁库、约3006ms超时及恢复均执行。额度峰值命令6/文件8/输出32MiB/文件4718596B/排队119，最长等待47.20ms，结束各项归零。
- L2突发1759/2560事件提交，仍为P-02风险；突发0 read issues，后段超长输入阶段2个read issues。整个已统计阶段最大RSS1407.016MiB，突发CPU P95 189%；3996plist阶段4个资源采样均含已退出短命进程的未知RSS，完整总量百分位为null，不能填0或声称绝对峰值。原始进程树和10ms生命周期记录保留；24h、插件启停和全应用OOM验收仍属R-04。
- 首次L2 `/tmp/oc-chan-r02-stress-20261105` 因旧fixture仅接受1000/4096/4097而明确失败，未掩盖。扩充fixture到3996/3997以包含100个Hermes任务；最终stress摘要`4cd93e43312a35736ad7de973a13a57ba736cdae16bb24d63f52ce9b06bb59ca`。`/tmp/oc-chan-r02-source-comparison-20261105.json`确认daily→stress仅fixture白名单变化，产品源码不变；未因测量入口调整重跑已通过的daily。
- 真实普通headless实例`instance-XmKFdO`：三个分区error=null，扫描928条、缓存928项/355037字节；任务随实际运行域变化，观测1056–1065。中文1280×860、英文880×640来源行完整；Electron zoom2下CSS440×320、root scrollWidth440。仅该实例内存注入CPU null/历史间断，经实际IPC验证概览/系统/托盘显示未知、曲线分段，随后恢复send方法；Renderer错误为空。证据`/tmp/oc-chan-r02-surface-20261105.json`及其中三张截图；browser/Inspector已释放，本实例正常停止清理，保留非本任务`instance-vbt4w7`。
- README同步边界。未全仓测试、打包安装验收、提交、推送、安装替换或发布；headless图表/布局结果不当成原生窗口、动画或VoiceOver验收。

## R-03 阶段证据 · 2026-11-05

- Monitor、LiveAgents、ScheduleHistoryReader及采集命令/文件/socket共享AbortSignal；停止关闭入口、撤销队列、等待实际关闭，重复调用共用排空Promise。Monitor拒绝晚到发布，清理失败保留资源身份；历史支持可等待idle/close。本实例辅助子进程才会被终止，观察对象不受影响。
- 新增`src/main/shutdown.ts`和行为测试，index退出最多等待5秒；完成才记`Shutdown drained`，失败/超时以1退出并输出脱敏诊断及monitor/history/资源剩余数。性能探针和夹具同步等待stop，避免旧脚本以同步调用冒充释放。
- 真实锁库暴露SQLite设置顺序问题：原先cache_size早于busy_timeout，持独占锁时立即失败。将busy_timeout放到其它PRAGMA之前，history和runtime查询一致。最终`node --import tsx --test --test-concurrency=2 src/main/collectors/hermes-history.test.ts src/main/collectors/hermes-runtime.test.ts`28/28通过；此前最终`npm run typecheck`通过。其它已执行定向测试未在此次恢复片段中保留完整回执，不重造测试数量。
- `/tmp/oc-chan-r03-lifecycle-result.json`：实际headless Electron内100轮monitor/历史启停，每轮在文件读取、命令和SQLite辅助工作已开始后取消；200个子进程全部close，结束命令/文件/socket/字节/队列归零。取消到释放p50/p95/max为3.85/4.31/5.90ms；整个循环12159ms，每轮在两个helper活跃时取全应用进程树RSS，100个采样最大935.203125MiB、最多7进程。采样下界，不是绝对峰值或常驻验收。
- `/tmp/oc-chan-r03-native-exit-1793820510289/normal.json`：应用真实quit在两个辅助读取进行时触发，等待两个子进程close，约6.86ms后exit0；monitor定时器/watchers/在途项和全局额度均归零。`timeout.json`故意放入永不结束的采集，约5003.40ms后exit1，明确记录`OC_SHUTDOWN_TIMEOUT`、monitor/system与1个file/1字节残留，不能称该场景资源已排空。
- 两次quit后独立锁库控制进程仍存活，随后正常stop返回0并删除本任务锁库目录。instance-nATM6S、instance-BP76Gk、instance-MA0aW3等本任务实例由启动器清理；浏览器/Inspector已释放。`oc-r03-timeout-quit failed exit1`是已设计的超时注入回执，不是未经解释的新故障。
- 前态复用`/tmp/oc-chan-r02-after-20261105/result.json`，后态`/tmp/oc-chan-r03-after-20261105/result.json`：M4 Max/macOS27.2/Node24.22.1，同seed20261104、标准L1；前→后启动交互2241.99→1692.50ms、提交p95 332→321ms、RSS采样最大1127.875→1127.328MiB、CPU p95 48.75→71.25%。两轮均256/256提交、无read issues；后态8个有效CPU区间的p95超出60%回归线，原始结果保留，不称性能提升。
- 扩展分布`/tmp/oc-chan-r03-confidence-20261105/result.json`：30秒预热/60秒采样，1920/1920事件全部提交、0 read issues，CPU p95/p99 44.5%/55.25%（60区间）、提交p95/p99 299.75/303.5ms、RSS采样最大1213.171875MiB、输入提交p95 148.5ms、启动2036.03ms，均在冻结现状预算内。source-comparison.json确认只多临时测量副本，产品及正式测量代码未变；临时副本与本任务smoke脚本已清理。62个资源采样仍有短命进程覆盖缺口，不能作为绝对峰值、250ms产品目标或24h/OOM通过证据。
- 第一项验收明确包含通知排队；当前产品尚无通知队列，保留该项与整卡未完成，F-06接入后回验。现有采集/历史/退出实现可作为后续插件生命周期基础；不把该局部交付冒充整卡完成。
- README与任务卡同步。未全仓测试、提交、推送、安装替换、发布或原生可见窗口验收。

## F-03 完成证据 · 2026-11-05

- 新增 `src/shared/source-capabilities.ts`、`SourcePanels.tsx`、`sources.css` 与详情来源说明样式；按来源声明七类能力及中英文原因。各状态独立，正常有限覆盖、停用和未支持无修复按钮。概览与 Agent/任务详情可定位来源；来源标题滚到可见区域起点，避免200%缩放时居中定位把标题滚出视口。
- `Monitor`、共享类型、preload/main和来源页接入最近尝试/成功与轻量采样心跳；不变数据不重复发列表。launchd逐域重试，其它实际故障来源明确重试所属分区；请求合并、停止后拒绝、其它来源时间和整体失败保持。空配置/空cron用empty，空ownership与未支持状态分开。来源页离开、暂停和隐藏解除订阅，恢复读当前时间；全局隐藏推送仍属P-03。
- 断点恢复前已通过`npm run typecheck`及指定monitor/shutdown/live-agents/agents/schedules/navigation/view-state/ci-tests的125项定向检查。此后仅改来源响应式CSS和定位scrollIntoView对齐方式，以真实渲染验证；未重跑已通过套件、未跑全仓测试。README、DESIGN及CI路径映射同步。
- `/tmp/oc-chan-f03-smoke-20261105.json`：真实headless Electron，1071条任务/服务；仅本实例内存注入system域EACCES，保留1071条且443条system任务状态未知，显示permission-denied、尝试/成功时间。10次Enter+100次IPC请求合计101个后端调用，只有`print system`/`print-disabled system`两条实际命令、1个在途重试，无整分区采集；恢复后其它13个来源及完整分区成功时间不变，焦点仍在“已重新检查”。
- 20次不变自动采集：0份数据更新，观察到22条时间心跳（含订阅/初始边界），最大1680字节；暂停时间保持，恢复取最新时间。系统来源故障的分区重试只调用system，agents/schedules状态引用不变；整分区合成失败保留旧数据，按钮恢复后错误清除。正常/部分可见/停用/未支持/空结果各有独立徽标，均无虚假重试按钮；来源能力声明与当前连接状态分离。
- 真实Tern主代理和launchd任务详情分别定位tern-state与launchctl:system；隔离夹具中驻留OMP子代理和仅进程证据CLI通过键盘定位omp-ownership和processes，不将其改为working。中文浅色、英文深色、880×640/1280×860、959/960/961断点及1728宽度、长标识/路径无全页溢出。200% Electron缩放实际CSS440×320；另行200%字体实际26px/来源24px，发现能力标签重叠后改为字号相关容器断点，复验单列且无重叠。连续尺寸变化保留来源焦点；Renderer错误为空。物理分屏/全屏、原生焦点、VoiceOver与可见动画未验证。
- 普通实例由`npm run dev -- --inspect`启动，外层临时Node脚本仅透传stdio和进程组信号，规避npm包装器无就绪输出的问题。browser/Inspector已释放，service退出143并明确`Shutdown drained`、已清理instance-07t39N；只剩非本任务instance-vbt4w7，未停止它。临时启动脚本已删除。
- 标准L1前态`/tmp/oc-chan-r03-after-20261105`→后态`/tmp/oc-chan-f03-after-20261105`，同M4 Max/macOS27.2/Node24.22.1、seed20261104、2秒预热/8秒采样：启动1692.50→2148.27ms、提交p95 321→343.5ms、RSS采样最大1127.328→1132.266MiB、CPU p95 71.25→61.75%。两轮均256/256提交、0 read issues；后态complete且无cleanup/evidence错误，源码摘要687735ab62207beb67b343651d1ee32bf91fcff9a79fe9f78997cd91e31f743d。CPU8个区间仍高于60%线，已保留原始结果并补下列分布证据；未调预算，不称性能提升或250ms产品目标通过。`/tmp/oc-chan-f03-source-comparison-20261105.json`确认前后测量代码与负载未改。
- 扩展`/tmp/oc-chan-f03-confidence-20261105/result.json` complete且无cleanup/evidence错误：30秒预热/60秒采样，1920/1920提交、0 read issues，CPU P95/P99 34.75/64.75%（60区间）、提交P95/P99 300.25/301.5ms、RSS采样最大1184.8125MiB、输入提交P95 158.75ms、启动2304.15ms，均在冻结现状预算内。同目录source-comparison.json确认仅多临时测量副本，产品与正式测量代码未变；副本已删除。62个资源采样仍有短命进程覆盖缺口，不冒称绝对峰值、常驻或OOM通过。
- 未提交、推送、替换安装或发布。本卡完成，继续P-02。

## P-02 完成证据 · 2026-11-05

- 新增回归先在旧实现失败：128个同批读取实际发布128次。`LiveAgents`现有90ms读取窗口保留，新增16ms首完成固定发布窗口；缓存会话索引和Agent投影，未变对象跨读取与等价发现保持引用，退出/移除取消未发布批次。新增批次、固定截止和取消三个行为回归。
- 已实际通过：`node --import tsx --test --test-concurrency=2 src/main/live-agents.test.ts src/main/collectors/agents.test.ts src/main/monitor.test.ts src/main/shutdown.test.ts src/main/tern-navigation.test.ts` 81/81；类型检查通过。测量统计新增独立发布/发送计数及V8载荷字节，工具回归7/7。未跑全仓套件。
- 相同seed与短测配置，前态`/tmp/oc-chan-p02-before-{daily,stress}-20261105`，首个后态`/tmp/oc-chan-p02-after-{daily,stress}-20261105`均complete、无cleanup/evidence错误。L1：事件256/256、读取45856字节均相同；发布256→8次、每窗口载荷3451392→108224字节、提交P95 312→274.75ms、RSS采样最大1189.906→1087.594MiB、CPU P95 39→77.25%（仅8区间）。未达到250ms或CPU预算，不能称本卡完成。
- L2两秒突发：1816/2560→2321/2560事件提交、1816→29次发布、每窗口92276630→1478076载荷字节、提交P95 196.75→139.5ms。后态14条读取issue，保留异常，不当作无损通过。
- 已确认夹具根因：`writeEvents`在真实append后再次utimes，复现同inode/大小、mtime变化触发reader保守重读并报告“文件被截断或替换”。长测L2的22条issue全部为此类别；末次5个无活动对象与末5条issue身份完全一致。失败结果`/tmp/oc-chan-p02-confidence-stress-20261105`保持incomplete、无cleanup/evidence错误；没有用旧状态或兜底隐藏异常。仅删除夹具追加后的utimes，保留产品reader对真实同尺寸改写的拒绝语义，最终复测0 issue。
- 定时任务视图原来未使用已有AgentsView的memo模式，Agent采样会重渲染1100行任务；已按现有模式复用SchedulesView。`/tmp/oc-chan-p02-confidence-daily-20261105`已complete：30秒预热/60秒采样，1920/1920提交、0 issue、60次Agent发布、每窗口813360载荷字节、P95/P99为120.75/186ms、CPU P95/P99 19.25/59.5%、RSS采样最大1076.296875MiB，类型检查通过，无cleanup/evidence错误。此轮夹具仍含utimes，最终夹具变化须单列来源，不能伪造为同一次运行。
- 最终源码摘要`15210d67c6492f4b5de0278030b33ddb2e28d0c9bdd04c1e851865e466fac021`。`/tmp/oc-chan-p02-final-confidence-daily-20261105`：60秒1920/1920提交，60次Agent发布、每窗813360载荷字节、P95/P99 121/184ms、CPU P95/P99 20/53.25%、RSS采样最大1064.65625MiB。`/tmp/oc-chan-p02-final-stress-20261105`：10秒12800输入/10314提交、116次发布、128个末次状态全保留，交错stop/aborted/error在121.85ms内全清除，0 issue；均complete且无cleanup/evidence错误。中间状态合并不等于逐条交付。真实Electron筛选/详情/语言/跨分区刷新与英文批次说明通过，实例`instance-SCLJIL`已清理；临时runner、mtime复现和UI启动脚本已删除，计量工具最终7/7通过。详见performance-baseline.md末节。13/37完成，未提交/推送/安装/发布，继续P-03。

## P-03 完成证据 · 2026-11-05

- 前态`/tmp/oc-chan-p03-before-idle-20261105` complete且无cleanup/evidence错误；两窗都隐藏的2秒区间仍向每窗发送1次Agent和1次系统快照。仅托盘隐藏也仍收到数据。P-02已完成，不重跑其长测。
- 新增`monitor-subscriptions.ts`，最多登记2个自有窗口，按数据/来源心跳兴趣和原生可见性分发；导航换文档、渲染进程退出清除兴趣，销毁/退出释放监听。preload首订阅/末解绑才发送两个布尔值，经现有IPC来源/参数守卫。主窗隐藏取消订阅并冻结活动到期计时；保留先订阅再快照及分区新事件优先，托盘沿用已有可见性解绑。SystemMetrics没有独立计时器，父层停止更新即可；共享公开MonitorApi不新增通用控制接口。
- 新增5个订阅生命周期行为回归，补新IPC参数边界和CI映射。初次类型检查因Electron事件重载不接收联合事件名失败，改为4个明确事件注册/释放，未放宽类型。最终类型检查与`node --import tsx --test --test-concurrency=2 src/main/ipc-boundary.test.ts src/main/monitor-subscriptions.test.ts src/renderer/src/view-state.test.ts src/main/monitor.test.ts src/main/shutdown.test.ts scripts/ci-tests.test.mjs`共43/43通过。
- 后态L0`/tmp/oc-chan-p03-after-idle-20261105`，摘要`b3d893c02636805b412bfeea28af7be8bbb7fcf579250e7bb78e7e322fbbc026`，complete、无cleanup/evidence错误：隐藏窗口0发送，后台每段仍发布2次；首快照550.63ms/可交互1978.26ms，三段RSS采样最大786.890625MiB，短CPU样本不声称性能改善。详见performance-baseline.md末节。
- `/tmp/oc-chan-p03-ui-evidence-20261105.json`保留14项有效场景和2次已更正的脚本前提。两窗各100次隐藏/恢复，最多2登记、隐藏兴趣0，查询/选择/画布变换保持；稳定隐藏7秒与受控活动过期均0 IPC/0全部React提交，无运行动画。暂停与可见性独立，慢旧快照不覆盖新错误和旧数据说明，隐藏3次更新恢复只取最新；真实reload先清登记，托盘destroy释放登记和监听。两窗始终不可见/不可聚焦，snapshot可读。实例`instance-qvwqRD`与临时启动/config文件已清理，错误列表为空。本卡完成，继续P-05；未提交/推送/安装/发布。

## P-05 完成证据 · 2026-11-05

- 启动预建已移除；新增`src/main/tray-window.ts`，保留一个面板、一个共享加载Promise和最新显示意图。就绪与loadURL都成功才展示，10秒加载上限；失败销毁半初始化窗口，下一次点击重试，渲染进程退出也释放并报告。退出取消并等待创建完成；原生托盘图标在IPC处理器就绪后创建。`TrayView.tsx`未改，保留原多指标、组合选择及独立展开行为。
- 仅开发性能配置的Vite变换注入`__ocPerformanceTray.open()`，正式源码/IPC不增加控制入口。测量工具改为先测单主窗启动，再显式创建隐藏托盘并验证CPU展开，记录首次交互耗时；原L0/L1/L2场景显式创建托盘后继续既有负载。
- `npm run typecheck`与托盘生命周期、窗口订阅、IPC、退出、脱敏诊断、测量工具和CI选择共42项定向回归通过。新增7个生命周期行为回归并登记CI；没有全仓测试。
- 前态10次独立冷进程/新配置启动：`/tmp/oc-chan-p05-before-startup-20261105` complete，无cleanup/evidence错误，摘要仍为P-03的`b3d893...026`。RSS/CPU冷启动采样稀疏（部分轮次无有效CPU区间），不可仅据此声称内存或CPU改善。
- 真实加载失败暴露原生销毁错误：`closed`回调再次访问`panel.webContents`触发`Object has been destroyed`，Electron错误弹框阻塞主进程。`/tmp/oc-chan-p05-main-stall.sample.txt`与后续捕获的原始栈确认根因。测试夹具补上“销毁后getter抛错”，该回归先失败；实现改为提前保存contents引用后，类型检查与托盘/订阅12项定向回归通过。原42项其余结果仍适用。
- `/tmp/oc-chan-p05-ui-evidence-20261105.json`记录10项有效验收、1次已更正脚本断言及真实缺陷的修复前证据。原生缺失页面的10个并发请求共享加载、报告一次ERR_FILE_NOT_FOUND，实际destroyed事件后无自有监听/订阅残留，10次重试仅一窗口；四指标、CPU/内存同时展开、组合选择及1131px滚动保持。真实在途加载1ms取消，主窗继续采集；实例MzdC1n/YDKkCF/ZDxEiQ均已清理。可见性为无头模拟，未验原生托盘点击。
- 初版后态10轮`/tmp/oc-chan-p05-after-startup-20261105` complete、无cleanup/evidence错误，摘要`9cf526003046c82529151aae0cabf323d04e48a53bc5911bd1d3dd2c89a69393`：首快照P50/P95 450/599ms、可交互1296/2173ms，首次托盘交互P50/P95 204/233ms。该测量早于上述销毁修复，正常创建路径结果保留。
- 最终源码摘要`2a2fa6847dcb4438b16ae5dad1c0807669b46d3d35d4cc59036865c49e3fe31d`，L0 smoke`/tmp/oc-chan-p05-final-idle-20261105` complete，无cleanup/evidence错误；首快照479ms、可交互1372ms，三段RSS采样最大814MiB、CPU单段有效区间均值最高3.344%，在L0预算内。README/性能记录/卡片已同步；P-05完成，未提交/推送/替换安装/发布。

## U-06 完成证据 · 2026-11-05

- `AgentTopology.tsx`、`agent-topology.ts/css/test`、`view-state.ts/test`：移除固定260×182几何，卡片宽度随字号、高度来自真实内容；Dagre、边端点、显露共用测量。位置与尺寸缓存分离，普通采样/容器尺寸变化保留手动坐标与视口；语言/字体重测屏外节点。测量缺失或非有限尺寸明确拒绝，不编造边界。README和DESIGN同步。
- 真实前态200%文字标题26px但行高19px，标题盒38px、内容63px，节点仍260×182。后态宽520、高300/314/338/352，标题行高38px；三条边端点与卡片边界一致。原始前后及16项最终UI检查在`/tmp/oc-chan-u06-ui-evidence-20261105.json`，最终截图`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15c170be36a0609c.png`。
- 真实large/small/default设置切换触发ResizeObserver通知回路；改为每节点一条待测量、下一帧提交，拖动位置仍即时更新，隐藏取消帧/恢复最新尺寸，卸载清空。前后错误证据为`/tmp/oc-chan-u06-resize-loop-{before,after}-20261105.json`；最终字号/语言/状态/隐藏恢复均0该错误。显式适应全部复用几何就绪请求，选择显露也等实际测量；最初的fit截图未等待稳定，不能称旧版持续失败已被独立证实。
- 880×640/1280×860、八次宽度变更及959/960/961断点保留所有节点与视口；200%文字与Electron zoom2（CSS440×320）独立通过。中英/深浅色长内容、键盘Enter定位与详情焦点、搜索无匹配、真实空快照、错误+旧快照、隐藏尺寸队列及恢复通过。既有合成指针拖动、普通指标刷新和离页返回证据仍适用；原生Split View/可见连续拖动/VoiceOver另排。
- 类型检查最终通过；`node --import tsx --test src/renderer/src/agent-topology.test.ts src/renderer/src/view-state.test.ts`20/20通过，后续fit仅改tsx并再次类型检查和真实UI，不重复未受影响测试。HMR保留旧内存形状、fixture漏sources、过早检查未测量DOM、隔离世界看不到主世界隐藏覆盖、长Eval超时均记录为验收脚本修正；最终文档无页面异常。
- 同机同seed stress前后complete且无cleanup/evidence错误，测量器/夹具未变。最终源码摘要`2446f2f784348b1be1fd9ba8b80d0e7eb33965d0ab7628a88d8191f68ef80362`；2000节点交互往返607.80→474.31ms、RSS采样最大1255.25→1307.83MiB，每规模仅一次交互；不声称稳定性能提升。启动1428.72→2421.13ms，主要差值为未修改的首次调度快照；首次拓扑交互88.54→118.90ms。完整数据、初次测量内存成本与采样限制见performance-baseline末节。
- `npm run dev -- --inspect`独立profile，始终原生不可见/不可聚焦。已释放browser/Inspector、停止`oc-u06-ui`，日志`Shutdown drained`；实例1IwNrc已删除，仅保留非本任务instance-vbt4w7。临时UI启动器/config/验收助手清理，原始证据保留。未全仓测试、提交、推送、安装替换或发布。

## U-03 完成证据 · 2026-11-05

- 新增`window-geometry.ts/test`；共享设置增加严格整数侧栏宽度与有界正常窗口矩形，嵌套对象隔离、等值写入短路。主进程按屏幕工作区恢复；250ms合并、一个在途加一个最新待写值、退出排空、屏幕变化重新定位。Renderer不能伪造窗口矩形，仅能重试当前几何；仅几何变化不重新应用Dock/防休眠或原生菜单。
- 侧栏拖动结束/键盘稳定后保存，取消不写，默认值可持久化；保存中继续调整合并为一个最新patch。`SettingsSaveError`复用为全页几何错误，侧栏失败回到实际已保存值，窗口失败保持物理位置并明确未保存；重试与受控诊断可用。README、DESIGN及CI映射更新。
- 最初类型检查发现Electron没有will-enter/leave-full-screen事件，已改为官方enter/leave完成事件并依赖getNormalBounds契约；最终类型检查通过。初跑40项为39通过/1项CI旧选择预期失败，调整设置输入边界对应IPC覆盖后，受影响几何/CI14项通过；其余26项仍适用，最终40项全部有通过证据，未跑全仓。
- `/tmp/oc-chan-u03-ui-evidence-20261105.json`：真实进程63516→68956重启，同profile恢复侧栏320及位置500,130/1120×760；两个独立profile188/320互不覆盖。真实EACCES下窗口保留原文件、侧栏回滚，界面重试恢复；诊断只含受控错误。可信指针Esc取消无文件变化，双击214重载恢复；CSS800临时约束240，保存值320不变。中文深色、英文浅色、200%文字与200%Electron缩放独立检查，错误诊断和键盘重试可达，最终页面无异常。长element截图受滚动容器裁剪，不用它冒充完整内容可见证据。
- 长可信指针自动化批次超出browser运行期限，已释放闸门、恢复文件接口并reload；未当成通过。最终压力明确使用真实Renderer上的100次合成指针拖动与100次原生setBounds：首笔rename受控阻塞，最终仅2次写入、最大并发1、最终值一致。退出前立即调整420,170/1180×780，原子写入副本`/tmp/oc-chan-u03-quit-settings.json`确认最终值，日志Shutdown drained、service退出0。C4A0Ww/5VizaT均清理，仅保留其它任务instance-vbt4w7；临时启动器已删除。
- 同机同seed后态`/tmp/oc-chan-u03-after-stress-20261105` complete，无cleanup/evidence错误，摘要9468f7…7353；测量器/夹具未变。启动2421.13→1756.15ms、全场景阶段RSS采样最大1387.86→1377.98MiB、2000节点往返474.31→465.52ms。CPU早期采样相位不同，已记录逐区间证据，不声称稳定性能改善；两条读取issue均为既有边界注入。短测与合成操作不代替可见多屏/全屏、VoiceOver、24h或绝对峰值验收。
- U-03完成，当前17/37张卡完成；未提交、推送、安装替换或发布。下一卡U-04。

## U-04 完成证据 · 2026-11-05

- 新增shared/main的startup-recovery契约和状态管理、恢复视图及样式；读取仍使用原64KiB有界实现，UTF-8错误增加受控分类。恢复preload只公开snapshot/retry/quit，复用assertIpcSource；不公开monitor/desktopSettings，不接收路径参数。诊断详情复用SettingsSaveError的展示。重试单在途，关闭使迟到结果失效并等待读取排空；正常合法文件才继续原启动流程。README列出合法设置字段及手工修复步骤，DESIGN和CI映射同步。
- `npm run typecheck`最终通过；`node --import tsx --test src/main/startup-recovery.test.ts src/main/settings.test.ts src/main/ipc-boundary.test.ts src/shared/diagnostics.test.ts scripts/ci-tests.test.mjs`38/38通过，未跑全仓。
- 真实Electron现场发现窗口交接提前退出：101次重试只有一次读取，销毁恢复窗口触发Electron默认window-all-closed退出，监控启动0次。已显式维持macOS无窗口期间的驻留生命周期；复验相同101次请求为1次读取/1次监控启动，主窗口id2取代恢复id1，三个真实采集快照和修复后的en/260px偏好可见，恢复handler全部撤销。前态`/tmp/oc-chan-u04-transition-before.json`，汇总`/tmp/oc-chan-u04-ui-evidence-20261105.json`。
- 恢复期间JSON、枚举、未知字段、超限、UTF-8及真实EACCES原因准确，采集timers/watchers/pending均为0；额外路径、子帧及外来sender被拒绝。中英/深浅、长路径、内容区880×640、200%文字及200%Electron缩放分开检查；键盘操作保持焦点，诊断可达。真实交互分支用临时测试注入拦截BrowserWindow.show/showInactive/focus，所有窗口保持不可见；原生可见专项另排。
- 五个真实headless启动fixture均退出1、0窗口、内容/权限未变、Shutdown drained且独立目录清理，见`/tmp/oc-chan-u04-headless-evidence-20261105.json`。读取期间点击退出，close等待单在途读取、监控未启动、窗口/恢复handler归零，见`/tmp/oc-chan-u04-quit-evidence-20261105.json`；service退出0并清理。初版测试注入早于Electron初始化失败，随后定位到应用入口的electron导入并修正；其失败/未注入实例均已退出，不算产品通过证据。三个临时测试脚本已删除。
- 最终同机stress及一次针对启动/500节点波动的复测均complete；后态源码摘要相同2c1e07…d2e42，测量器/夹具未变。启动2110.35/1554.05ms、阶段RSS最大1382.30/1373.23MiB，2000节点472.88/505.29ms。未观察到稳定的启动偏高，不将短样本当成性能改善或长时资源通过，详见性能记录。
- 当前18/37完成；下一卡U-05。已核对Electron45官方文档：openAsHidden已删除，必须使用wasOpenedAtLogin与真实status；开发实例不得注册。尚未实施U-05，系统真实登录/签名可靠性和原生专项仍未验收。

## U-05 开发侧实现与待验边界 · 2026-11-05

- 新增`main/login-items.ts/test`及`renderer/LoginItemSetting.tsx`；共享snapshot携带实际系统状态，新增严格布尔参数、仅主窗可用的`settings:update-login-item`。系统拥有持久化，不添加JSON偏好或旧API兼容。主进程仅对已安装的packaged macOS应用使用`mainAppService`；开发/headless明确拒绝。原生读失败可见，启动时不能把失败当作手动启动；部分写入失败会还原，失败后仍报告实际状态和受控诊断。CI映射、README/PRODUCT/DESIGN已同步。
- `npm run typecheck`两次通过；`node --import tsx --test src/main/login-items.test.ts src/main/settings.test.ts src/main/ipc-boundary.test.ts src/shared/diagnostics.test.ts scripts/ci-tests.test.mjs`45/45通过，未跑全仓。最后的返回页面刷新补充通过真实UI复现/复验；无新增公共类型。
- `/tmp/oc-chan-u05-ui-evidence-20261105.json`：真实headless开启/关闭IPC均被拒绝、原生写入0次；注入系统接口的登录分支为0窗口/1夹具托盘/0防休眠，采集启动且原设置文件未变。托盘点击后真实Renderer可用。覆盖状态批准/取消、外部禁用、路径变化、读取失败、回滚成功/失败及重试，100次同步点击仅1次写入。全部真实登录项API访问为0，不当成系统注册证据。
- 发现待批准时HTML disabled使焦点落到BODY，改用aria-disabled阻止操作并保留switch焦点；取消请求焦点移到稳定检查按钮。发现离开设置时系统禁用后返回仍显示“已开启”，补页面挂载时读取，前后shown为已开启→已关闭、actual均not-registered。证据保留于同一JSON。
- 内容区880×640/1280×860，英文深色200%文字（26px）及中文浅色200%Electron缩放（440×320 CSS）分别检查，无窗口横向溢出，取消/诊断键盘可达。200%元素截图错误为空，已报告工具问题；采用视口截图及真实键盘/DOM证据，未冒充可见原生窗口通过。
- 四个已运行Electron实例均已退出并清理，真实headless、主夹具、返回页夹具退出0；首次主夹具因不可重定义Electron.Tray加载失败，0窗口/0原生访问，退出1并清理，已修正后复验。两个临时UI夹具已删除；cleanup回执确认监控timers/watchers/pending均0。npm包装未就绪后使用同一`node scripts/develop.mjs`启动器，未用裸Electron入口。
- 三次同seed stress均complete，最终摘要39ce4d…feff，全部阶段RSS采样最大1360.27/1361.72/1376.25MiB；启动3804.59/3103.50/3717.83ms仍高于前态1554.05ms。入口计时确认出生至Node preload2064.19ms，主模块编译/同步求值4ms；单独原生sample的756/756样本位于dyld映射动态库的fcntl等待，发生在Node启动前。未确认内核等待的具体原因、未宣称性能问题解决；记录为原生启动验收问题。完整数字、CPU阶段标签纠正和限制见performance-baseline.md的U-05节；原始证据为三个/tmp/oc-chan-u05性能目录及early-native-sample.txt。所有测量和原生采样实例均退出清理，临时计时/采样脚本已删除。
- U-05整卡未完成：真实安装路径注册/取消、系统批准、隔离账号登录及原生焦点仍未验。已有18/37整卡完成不变；不自行安装替换、注销当前账号、创建测试账号或注册正式登录项。

## 限制与风险

- 无可用TypeScript语言服务器，references调用返回“No language server found for this action”；已用当前扫描核对被删常量无外部使用。
- 不覆盖工作区既有用户/并行任务改动；不全量暂存、不重置、不清理其它实例。
- UI默认独立headless Electron；不把它当成VoiceOver、物理托盘和原生焦点验收。
- 本期范围已合入主清单、README和CI：仅arm64；D-01/O-01延期，不安排凭据核查或多人联系；F-07只读公开接口调研。D-03的本地安装与原生专项仍须对应授权，未安装/未验收不能冒称完成。

## S-03 本地边界验收完成 · 2026-11-05

- 两个实现切片均已返回并由主代理集成复核；没有仍运行的子代理。涉及tern-navigation.ts/test、tern-present.swift、main/index、shutdown/test、shared/diagnostics、resource-io、CI映射和README。保留当前直接pane优先语义：有自己的精确目标时不要求更高祖先仍存活，无目标时才沿有效父链查找。
- 修改前受控复现：非法换行key仍触发一次runner；错误PID777回执被接受（实际选定PID99），真实外部命令0。证据`/tmp/oc-chan-s03-before-20261105.json`。
- 本机Tern实际签名：bundle `so.stencil.tern`，Team `VTLHGQC72S`，Developer ID Application: Can Boluk，Apple锚；仅只读核对。现有导航插件版本1.0.0、ready、window=true，未安装/启停插件。
- 原生helper现为`probe`和`present pid executable key`。probe验证唯一bundle、进程路径、运行和磁盘代码签名；无AX、无激活。present先验参数并绑定PID/可执行路径，之后才检查无提示AX授权和精确原生窗口。窗口key ASCII白名单≤128；AX单次250ms、每数组256/每扫描2048元素，标题≤4096，原生等待有界，固定错误码。
- 首次`npm run build:native`因Swift不导入两个C宏失败；改为SDK定义的`4 * MAXPATHLEN`和`SecCSFlags(rawValue:0)`后通过。真实helper的只读probe及13个无效参数/错身份拒绝场景通过，证据`/tmp/oc-chan-s03-native-evidence-20261105.json`；没有尝试原生激活/权限提示。helper 85696→134480字节（+48784），首次probe892.55ms、峰值RSS15MiB；错误PID/path验证约455/467ms，其余坏参数约6–8ms。不是完整导航性能或原生全屏验收。
- TS、共享集成和检查：typecheck通过；首次50项中49通过，真实helper错误用例定位到runBudgetedCommand未保留有界stderr。已以非枚举字段保留该有界数据供固定协议分类，仍通过S-02脱敏；修复后4项实际子进程和12项resource-io检查通过，累计62个独立检查具通过结果，其余仍适用结果复用。未跑仓库全套。没有兼容旧focusAgentInTern导出，cancel可复用、close永久关闭，主窗关闭/renderer失联/页面导航/应用退出均取消，资源释放前保持busy。
- 真实headless实例验证32次导航IPC均被拒绝、导航资源创建0、窗口隐藏且不可聚焦；主进程和启动器均退出0，watchers/timers/pending/资源额度归零，instance-IqVRdG已删除。证据`/tmp/oc-chan-s03-headless-evidence-20261105.json`。npm包装启动无日志且未就绪，停止后直接调用同一scripts/develop.mjs启动器完成验收；未使用裸Electron。两个/tmp烟测脚本均删除。
- 同seed stress完成且清理/证据无错误，摘要474d4819…39c238，启动2905.61ms，全阶段RSS采样最大1373.88MiB，收尾有效CPU3点均值73.88%；128/500/2000节点单次往返32.87/223.68/451.95ms，限制见performance-baseline.md。没有把短测当作24h或Native性能证明。
- 按本卡既定验证范围标记本地边界完成，原生授权、全屏切换、真实菜单/focus验收仍在D-03；未激活Tern、未安装插件、未替换应用。整卡计数现19/37，U-05和R-03原阻塞不变。下一卡S-04。

## S-04 完成证据 · 2026-11-05

- 新增shared/diagnostic-report、main/diagnostic-report及Diagnostics服务、DiagnosticPanel/CSS；接入来源页、严格主窗IPC、preload、文档及退出排空。白名单读取自身数据属性，拒绝getter/proxy/coercion，不读取对象正文；报告≤256KiB/64来源/128诊断/32资源，未知总数保持null，来源ID归一化。全应用一个预览、一个在途、一个10分钟计时器；取消/过期/替换撤销ID，清理失败阻止后续输出。
- 真实开发预览发现应用版本错误使用Electron版本，以及schedule-limits未列白名单，两项已修正。最终typecheck与21项诊断测试通过；此前`node --import tsx --test src/main/diagnostic-report.test.ts src/main/diagnostics.test.ts src/main/ipc-boundary.test.ts src/main/shutdown.test.ts scripts/ci-tests.test.mjs src/shared/diagnostics.test.ts`45项通过，未受影响结果复用；未跑全仓测试。最终复制使用Electron45的Promise型原生clipboard.writeText并等待确认，无pbcopy子进程。
- `/tmp/oc-chan-s04-ui-evidence-20261105.json`：实际预览版本0.1.0、22/22来源，约19KiB，不含私有路径。原生剪贴板内容逐字匹配预览，随后恢复原纯文本剪贴板。真实0600文件原子链接、已存在目标拒绝、EACCES、选择器取消、保存中关闭/离页、采样保留焦点/选区、32并发仅1ready/31busy均通过。初始observer脚本引用bundle命名错误，修正后重启，失败实例退出；该问题不算产品缺陷。
- 内容区880×640、960/961×720、1280×860、1728×1000与连续880–1280调整无横向溢出；中英深浅色、200%文字及200%Electron缩放分别通过，复制/保存键盘可达。持续缩放的第一份DOM读数早于最终尺寸提交，后续确认1280×720，未误称中间880为最终尺寸。实例始终无可见窗口；系统保存对话框用受控选择器替代，真实原生对话框/VoiceOver未验，不扩展本卡规定的headless验收范围。
- 同驱动专项`/tmp/oc-chan-s04-pressure-20261105/result.json` complete、退出0、实例删除：长度4294967295稀疏数组输入，1000次真实IPC生成最大46427字节，p95往返0.7ms；25次真实保存逐字核对并清理；取消后预览/计时器/IO额度0。全树RSS采样最大675.23MiB，结束未降回初始单点568.91MiB，不声称长期内存平台。首次跨启动器附着被采样器拒绝，没有有效RSS，该失败已保留。
- 同seed标准stress`/tmp/oc-chan-s04-after-stress-20261105` complete、cleanup/evidence无错误，摘要e164b5af…d099；启动3666.75ms、阶段RSS最大1322.70MiB、2000节点单次489.32ms。与S-03比较及CPU覆盖限制见性能记录；Node前原生等待仍未解决，无24h/原生性能声明。所有本卡实例退出，两个临时启动脚本删除，原始证据保留。当前20/37整卡完成，下一卡A-01。

## A-01 完成证据 · 2026-11-05

- 独立分支`feature/oc-chan-plugin-lifecycle-20261105`；新增plugins/contracts、registry/test、system；修改monitor/test、main入口、package/CI映射和性能探针。两个实现代理均已返回。最大16插件、元数据/依赖校验、懒初始化、共享预算、固定采样、同请求合并、取消排空、迟到发布拒绝与逆依赖关闭已接入。system旧调度/隐式构造删除。
- 主代理集成修正两处TypeScript关联快照类型，以及采集耗时/手动刷新推迟下一周期的回归（先失败、后通过）。`npm run typecheck`及registry、monitor、system、network、shutdown、ci-tests、performance/core共81项通过；未跑全仓测试。
- `/tmp/oc-chan-a01-lifecycle-20261105/result.json` complete：65次采样保留60点、CPU/RSS各10行；真实内存读取故障保留旧数据，其它两域继续刷新；正常停用清旧错误且保留时间；100次启停重建CPU/网络/历史基线，停用后计数不增长、额度为0。退出0、全局额度/监听/计时器/排队归零，实例删除。
- `/tmp/oc-chan-a01-ui-evidence-20261105.json`：真实1280×860无头渲染、正常/故障截图、停用后错误清除及重新启用CPU未知/历史1点；页面错误0，无横向溢出。未使用可见原生窗口。
- 同seed标准stress complete，摘要`b42e7efb…f0ba`，启动3542.12ms、RSS采样最大1371.69MiB；专项最大662.63MiB。短命进程及CPU覆盖限制见性能记录；不声称绝对峰值或长期平台，Node前原生等待未解决。两份临时启动/探针脚本已清理，保留原始证据。

## A-02 完成证据 · 2026-11-05

- 三个实现切片CoreLifecycle、BuiltinSources、SourceControls均已返回，未留运行代理。Agent、任务/历史、系统全部显式注册并走同一公开契约，Monitor不再依赖具体采集器；原独立history退出入口已删除。设置plugins子字段合并/严格校验/16笔事务上限、apply→save失败回滚、三个来源开关及停用快照已接通，README/PRODUCT/DESIGN同步。
- 主代理首跑195项定向检查193通过，2个CI选择预期因新增插件依赖失败；类型检查发现shutdown旧history必填入口。删除旧入口、迁移其行为测试并补齐CI依赖后，typecheck通过，受影响shutdown四项与CI全部通过；最终仅复跑剩余collection/view选择一项通过。累计195个独立检查有通过证据，未跑全仓套件。
- 真实Electron验收：EACCES回滚到原启用状态，键盘焦点保留，恢复权限后Enter重试关闭Agent且watchers归零。全部停用时timers/pending/children/共享额度为0、旧快照时间保留、概览/托盘当前计数未知、画布持续动画0；Space加100次合成重复点击仅创建一个新任务插件。真实SQLite helper启动后停用得到AbortError并等待close，新代历史读取成功；历史详情停用保留23条并禁用刷新，恢复后时间更新、选择不变。
- 窗口880×640、959/960/961×720、1280×860、1728×1000及200%文字/200%Electron缩放已检查。发现英文200%文字的page-heading导致main-content内部846/659px溢出，修为按内容换行；六页面复验659/659、heading615/615。最终renderer错误为空。仅真实无头渲染，原生窗口/VoiceOver/可见motion未验；Impeccable detector返回19条既有圆角advisory，没有新增拦截项，不顺带改设计规范。
- `/tmp/oc-chan-a02-lifecycle-fixed-20261105/`完成真实IPC三插件100轮启停，每轮关闭后资源为0；177个非空RSS采样最大1022.16MiB，四段均值956.25/983.54/944.34/948.44MiB，整体覆盖不完整。旧脚本SIGTERM结束开发实例后缺shutdown.json，原记录保留complete:false；不是完整退出通过。首次observer因bundle引用错误失败，原PID95832及该实例打开句柄均已确认不存在，instance-pyS8Up已清理。UI证据`/tmp/oc-chan-a02-ui-evidence-20261105.json`。
- `/tmp/oc-chan-a02-restart-20261105/result.json` complete，三个停用插件generation0、采集/资源创建0、首次空态无无限busy或虚假零计数；应用退出code0、启动器收尾SIGTERM143。正常退出补验发现真实竞态：几何保存重应用已关闭插件，导致设置回滚失败。`shutdown.ts`改为设置排空后关闭monitor/desktop，独立资源并行；保存失败仍清理，保留5秒总时限。`shutdown.test.ts`新增真实registry+SettingsStore回归先失败后通过；29项shutdown/settings/geometry及typecheck通过。最终`/tmp/oc-chan-a02-exit-fixed-20261105/result.json` complete，应用/启动器/采样器均0、16个监听和1068个子进程关闭、资源全0、实例删除；旧失败探针结果保留。
- 最终同seed stress complete，源码摘要`667f57b0…7690`，启动1602.32ms、RSS采样最大1368.48MiB、2000节点单次往返473.04ms；完整对照与限制见performance-baseline.md。没有新性能退化证据，不声称启动原生等待已解决、性能提升或24h通过。临时run/probe脚本已删除，保留原始证据和重启种子；A-02已完成。本卡未提交、推送、安装或发布。

## P-04 完成证据 · 2026-11-05

- 修改agent-topology、AgentTopology、AgentsView、view-state及拓扑CSS/测试，README/DESIGN同步。父节点优先迭代顺序、每页/单次布局200节点、真实跨页计数与父链接、首个匹配自动选页与可读定位已接通；全部存活ID位置回收和4096上限复用U-02。无依赖新增。
- 24项拓扑/查看状态定向检查及最终typecheck通过，包含2000深链、501环、全部页唯一可达、缩减后页码钳制及1000轮对象换代。真实Electron完成四档规模搜索、2000节点10页遍历、深链/环跨页、手动拖动与页面恢复；20次真实刷新布局调用0、坐标及视口逐值相同。
- 发现深链搜索缩到5%且命中节点不在可读区域，修正自动fit目标；实测命中节点260×151、zoom1，父链跨页后筛选保留。迁移中旧HMR查看状态触发Invalid topology page，完整重载后最终界面新错误0；不为开发热更新保留旧状态兼容层。探针最初用不支持的内部ID搜索，后按实际支持的名称/PID口径验收。
- `/tmp/oc-chan-p04-ui-evidence-20261105.json` complete；200节点分支/深链布局各30次，p95为17.10/19.50ms。20次选择提交p95为15.30ms，下一渲染帧观测p95为44.10ms。402175事件trace中renderer RunTask最大49.999ms、≥50ms任务0；rAF p95/p99为18.60/18.70ms，不能当物理60/120Hz通过。trace100181970字节采用2MiB单记录上限流式分析，摘要另存`/tmp/oc-chan-p04-trace-summary-20261105.json`。
- 内容区880×640、959/960/961×720、1280×860、1728×1000，11次连续调整，中英深浅色，200%文字及独立200%Electron缩放已验。最终440×320 CSS视口主内容clientWidth433、分页391，无横向溢出，Enter翻页后按钮焦点保持。仅无头真实渲染，不宣称原生窗口、VoiceOver、可见动画通过。实例正常退出0、instance-vtHlkN删除，临时夹具/config/probe清理；原始证据保留。
- 同seed stress `/tmp/oc-chan-p04-after-stress-20261105/result.json` complete、无cleanup/evidence错误；源码摘要`9a0ed6d9…17ca`。启动4231.51ms、三域齐备4038.86ms、RSS采样最大1168.94MiB、2000节点单次往返141.78ms；CPU/短命进程采样及启动等待限制见性能记录。未跑全仓测试，未提交/推送/安装/发布。

## U-07 无头检查与原生缺口 · 2026-11-05

- AgentsView 增加 Esc 与快捷键语义；AgentTopology 关闭重复的库内选择并暴露 aria-current。复现到菜单退出后的第二次 Esc 在下一帧丢失焦点，原因是 React Flow 的延迟 blur；修复后两帧后仍聚焦原节点，ArrowRight/Shift+ArrowDown 将坐标从900,0移动到905,20。原目标从采样移除后回搜索。
- 真实 EACCES 保存失败保留 light，焦点仍在 dark radio；恢复权限后 Tab/Enter 重试保存 dark，焦点返回 radio。侧栏 Home/End/ArrowLeft读数188/320/312；托盘键盘多选、CPU/内存独立展开通过。中英深浅色、200%文字节点焦点可见，renderer errors为空；typecheck通过，未跑全仓测试。
- `/tmp/oc-chan-u07-keyboard-evidence-20261105.json` 保存修复前后证据、探针错误与未验项。原生select按键未改值；托盘打开主窗按设计被headless拒绝；VoiceOver尚无实际朗读。整卡保持未完成，todo阻塞于原生专项，23/37整卡完成不变。验收目录权限已恢复，`oc-u07-keyboard` / `instance-qltDmD`复用于U-08后退出0，实例及临时fixture/config已清理。退出探针挂will-quit未产生文件：源码实际使用app.exit；只确认进程退出及目录移除，不宣称资源逐项归零。

## U-08 无头生命周期证据 · 2026-11-05

- `/tmp/oc-chan-u08-motion-evidence-20261105.json`：20轮抽屉反向、20轮筛选反向、侧栏Esc/失焦/隐藏取消均通过；40次抽屉状态与inert匹配、42次取消、最多2条当前过渡、最终无残留。隐藏抽屉停止，恢复无补播。20次采样保留28个动画对象；冻结8帧不推进动画时间，4条离屏路径暂停，隐藏全部暂停，运行时模拟reduce-motion停用后可恢复。renderer错误为空；未修改动效源码。
- 原生可见录屏、系统设置切换与物理60/120Hz/CPU/RSS专项未验，整卡阻塞于该专项，不将headless或AX冒充原生。复用U-07实例已退出且清理，退出资源探针缺口如上一节。
- U-07后态同seed stress已complete、cleanup/evidence无错误，源码08044099…43638，启动4195.05ms、采样RSS最大1173.05MiB、2000节点单次153.88ms；完整前后对照与不完整CPU/生命周期覆盖见performance-baseline。一次误用--output在启动前被CLI拒绝，改用既有--out后完成，未重复通过检查。

## Q-02 已完成 · 2026-11-05

- SmokeHarness与SmokeScenarios已完成实现并交由主代理集成：`smoke-renderer.mjs`、`smoke/{vite.config,main-probe,scenarios}.mjs`、develop、package/CI映射与README。使用既有performance fixture/CDP，无新增依赖；仅隔离验收构建带控制探针。
- 首轮真实smoke在概览直达Agent后Esc归还焦点失败；`/tmp/oc-chan-q02-focus-trace-20261105`记录了对尚在测量、visibility:hidden节点的focus调用。AgentsView保留一次归还请求，AgentTopology待节点就绪后处理；若焦点已转到其它控件则放弃。临时原型跟踪已移除，保留有界DOM诊断。后续真实路径及typecheck通过。
- 配置损坏的脚本最初错误期待单来源badge；实际产品明确拒绝部分任务清单，保留旧完整快照并显示分区错误。现验证Hermes错误、旧快照时间/1100任务数保留、其它域继续工作，并使用实际分区重试控件恢复；没有修改产品错误语义。
- `/tmp/oc-chan-q02-positive-recovery-20261105/result.json` complete=true、errors=[]，8个外层阶段全部通过；真实32合成Agent、1100合成任务、系统采集、准确直达、历史分页/两种取消、来源/IPC错误恢复、dark+nord保存及独立重启读取全部通过。两次进程正常退出0，monitor停止/定时器及排队归零、插件关闭、全局资源预留归零；独立profile、进程组和自建fixture已清理。12张截图与727951字节日志保留。证据目录中的settings是合成profile数据，非个人设置。
- 主代理已通过CI选择器9项和YAML门禁顺序/条件校验；失败单元测试阻断下游仍通过。`/tmp/oc-chan-q02-fault-fixture-20261105`与`/tmp/oc-chan-q02-fault-ipc-20261105`均在对应关键恢复断言处退出1，错误阶段/截图可定位；应用自身正常退出0，所有采集预留归零，进程组/profile/fixture清理成功。未跑全仓测试、云端CI、安装或可见原生验收。
- 冻结源码前后测量已完成：`/tmp/oc-chan-q02-frozen-after3-stress-20261105`与`/tmp/oc-chan-q02-frozen-before2-stress-20261105`均complete、cleanup/evidence无错误；摘要7d2f125b…ed0ac与e9c3d4ab…ebbc1，清单仅AgentTopology/AgentsView不同。CPU单核均值61.24/61.34%，RSS采样最大1165.19/1186.81MiB，2000节点往返149.03/152.49ms。前一次前态遇宿主负载68/空闲内存不足500MiB，异常RSS低值没有随撤销补丁重复；完整对照、失败测量及覆盖限制见performance-baseline。副本typecheck通过，原仓库焦点补丁保持，整卡已完成。

## F-04 已完成 · 2026-11-05

- EventStorage、HermesEventCursor两个实现切片已完成，主代理集成events/contracts、hermes、store、collector及各自测试、plugins/events，扩展MonitorSection/设置/IPC/诊断/来源页与CI映射。事件每30秒采集；首次基线不补发历史，rowid增量+轮转补查、128条基线pending、每轮40行、来源60秒持续错误及120秒采样断档均显式处理。无依赖新增，无用户数据库写入。
- 应用库0700/0600，单条2KiB、每页50、7天/10000条/20MiB含日志；数据库8MiB、事件载荷3MiB为索引/去重留空间，SQLite16MiB。墓碑32768条/7天，淘汰时事务内推进floor并记录持久断档，不依赖claimed_at不可变；原子事件/检查点、revision冲突及失败可见。主代理补全全队列合计100条事件（含在途）与16请求上限，并在向调用方返回前释放额度。
- 初次typecheck通过；`node --import tsx --test src/main/events/*.test.ts src/main/monitor.test.ts src/main/plugins/registry.test.ts src/main/ipc-boundary.test.ts src/main/settings.test.ts src/main/diagnostic-report.test.ts scripts/ci-tests.test.mjs`147项通过。真实Electron首轮`/tmp/oc-chan-f04-renderer-20261105`失败，四分区就绪未达；实例退出0、资源与profile已清理，失败结果保留。
- 定位时间竞态：先取clock，再异步load检查点，之后读到其它分区的新采样，错误判为未来时间。新增真实SQLite回归先失败`Invalid source observation time`，改为load后捕获输入再取clock；collector7项通过。Electron同版本独立SQLite诊断成功，未误把问题归为SQLite不支持。
- `/tmp/oc-chan-f04-renderer-fixed-20261105/result.json` complete=true/errors=[]，8外层阶段全部通过；真实四分区/来源控件、100次事件采样保留2次执行失败+1次投递失败，共3条、45056字节；停用拒绝查询并排空，重新创建插件后ID逐值相同。主题实际保存及新进程读取亦通过。两次应用/启动器退出0，插件/计时器/排队/全局资源归零，独立profile/fixture清理。源码已知类型与行为共148个独立定向检查有通过结果，最终类型复验与冻结源码性能对照在继续；未跑全仓、未安装或可见原生验收。
- 最终typecheck及performance/core7项通过。测量器原先仅接受三分区，启用组报Invalid traffic section并正常清理；扩为四分区后，两份冻结副本仅settings的events默认开关不同。matched停用/启用完整通过，摘要32af5154…e818与53e5a429…2789；启动4750.70/4809.30ms、已统计RSS采样最大1072.44/1151.78MiB，CPU有效3区间均值77.98/79.04%，2000节点148.02/167.99ms。另一停用产品同源码样本RSS1152.75MiB，短测差异不能归因或推导加速/稳定退化；详见performance-baseline。清单已勾选F-04，共25卡。

## F-05 已完成 · 2026-11-05

- EventListView与EventListSmoke已交付；主代理复核并集成页面、局部CSS、5000条真实临时库种子和IPC/筛选/分页/导航/取消/覆盖断档场景。代理未运行检查；主代理负责统一验收。
- events页面路由、App查看状态与真实cancel-events单在途IPC（主窗限定）已接入；取消穿透Monitor/registry/plugin/collector到EventStore。EventRetention新增newestSequence=max(实际保留seq)，不以采样revision误报新事件。主代理修正StrictMode/页面激活边界：恢复成功页，不重放失败翻页；只有新的明确请求改变游标。断档count显示为次数。
- `npm run typecheck`及事件store/collector、navigation、IPC、diagnostic-report、registry、monitor、CI选择器共113项定向检查通过；三个smoke脚本语法检查通过。未跑全仓测试。
- `/tmp/oc-chan-f05-renderer-cancel-timed-20261105/result.json`完整通过、errors=[]：8个外层阶段、23张截图；5000条种子只挂载当前页50条，组合筛选／稳定分页／真实任务历史／过时与空目标／新记录提示／失败翻页重试及离页返回／真实直接与UI暂停取消／停用与锁库覆盖断档／1280×860和880×640及200%文字均通过。两次应用退出0，monitor、插件、排队和全局资源归零，实例profile与合成输入清理。已亲自检查默认与200%截图；原生窗口、菜单键盘和物理缩放未验。
- 此前四轮smoke未完整通过：原生select的CDP方向键不提交、无头Command-A未全选、用scrollTop误判浏览器锚定、暂停点击晚于500ms锁超时。已分别采用明确标注的DOM选项自动化、CDP selectAll编辑命令、可见记录位置断言、预先核对暂停按钮坐标并减少在途往返；未放宽真实IPC／取消断言或修改产品超时。记录前后同一可见行top=103.796875px，scrollTop由240变269.5，真实阅读位置未动。失败证据均保留，进程与profile清理成功。独立输入诊断证据/private/tmp/oc-chan-f05-ui-5uxfvL，退出0且输入已清理。
- README/DESIGN已更新；冻结源码/private/tmp/oc-chan-f05-source-LzJw8L的/tmp/oc-chan-f05-after-stress-20261105已完整通过，摘要96b57872…fc31；启动4617.36ms、已采RSS最大1164.03MiB、CPU有效3区间均值77.06%、2000节点单次144.32ms。与F-04同环境/同seed对照及500节点单样本差异、覆盖限制见performance-baseline；不推导性能提升或稳定退化。F-05整卡已完成，总计26卡。

## F-06 实现与隔离验收，原生专项未完成 · 2026-11-05

- NotificationPolicy、NotificationUI、NativeNotifications均已交付，主代理集成新通知契约、持久日志、同进程UserNotifications权限模块、事件提交后通知、设置/任务订阅与原生生命周期。默认关闭，64来源/24任务/48KiB偏好；60秒最多3条、5分钟冷却、跨午夜静默、默认脱敏、完整身份导航、64KiB日志先认领后发送、最多8个原生对象。无新npm依赖。
- 主审修复清理失败被吞、pending权限说明丢失、日志自动改权限/硬链接未拒绝、计数静默饱和，以及保存后refresh错误误报设置连接失败。stop仍向registry/shutdown拒绝真实清理失败；其它入口显式保留状态错误，不阻断事件收集。补齐实际可订阅的collection分区并排除不产生事件的存储行。权限按钮在全局/事件停用或unsupported时明确不可操作。
- 主代理运行143项通知/事件store/collector/设置/IPC/导航/registry/monitor/shutdown，19项native adapter，54项包门禁/CI检查，全部通过。typecheck首轮发现测试mock的可选getuid类型，修正后最终通过；3个smoke脚本语法通过。arm64 addon编译通过，file/otool确认Mach-O bundle及公共系统框架；未运行全仓测试或原生通知。
- `/tmp/oc-chan-f06-notifications-20261105/result.json` complete=true、errors=[]，8外层阶段通过、13截图。真实任务身份订阅、来源/类型、无效与跨午夜静默时间、真实目录0500导致EACCES并回滚、恢复权限后实际写入及焦点返回、无头unsupported且事件仍可读、插件启停和独立重启均通过。中英1280×860/880×640及200%文字；时间输入是明确标注的DOM自动化，未冒充原生分段输入。两次应用退出0、资源与队列归零，实例/profile/合成输入清理。主代理已查看默认与英文200%截图。
- 冻结源码`/private/tmp/oc-chan-f06-source-J7nDDk`的`/tmp/oc-chan-f06-after-stress-20261105`完整通过；摘要da487821…f54ce，启动4801.88ms、已统计RSS最大1070.53MiB、CPU有效3区间均值77.83%、2000节点单次83.66ms。与F-05对照及采样覆盖限制见performance-baseline，不推导提升或24h结论。
- README/PRODUCT/DESIGN与清单已同步。F-06整卡保持未完成：系统权限/真实投递/点击、专注模式、真实睡眠唤醒与原生窗口未验，原约定独立专项尚无对应授权；目前仍26/37卡有完成证据。未提交、推送、安装或发布。下一步回验R-03通知队列取消，再推进R-04及本地交付准备。

## R-03 通知生命周期回验完成 · 2026-11-05

- `/tmp/oc-chan-r03-notification-cancel-20261105.json`完整通过。临时脚本运行真实Monitor/registry/events collector、SQLite、EventNotifications和journal，OS adapter可控且没有实际系统通知。8文件槽占满后真实排队取消1.02ms；在途取消必须等待adapter.close、晚到确认不翻转状态；100轮启停/重复stop p95=0.238ms、max=0.310ms。最终Monitor停止的插件、定时器、重试、IO及队列归零，725次实际操作完成，临时数据目录已清理。
- R-03整卡和依赖回验todo已完成，产品卡总计27/37；F-06系统权限/投递/点击仍独立保留未验。开始R-04：现有性能入口仅短测/基线，需补24h受控输入轮换、按小时聚合与有界证据，再启动长测；原生睡眠/网络切换和16GiB硬件条件不可由本机headless替代。

## R-04 工具集成与预验进行中 · 2026-11-05

- 已集成SoakFixtures与SoakRunner：`scripts/performance/fixtures{,.test}.mjs`、`run/core/core.test/main-probe/vite.config/soak-scenario.mjs`；主代理另修`measurement{,.test}.mjs`及`process-sampler.c`，新增`soak-scenario.test.mjs`并加入CI定向映射。没有新增产品依赖。
- `--scenario soak --mode baseline`计划真实24h，前2h预热；`--mode smoke`为两个180秒阶段，仅为预验。每小时包含会话轮换、100刷新/200历史替换、真实SQLite锁恢复、四插件启停、L2突发与回落，真实事件分页/保留及通知认领去重；无头通知保持unsupported，不实际发送。日志流式gzip仍64MiB磁盘上限，保留逐秒资源/生命周期，逐小时有界聚合、分钟原子心跳。RSS对比合并首/末稳定2h完整样本的中位数，门槛max(10%,64MiB)；CPU只报告完整身份区间。
- 已通过Measurement 4项、core 10项；`node --test scripts/performance/soak-scenario.test.mjs scripts/ci-tests.test.mjs`12项通过。此前fixtures/CI检查已有通过记录；本次没有重复全仓测试。
- `/tmp/oc-chan-r04-preflight-20261105`和`/tmp/oc-chan-r04-preflight-diagnostic-20261105`分别在24/25秒停止。逐进程原生错误码确认plutil在枚举后已退出（ESRCH=3），不是存活应用的权限错误。采样器现显式标记exited，保留null资源、原始错误码及CPU缺口；这些不完整RSS样本不进入趋势，存活进程不可读或主进程消失仍失败。两次均正常清理，无证据写入或清理错误。
- `/tmp/oc-chan-r04-preflight-exit-aware-20261105`第一阶段完成：4704/4704事件提交、p95/p99=136.75/205ms；插件启停/锁库恢复/通知去重通过，通知日志3903字节。CPU仅45完整区间，明确insufficient。阶段末180秒主动心跳与定时心跳重叠，被误判为积压；已改为合并同一个在途写入，只在实际持续超过一个心跳间隔时失败。失败结果保留，退出后插件/定时器/共享资源归零。
- `/tmp/oc-chan-r04-preflight-heartbeat-20261105`已越过阶段边界进入第二阶段，第一阶段4672/4672提交、p95/p99=132.25/200.5ms；第233秒Inspector诊断读取继承当时采集的AsyncLocalStorage租约，触发真实nested-request保护。已在探针模块初始上下文创建AsyncResource，绑定全部诊断控制，生产预算保护保持。独立真实资源/通知文件smoke通过：嵌套请求继续拒绝，隔离读返回真实identity/sequence=7/count=9，全部预留归零；证据`/tmp/oc-chan-r04-context-smoke-20261105.json`，临时脚本和数据已移除。
- `/tmp/oc-chan-r04-preflight-context-20261105`已完整通过两个180秒阶段，360.28秒。已提交事件两段p95/p99=161.25/226.5ms、126.25/191.5ms，65条未关联提交；CPU47/56完整区间不足，保留覆盖缺口。真实事件分页、通知认领去重、插件启停/锁恢复、突发回落及退出清理通过；详细数值和未验范围已写`docs/performance-baseline.md`的R-04段。
- 同一冻结源码`/private/tmp/oc-chan-r04-source-pPQCTh`的真实24h已启动，持久服务`oc-chan-r04-24h-20261105`、输出`/tmp/oc-chan-r04-24h-20261105`。使用`caffeinate -i`临时阻止空闲睡眠；当前只收到就绪回执，整卡仍未完成。不能用预验代替长测、原生睡眠/网络切换或16GiB硬件。

## D-02 本地交付实现进行中 · 2026-11-05

- DeliverySource、DeliveryZip均已交付，新增`delivery-source{,.test}.mjs`与`delivery-zip{,.test}.mjs`；主代理已复核接口并新增`local-delivery{,.test}.mjs`，集成package脚本、CI定向映射、README手动升级说明。
- 流程从有界来源清单复制临时源码并构建，记录HEAD/dirty/tag与真实来源摘要，复用包门禁；ZIP有界预检＋单worker流式CRC/SHA，DMG校验＋只读挂载比对；最后复核源并生成交付清单。未执行安装、发布或正式签名公证。
- 将已有锁定的`unzipper@0.12.5`声明为精确直接devDependency；与R-04冻结锁逐项比较，仅根devDependencies增加该项，传递版本与节点不变。依赖审查policy同步精确lock摘要及理由，无应用运行依赖新增。
- 主代理`bg_148`的6份定向测试（local-delivery、delivery-source、delivery-zip、check-package、dependency-review、ci-tests）181项全部通过，输出artifact://940；未跑全仓。首轮真实交付`release/local-20261105-d02`失败：共享node_modules符号链接被既有许可证根边界检查拒绝，临时源码已清理，failure.json保留。改为临时副本按锁执行npm ci，不放松许可证检查；待重跑真实交付。D-02正式发布仍延期、整卡不可提前勾选。
- 第二轮`release/local-20261105-d02-isolated`已通过隔离npm ci、类型/Vite构建及DMG/ZIP生成，但实际codesign严格校验失败：code has no resources but signature indicates they must be present。根因是identity=null跳过完整包签名，仍有Electron原签名。将原安装时ad-hoc签名移至build-native afterPack（归档前），并移除install-local的重签；加入临时源码真实依赖审查及清单摘要。签名仅本地ad-hoc，不涉及证书或Apple服务。待最终真实交付验证。
- 第三轮`release/local-20261105-d02-signed`已通过签名/依赖审查/体积门禁，ZIP预检暴露包清单未记录空语言目录。清单现纳入所有目录与权限，ZIP同时检查可执行/目录权限；新增空目录遗漏/非空和权限丢失回归。包门禁与ZIP的112项定向检查全部通过；`/tmp/oc-chan-d02-archive-probe.mjs`实际复核已生成ZIP的610条目、322目录、270699367字节与目录包一致，app/asar体积预算通过。待最终整条交付验证，不能将该单项结果当作交付清单成功。
- 最终`npm run delivery:local -- --out release/local-20261105-d02-verified`退出0（64.94秒）。清单createdAt=2026-11-05T06:54:13.652Z，source=51bf29d59259cbc7ab951eb3ec06fd049a8dbdcf3f4a7b49bafaa895280d7001，dirty=true，tag/CI=null。实际源码隔离安装/类型检查/构建/原生编译/依赖审查/包预算/ad-hoc严格签名/610条ZIP与只读DMG一致性全部通过；临时源码清理和DMG卸载成功后才生成receipt。DMG=119717117字节、SHA256=986520d8368b155e1a3e14e321034cea4332fe8b3169fd08ba2eba3a7535f718；ZIP=116228288字节、SHA256=bb9ff5f3f21324412e1a0a34cee0c49649c100e7df651741d7191b0f45a3c7de。D-02本地材料完成，整卡按正式发布延期保持未完成。开始D-03安装预检与就绪/回滚失败矩阵；不实际替换个人应用。

## D-03 本地包与安装可达准备完成 · 2026-11-05

- 改动涉及`scripts/install-local{,.test}.mjs`、`install-validation.mjs`、`local-delivery.mjs`、`src/main/installation-check.mts`及测试、主进程启动/退出、开发启动器、package/CI选择器、`electron.vite.config.ts`与README。安装前校验来源、整包、架构、版本、真实签名、目标/磁盘/锁；安装成功需私有nonce协议回执确认实际运行路径、renderer、IPC、四采集域和历史，退出取消在途检查。
- 40项协议/事务/CI定向检查及typecheck通过；签名增强后`npm run test:install`31项通过。真实D-02包临时预检、同盘暂存、错误版本/签名声明/架构/损坏ASAR拒绝均通过，未创建目标、夹具已清理：`/tmp/oc-chan-d03-preflight-20261105/result.json`。
- 真实headless Electron正常就绪与错误版本、移除IPC处理器、白屏30秒超时验证通过，25条Hermes历史、退出0、Shutdown drained和实例清理：`/tmp/oc-chan-d03-readiness-interop-20261105/result.json`。故障分支加载当前源码转译的协议模块，不冒充已安装包故障注入；误猜chunks路径和缺esModuleInterop两次脚本失败记录保留。
- 前后stress短测均complete=true，详见`docs/performance-baseline.md`的D-03节。启动3326.99/3386.30ms，已观测RSS1166.17/1172.50MiB；事件覆盖及CPU样本不足，不声称稳定性能变化或完整峰值验收。
- `bg_168`最终交付第一次失败于`Unlisted ASAR file: out/main/installation-check-XbVymYwq.js`。根因为Vite默认分块路径不符合既有chunks白名单；main输出显式采用`chunks/[name]-[hash].js`，白名单、依赖和预算均未放宽。失败包及failure.json留在`release/local-20261105-d03-verified`。
- `bg_169`：`npm run delivery:local -- --out release/local-20261105-d03-chunks-verified`退出0，69.03秒。receipt创建于2026-11-05T07:40:54.006Z，source=`a4c215a6b5a14f022240aaeedab59bde9a0fecef1da45cf443c69cd1dc94b89a`，dirty=true、tag/CI=null。隔离npm ci、typecheck、Vite/原生构建、依赖/包预算/ad-hoc签名、610条ZIP和只读DMG一致性通过，临时源码清理和DMG卸载完成。
- 最终DMG=119755571字节、SHA256=`a30fd875b0bb09051d1179bcffec718f9d03d47d84c2de103540e29ab58ed9bf`；ZIP=116230840字节、SHA256=`ddd79b11eb1422588aee7830bdd88c432e9c4210eda798f157a51a85570f4818`。完整来源、签名、包清单与依赖证明均在该交付目录。
- `bg_171`：`node scripts/install-local.mjs --check-delivery release/local-20261105-d03-chunks-verified`退出0，verified=true、installed=false。`bg_170`真实`npm run dev -- --inspect`验证新的8.23kB动态分块：renderer/IPC/四采集域和25条Hermes历史ready，启动器退出0、Shutdown drained、实例移除，证据`/tmp/oc-chan-d03-chunk-startup-20261105/result.json`。未跑全仓测试；未打开可见窗口、替换个人应用或执行正式签名/发布。
- 台账完整文本校验确认37个唯一标题与37条索引集合一致，27卡勾选、10卡保留未完成。此前临时校验误用工具结果形状、截断正文的失败已修正，不是卡片丢失。

## F-07 本期只读调研已交付 · 2026-11-05

- `docs/omp-lifecycle-research.md`记录OMP18.16.0公开RPC、Collab、SDK及字段/父子关系/重连边界。RPC管理自身启动的会话；Collab元数据没有子代理列表，共享流含正文，不能当作既有本机会话的纯元数据接入。
- 保留activeSubagentCount未知；未注入进程、读取私有正文、修改OMP配置或实施适配器。本期调研交付不等于原始F-07功能卡完成。

## D-03 原生补验与通知崩溃修复 · 2026-11-05

- 原生证据集中在`.impeccable/review/backlog-native-2026-11-05/progress.json`。早期升级就绪后，个人应用被并行来源替换，因此不把该版本的后续操作归入本任务包。独立可见开发实例PID76541已退出；未停止并行实例。
- 原生select已用Space、ArrowUp、Enter将活跃筛选从active改为all并保留SELECT焦点；早期未改变值的尝试保留为not-verified。VoiceOver初始/最终均关闭；实际朗读接口10秒超时，未取得有效短语。AX树不等于朗读通过。物理托盘AXExtrasMenuBar返回-25212，没有物理托盘点击成功证据。
- 可见抽屉20轮/40次状态验证通过，原生录屏14.9967秒与Chromium trace已保留。SAMSUNG59.9401Hz、1280×860内容区；rAF p95/p99=17.5/17.7ms、最大17.8ms，compositor报告0个STATE_DROPPED。15次Electron进程采样最大725.8125MiB，CPU单核折算12.15%；不含外部采集helper，不是全树峰值，也不是120Hz/物理扫描证明。细节见性能基线；系统减少动态效果仍未验。
- 实际启用本机通知触发3次崩溃，系统报告`OC Chan-2026-11-05-165758.ips`、`165804.ips`、`165810.ips`。根因是Objective-C异步block保留了栈上`shared_ptr`参数的引用；`ReadSettings`/`RequestAuthorization`现按值持有State和Operation。没有屏蔽异常、提高超时或改变系统权限策略。
- `node --import tsx --test src/main/events/native-notifications.test.ts`19/19通过。独立真实Electron直接调用修复后的arm64模块：101次异步系统查询、100次取消、取消后JS回调0；未请求授权/未发通知。实例正常退出0并停止启动器。首次npm包装启动未就绪，改用同一`develop.mjs`入口；未用该失败声明产品启动通过。
- `npm run delivery:local -- --out release/local-20261105-d03-notification-fixed`通过，source=`b99901516e7443e3ce6c7421afb2b25d220b596ef76d6685f11957383fa1b1fb`。类型/构建、原生编译、依赖/包预算、严格ad-hoc签名、610条ZIP与只读DMG一致性通过；没有正式签名、公证或发布。
- 安装命令真实遇到45秒就绪超时＋15秒正常退出超时，保留`/Applications/.oc-chan-install-5ilb8S/previous.app`与安装现场，原失败协议目录`/private/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/oc-chan-install-check-gvhodm`。`/tmp/oc-chan-notification-installed-hang.txt`与恢复弹窗截图确认主线程停在macOS崩溃后窗口恢复NSAlert；不是新通知回调再次崩溃。限定应用身份后用原生Return完成恢复提示，应用随后正常退出，未强杀或清空个人数据。
- 对已装包核对ASAR和通知模块与交付目录一致后，用全新nonce启动验证成功：PID10823、版本0.1.0、实际路径`/Applications/OC Chan.app`；renderer、IPC、agents/schedules/system/events和25条Hermes历史ready。完整回执`notification-fixed-restart.json`。ASAR SHA256=`8e0ffe151e80429074434cdbf4ecaaf6d756c7cc3702ae3db4535ea49083916f`，通知模块=`b30907e6064f97958aa2a9a0cc4a1352aabb7bb5fd1246bf2811c69b0d8ea25a`。这份后续启动成功不抹除首次安装器双重失败。
- 已安装版设置页实际显示系统denied；点击「请求或重新检查权限」后仍正确显示拒绝，无崩溃。没有修改系统通知授权。已通过原生控件将本轮开启的本机通知恢复关闭，并核对设置落盘；showDock=true、preventSleep=true保持个人既有值。AXManualAccessibility恢复false。临时AX探针需在AXPress后保留300ms事件循环，立即退出的动作曾未生效；这属于验收工具问题，没有据此改产品导航。
- 本轮继续U-05时，原生AX树达到600节点边界；按已观察到的“设置”控件路径尝试NSRunningApplication及AXFrontmost聚焦，前两次未取得窗口，后一次AXPress返回成功但后续树仍未出现登录控件。不将动作回执当成界面成功；没有发出登录项修改。AXManualAccessibility每次均恢复false，进度记录`loginNative`保留具体失败。个人应用未开放TCP调试监听，未为补验重复重启或改动其启动参数；登录注册/原生焦点验收仍未完成。
- U-05隔离账号注册/登录、VoiceOver完整朗读、物理托盘、系统减少动态效果、全屏跳转与通知投递/点击/专注/睡眠仍未完成；不勾选D-03或这些整卡。

## R-04 三小时失败与时钟修复 · 2026-11-05

- 原服务`oc-chan-r04-24h-20261105`已退出1；`/tmp/oc-chan-r04-24h-20261105/result.json`为complete=false，实际10808895.51ms、3个完整小时，第4小时concurrent-refresh期间报`Invalid duration: -2.0048828125`。不能称24h通过或把3小时累计到下一轮。
- 结果cleanupError/evidenceError为空；退出后插件关闭、timers=0、pendingSections/queuedRetries为空、全局预留和队列为0。日志gzip3785138字节，在64MiB预算内。失败片段read计数3668，eventToReadComplete仅3667，错误发生于读取完成与生成时间相减；不是OOM结论或完整资源趋势验收。
- `scripts/performance/run.mjs`生成事件关联时间使用了Date.now，而probe使用performance.timeOrigin+performance.now。现统一用已有now()关联耗时，JSON夹具仍使用独立Date.now整数日期；不将负值钳成零或删除失败样本。core/measurement/soak-scenario17项定向测试通过，既有负延迟拒绝保持。
- 新源码已按有界清单复制并逐文件校验至`/private/tmp/oc-chan-r04-clock-source-CECanW`，delivery-source摘要`4d8679284d00f039000218bdbdcad80c5d91732f0b5e70779644122a06cdbac0`，193个文件；包含本次通知修复与计时修复。首次偏移预验在负载前因缺Electron二进制退出；锁定45.2.1包没有安装生命周期脚本，已成功执行其`npm exec -- install-electron`。README与CI增加显式准备步骤，CI选择器9项通过，工作流YAML解析通过；没有云端回执。
- `clock-shift-ready`真实Electron启动成功后，向前500ms注入使JSONL成为未来事件；采集器按既有规则拒绝，稳定段expected=4704、read/commit=0、readIssues=4704，预验因此未通过。全日志8585条「调用记录格式无效」，退出资源归零；原始证据保留。没有放宽产品的未来时间校验。
- 改用仅runner Date.now向后500ms后，`/tmp/oc-chan-r04-clock-behind-20261105/result.json` complete=true、退出0，实际360310.76ms的两阶段压缩预验通过。稳定段提交4702/4736、5118/5152，p95/p99分别129.5/202.5ms、136/195.25ms，readIssues=0；不是两小时实测。360次资源采样、195个漏采和4543个不完整生命周期，CPU完整区间48/56，CPU覆盖不足仍显式保留。退出插件关闭、timers/资源/队列归零；gzip319872字节；没有24h或全树峰值结论。
- 从同一冻结副本执行`node scripts/performance/run.mjs --mode baseline --scenario soak --seed 20261104 --out /tmp/oc-chan-r04-clock-24h-20261105`；未带时钟注入。持久服务`oc-chan-r04-clock-24h-20261105`已就绪并设置persist，runner PID50841，首轮启动到可交互3780ms。结果尚待真实24h，不能累计原3小时。性能fingerprint=`87ea7c6811a8f5021d208f9a3bb988b187d7076b9681cb34790cfce3763024b6`；与上述delivery-source摘要是不同清单口径。
- 时钟注入源码、命令与实际退出结果另存`/tmp/oc-chan-r04-clock-behind-20261105/clock-injection.json`。本轮临时偏移脚本及原生定位探针源码/二进制已删除；长测冻结副本、原始日志和安装失败现场保留。新24h不依赖这些已完成的临时探针。

## R-04 历史夹具耗尽修复 · 2026-11-05

- `oc-chan-r04-clock-24h-20261105`退出1，实际11896504.36ms、3个完整小时，错误`Synthetic history did not traverse the real SQLite reader`；本次没有负延迟或时钟缺段。187批追加14960个事件，事件保留已触发淘汰。完整回执及gzip4081518字节保留`/tmp/oc-chan-r04-clock-24h-20261105`。退出插件关闭、timers/pending/资源/队列归零，清理与证据写入无错误；最后资源采样app/development为空、实例已删除。不是24h通过。
- 根因在`fixtures.mjs`：每批40条固定归前40个任务，全库只留最新10000条；另外60个任务的原有历史持续被淘汰。新增全日回归在旧实现第187批精确失败：040–079号任务仅25条，与`run.mjs`每次历史读取要求25条且hasMore=true冲突。旧长测未记录实际失败回包，不能补造其具体任务ID；批次数与加速回归一致。
- 现用私有有界游标轮流分配全部100个任务，成功写入后更新游标；保留原10000条/32MiB SQLite/128MiB总夹具预算和真实分页断言。失败信息附合成job/source/count/hasMore便于以后定位。替换原100批不足覆盖的测试，并删除将每批固定前40任务当契约的断言；覆盖1440批、187/250/251批边界、全部任务可翻页、来源ID/顺序/行数/字节预算。`node --test scripts/performance/fixtures.test.mjs scripts/performance/soak-scenario.test.mjs`10/10通过，约24.67秒；无产品源码改动、无全仓检查。
- 新冻结源码`/private/tmp/oc-chan-r04-history-source-YrIG4w`，delivery-source摘要`d49ea9b0f52867b3f9abf91b21c2ef596f14bfc8cebb9d7f1fdd7dc16ab71a42`，193文件。依赖和锁定Electron准备成功。真实Electron读取经历1440批/57600条追加的SQLite：100个任务各100条，400页共10000条，内容/顺序与只读SQLite查询一致，末页hasMore=false、无重复。
- 分页验收证据`/tmp/oc-chan-r04-history-pages-20261105/result.json`。`npm run dev -- --inspect`被运行时rtk包装缓冲日志，就绪超时但子Electron实际已启动；经本任务PID/端口接入，没有重启应用。验收后主动对开发启动器PID46502发SIGTERM，因此监督进程143；8个所属进程已退出，实例与合成输入已清理。诊断脚本在正常退出前手动monitor.stop，随后最终几何设置访问已关闭插件而报告OC_PLUGIN_CLOSED/SettingsRollbackError；这条探针路径绕过产品先settings后monitor的退出顺序，不将该次验收宣称为无错误正常退出。原诊断保留，未为此修改产品代码。
- 同一冻结源码6分钟预验`/tmp/oc-chan-r04-history-preflight-20261105/result.json` complete=true、退出0，实际360303.17ms。两稳定段提交/计划4672/4704与5184/5184，readIssues=0，p95/p99为123.25/181.25与125/186.75ms；CPU有效区间42/46仍为insufficient。361次采样、2个采样前退出身份、186个漏采及4580个不完整生命周期、clockGaps=0，RSS完整样本最大1140.97/1117.66MiB，不作完整树峰值结论。退出插件关闭、timers/预留/队列与通知pending/summary归零，cleanupError/evidenceError为空，gzip323750字节；28批2240条事件尚未触发事件淘汰。性能fingerprint`2ef4f47d968d56b8fd6a98c152d1943017c4d758320c603a95af18243c3058d4`。
- 预验原始末次资源记录中app/development均为空，开发启动器记录`instance-AhhZaJ`已清理；与运行器退出资源检查一致。该证据只覆盖本次无头实例，不替代原生应用退出、通知权限或完整短命进程采样。
- 预验后已启动全新服务`oc-chan-r04-history-24h-20261105`，监督PID61227，初始就绪4341ms、CDP127.0.0.1:58676；`proc://oc-chan-r04-history-24h-20261105/mode`写persist并取得persistent回执。命令`node scripts/performance/run.mjs --mode baseline --scenario soak --seed 20261104 --out /tmp/oc-chan-r04-history-24h-20261105`，工作目录为上述冻结源码。仅确认运行中；两次失败时长均不累计，不重启或同时启动第二个性能实例。

## R-04 普通用户采样权限边界 · 2026-11-05

- 本轮repo仍为`/Users/zvf003/ZStack/oc-chan`、branch为`feature/oc-chan-liquid-glass-20261105`；保留所有并行产品改动。本次仅调查长测失败和更新证据文档，没有修改产品或测量器代码，没有新增管理员权限。
- `oc-chan-r04-history-24h-20261105`退出1，开始13:37:31.842Z、结束15:28:13.716Z，实际负载6636403.70ms（约1h50m36s），仅完成1个完整小时；`complete=false`，错误`Soak observed application RSS/CPU/FD sample unavailable`。第2小时warmup-L1阶段PID56069资源读取`taskInfo=1/EPERM`、RSS/CPU/FD全null；主Electron PID61292及其4个Helper当次字段均可读。PID56069在枚举时名字仍是Electron，出生时间1793892493:366250，随后约41ms退出；原日志没有该PID可执行路径，不能把它的最终ps身份当成已确认事实。
- 定向原生复现：本机`stat /bin/ps`为`-rwsr-xr-x root:wheel`，系统采集器确实执行该命令。普通UID501探针对32个自行创建并等待退出的ps进行7959次资源读取，其中7917次EPERM，PROC_PIDT_SHORTBSDINFO同时确认有效UID0、真实UID501；成功资源样本0，32轮均没有稍后恢复可读，均退出0。这证实负载存在普通用户无法读取的setuid子进程，而非可通过重试解决的瞬时故障；将原PID56069归因于ps是与现场一致的推断。回执`/tmp/oc-chan-r04-permission-probe-20261105.json`，失败原始片段`/tmp/oc-chan-r04-permission-failure-20261105.json`。临时C探针及二进制已删除。
- 实现边界：`process-sampler.c`的read_bsd使用要求同凭据的PROC_PIDTBSDINFO，后续TASKALLINFO同样受限；已经exec为root的ps身份可能先被拒绝而落入系统权限/生命周期缺口，恰好在exec前记住身份的样本则在资源读取时触发严格失败。因此短预验成功不证明权限具备。Apple公开实现`proc_security_policy`核对同有效UID，SHORTBSDINFO不要求同UID；来源 https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c ，核对2026-11-05。公开main分支仅作接口机制依据，不声称与本机Darwin构建完全一致。
- 全程6621次负载资源采样，applicationUnavailable=1、43个采样前退出身份、3341个漏采及33584个不完整生命周期、clockGaps=0。第一完整小时仍属预热：提交109437/109472、p95/p99 121.25/183.75ms、RSS完整样本最大1081.77MiB；CPU1470个有效区间仅代表可读身份，不是完整树验收。105批追加8400事件，事件淘汰已发生；没有本轮历史耗尽或负延迟错误。
- 退出插件关闭，timers/pending/retries/资源预留/队列/通知summary与pending全归零，cleanupError/evidenceError为空。原始末次app/development均为空，启动器记录`instance-2HyUm4`已清理；gzip2276622字节。原失败证据完整保留，三轮失败时长不累计。
- 不修改EPERM为成功、不丢弃该进程或放宽资源验收。相同权限下不启动第四轮。下一步需用户决定是否授权实现并运行本次验收专用的管理员只读采样器；Electron和负载驱动必须仍为普通用户，权限只解决已证实的读取阻塞，不承诺消除全部短命进程漏采。未获授权前R-04保持未验收；本轮无产品测试/构建/提交/推送/安装或发布。

## R-04 专用管理员采样器 · 2026-11-06

- 用户已明确选择「授权专用采样器」，范围仅本次验收的只读资源采样；Electron与Node负载驱动保持普通用户。当前repo仍为`/Users/zvf003/ZStack/oc-chan`，为本次权限实现切到`fix/oc-chan-r04-admin-sampler-20261106`。保留所有产品并行改动；没有新增产品提权、sudoers、常驻服务、提交、推送或安装。
- 改动：`scripts/performance/process-sampler.c`新增管理员Unix socket入口、内核peer UID/PID校验、owner出生身份复核和普通用户roots链；`sampler.mjs`管理真实系统认证、120秒启动截止、单连接4KiB握手和退出清理；`run.mjs`显式接受`--sampler user|admin`，启动与失败均保留身份/错误，清理逐项继续并聚合失败。AppleScript执行期限172800秒，不能把认证等待期限用于截断长测。nonce不进入正式identity证据。
- 独立审查发现并修复缓存父身份不可读时授权新后代的漏洞：旧父身份仍可测量并保留错误，但新身份只允许从本轮有效祖先继承。`process-sampler-native.test.c`在原实现实际失败（`unreadable cached parent admitted a new child`），修复后通过；同时覆盖PID复用、出生顺序、有效setuid后代和已接纳后代reparent。独立复核确认此阻塞项闭合。
- 检查：首次`node --import tsx --test scripts/performance/sampler.test.mjs scripts/ci-tests.test.mjs`为22/22；新增祖先边界后`node --test scripts/performance/sampler.test.mjs`为14/14，原CI9项仍适用。原生clang `-O2 -Wall -Wextra`无警告通过。未跑全仓测试或发布构建。
- 真实权限证据`/tmp/oc-chan-r04-admin-smoke-20261106.json`：driver PID40669、app均UID/EUID501，sampler PID40780 EUID0；64个真实/bin/ps均取得RSS/CPU/FD，权限失败0，末次app/development为空，驱动及root采样器已确认退出。64个生命周期仍标`incomplete:true`，不是完整生命周期或绝对峰值验收。
- 真实生命周期证据`/tmp/oc-chan-r04-admin-disconnect-20261106.json`：owner存活时直接断链，root及osascript退出且明确失败；owner正常退出后二者退出；测试进程继续持有连接副本时，owner退出约1012.66ms后仍由身份检查终止root，收到`sampler owner exited or changed identity/credentials`。所有探针进程已退出，探针完成后的私有socket临时目录无残留。强杀Node可能留下普通用户临时目录，未让root扩展为文件清理工具；系统认证拒绝未实测，120秒启动超时实际回执见下条。已删除本次两个临时探针源码及两个临时可执行文件，JSON证据与冻结源码保留。
- 新冻结源码`/private/tmp/oc-chan-r04-admin-source-h4AzW7`，196文件，delivery-source摘要`bd23450ba0da1e4920abfb81e03a3661a25a1b93cd2cd7c6c38357f0075f358d`；捕获前后源摘要一致、逐文件复制摘要一致。与历史冻结副本的package-lock SHA-256一致（`ab92f1d9b5097b48a63b0cb6cf3e49f3d74c1eb36cefa8d0bec45f376a8b5570`），依赖与已准备Electron使用独立COW副本，不共享可变构建目录。
- 两次真实Electron预验入口均未获得管理员采样握手并在约120秒后退出1：`/tmp/oc-chan-r04-admin-preflight-20261106/result.json`（02:31:48.758Z–02:33:50.021Z）与`/tmp/oc-chan-r04-admin-preflight-retry-20261106/result.json`（02:38:24.820Z–02:40:25.815Z）。均为`Sampler admin startup timed out`，osascript由本任务SIGTERM结束；complete=false、所有资源/业务样本0、Electron未启动、cleanupError/evidenceError为空，各有gzip证据11153字节。源码fingerprint均为`0444648d2050941f6833a09fb381a60f1085f15eb75af68ba7e265feab713be8`。未覆盖或删除失败目录，未放宽120秒截止。
- 同一冻结模块、同一已编译采样器的独立最小复现`/tmp/oc-chan-r04-authorization-diagnostic-20261106.json`在02:45:03Z–02:47:03Z同样超时。10秒后的1秒原生stack采样有86个观测全部停在`AuthorizationCreate → xpc_connection_send_message_with_reply_sync`，见`/tmp/oc-chan-r04-authorization-stack-20261106.txt:47`；这时尚未执行采样器。限定client PID57691/请求线程的authd日志显示共享凭据过期、UID501属于admin组、进入`system.privilege.admin`的`builtin:authenticate`，直到client超时取消才结束；证据`/tmp/oc-chan-r04-authorization-service-20261106.json`。没有证据证明认证框是否可见或用户为何未完成认证，不断言系统服务死锁，不重启共享认证服务或采集密码。
- 当前没有本任务长测/预验/认证进程运行，诊断owner57690/osascript57691已退出，私有socket、run夹具和开发实例无残留；临时诊断脚本已删除，JSON、原生stack及系统生成的sample日志保留。会话授权仍然有效，当前缺的是本机macOS系统认证成功回执。停止重复认证尝试，先完成本机认证，再运行同一冻结源码6分钟预验；只有预验通过才能新开24h。R-04仍未完成。


## 后续动作

1. 待本机可完成macOS系统认证时，从冻结源码`/private/tmp/oc-chan-r04-admin-source-h4AzW7`运行`node scripts/performance/run.mjs --mode smoke --scenario soak --sampler admin --seed 20261104`，可另给未使用的`--out`；不要重用两个失败目录。核对系统认证、实际应用采样、严格门限与退出清理，通过后才启动同源码24h。当前没有后台预验或24h服务，既往三轮时长不累计。
2. 个人应用已安装修复版并取得就绪回执，无需再次覆盖。系统通知授权当前denied；后续投递/点击验收需先具备允许权限。按已有授权补原生专项，真实注销/睡眠应避开正在进行的长测；未有实际回执不得勾选相关卡。
3. 真实睡眠/网络切换及16GiB硬件场景仍未验。Node启动前dyld fcntl等待的内核根因仍未解决，不把本轮成功启动当作该问题已修复。
4. 本轮已获master提交和GitHub推送授权，云端Q-01/S-05门禁以[master合并交接](2026-11-06-backlog-master-integration.md)的实际回执为准；D-01/O-01与D-02正式发布按用户范围延期，F-07不实施接口。
5. 管理员只读采样已获用户明确授权，不再询问同一权限；应用和驱动仍普通用户，系统认证由macOS处理。若认证框不出现或仍不完成，基于已留的AuthorizationCreate/authd证据继续定位，不绕过系统认证、不扩大到共享服务重启。新24h取得真实回执前R-04保持未完成，恢复时同步清单、todo与本交接。

## 恢复提示

继续OC Chan的37卡实施：arm64自用、F-07只调研，正式签名公证发布和多人试用延期。当前分支fix/oc-chan-r04-admin-sampler-20261106，保留全部并行改动。用户已明确授权本次专用管理员只读采样器，无需再问权限；Node/Electron保持普通用户。实现、真实64个ps读取、断链/owner退出/保留连接时身份检查均通过；缓存无效父身份授权漏洞已先失败后修复并独立复核，14项最新采样回归及9项CI检查适用。两次预验输出/tmp/oc-chan-r04-admin-preflight-20261106和/tmp/oc-chan-r04-admin-preflight-retry-20261106，均在采样握手前120秒超时，Electron/业务采样为零、清理通过。独立同文件复现的原生stack停在AuthorizationCreate，限定authd日志确认已有凭据过期、等待builtin:authenticate，证据/tmp/oc-chan-r04-authorization-{diagnostic,stack,service}-20261106.{json,txt}；认证框可见性未知。当前没有后台任务，不重复弹窗、不重启共享认证服务或索要密码。待本机能完成系统认证后，从/private/tmp/oc-chan-r04-admin-source-h4AzW7（196文件，摘要bd23450ba0da1e4920abfb81e03a3661a25a1b93cd2cd7c6c38357f0075f358d）运行--sampler admin的6分钟预验；通过后才能启动全新24h持久服务。三轮旧失败时长不累计，R-04不勾选。安装修复版已有就绪回执，通知denied/开关关闭，安装失败现场/Applications/.oc-chan-install-5ilb8S保留；原生、睡眠/网络、16GiB等缺口详见交接。未提交、推送、发布或再次安装。
