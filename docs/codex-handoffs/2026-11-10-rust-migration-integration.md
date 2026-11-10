# Rust / Tauri 迁移集成交接

仓库：`/Users/zixiaobowen/myProjects/oc-chan-rust-migration-20261109`。分支：`feat/rust-tauri-migration-20261109`。目标：完成全量迁移方案、独立评审和实施。方案、评审、实现及已授权的本地工程验收已完成；正式安装、签名发布和下列未覆盖场景不在已通过结论内。

原工作区与 `/Applications/OC Chan.app` 保留。用户已追加授权：提交并推送当前迁移分支到GitHub；本次不包含合并main、发布、部署或替换正式应用。原有独立实现与无头验收授权不扩大到新系统权限、可见开发窗口、其他任务资源或源码worktree清理。保留用户改动、源码基准和全部失败原始证据。

Git发布范围为迁移源码、本轮文档及HTML直接引用的17份最终验收回执（含截图，合计2,011,064字节）。原始夹具、数据库、逐条采样、其他截图及探针构建输出按`.gitignore`保留本地；14项旧任务交接文件及改动不纳入本次提交。推送目标为`origin/feat/rust-tauri-migration-20261109`，提交和推送结果以Git记录及GitHub分支为准。

## 实现与关键文件

- 生产后台和桌面宿主已切换为 Rust / Tauri；保留 React、React Flow、Three.js 和必要的 Swift / Objective-C 平台实现。Electron、Node、preload、N-API及旧CJS插件生产路径已退役。
- 核心、公开SDK、采集、历史/事件/通知、诊断、插件市场、更新与安装实现位于 `crates/oc-core/`、`crates/oc-plugin-sdk/`、`crates/oc-installer/`、`src-tauri/` 和 `plugins/system-monitor/`。系统监控仍独立安装，默认未装；资源上限和取消/排空契约未放宽。
- 最终集成修复：调度目录使用稳定有界来源ID；plist转换固定4槽且提交顺序不变；桌面错误保留有界聚合原因；IPC业务请求最多12个，共享16个总槽，留出控制请求容量，修复突发后ACK失败导致连接持续不可用的问题。
- 开发实例通过真实ad-hoc `.app`启动，启动/恢复均校验身份、资源和签名；无头实例不抢焦点。隐藏WKWebView采用显式可取消的一次性绘制调度，普通窗口仍用原生rAF，不把布局刷新冒充动画帧。
- 本轮重点修改/调查了 `src-tauri/acceptance/host.rs`、宿主IPC准入、`src/renderer/src/desktop-api.ts`、渲染调度、`scripts/build-app.mjs`、`scripts/develop.mjs`、`scripts/local-app-lifecycle.mjs`、smoke与performance脚本。方案、契约、评审和源快照在 `docs/rust-migration/`；README、工程规则及架构/开发/发布/性能文档已随实现更新。
- 基准提交为 `112d1d03f33373b96f3edc1898631149f030507e`，用户改动冻结记录见 `source-snapshot.json`。外部Electron对照工作区为 `/Users/zixiaobowen/myProjects/oc-chan-baseline-rust-compare-20261110`，已应用冻结的7个renderer源/测试文件；不自动删除它。

## 已运行的验证

- Rust核心早期195个唯一行为通过，随后两项真实市场专测通过；宿主23项、SDK/系统插件26项、安装器定向检查及其他工作区模块检查均已有通过记录。安装器真实子进程helper的一项ignored检查未执行，不能称所有Rust测试全部通过。
- 最终受影响路径：调度/空HOME/诊断17项、IPC准入2项通过；`npm run typecheck`、`npm run test:frontend`49项通过。真实桌面错误函数8项临时边界检查通过，覆盖百万重复引用、Unicode字节、深度和节点上限。
- 发布/安装工具定向检查212项通过；后续开发bundle、生命周期、包检查50项通过。性能工具44项、最新measurement检查4项通过。以上命令存在交叠，不相加为独立覆盖总数；未为收尾重跑无关测试。
- 当前依赖审计通过：`evidence/dependency-review-20261110-3.json`中npm/Rust漏洞findings及errors均为空，311个目标crate许可核验通过。Cargo.lock SHA256为 `42b59dfdc630395a24833ba82de5c9d0420297701ff8ffe4db87077cd4a617f8`。保留 `proc-macro-error` 未维护、`glib` unsound的informational warnings；不是“无任何告警”。
- 最终命令 `npm run smoke:renderer -- --scenario all --out docs/rust-migration/evidence/full-20261110-verify-18`通过，`complete=true`、`errors=[]`。覆盖真实IPC、导航边界、市场、2D/3D、历史/事件、通知设置、重启持久化和损坏设置恢复；53张实际截图及清理回执保留。夹具进程/目录已退出回收，实例U4ve1C已删除。
- `performance-stress-20261110-7/result.json`完整通过：100并发刷新中12成功、88明确拒绝，随后单次刷新直接恢复；200历史请求中199被替换取消，最终真实页面可读。128/500节点实际3D绘制，2000节点分配前拒绝并验证恢复，2D实际分页最多200节点；退出documents、requests和当前全局预留全部归零。
- `performance-soak-20261110-3/result.json`完整通过，实际负载362.90秒。两个稳定段合计10,144事件全链路提交；160条真实execution生成320个新事件，分页与去重通过；退出资源归零。不是24小时常驻证明。
- 最终启动/空闲/日常顺序对照在 `evidence/comparisons-20261110-final/{startup,idle,daily}.json`，每组先Electron后Rust，双方均complete。同夹具、设置、CSS视口和负载，日常双方256事件完整提交。生成证据在源码枚举前排除，8192项预算未改，失败清单记录保留。
- 性能数值与口径见 `docs/performance-baseline.md`。Rust独立开发构建约51秒，启动计时起点与驱动开销不同；CPU区间和WK/XPC归属存在缺口，不宣称整体性能或完整应用内存改善。实测设备为Apple M5 Max、18逻辑核、128GiB、macOS27.2、Node22.23.4。

## 最终生产产物

buildId：`add4d512-c253-4c87-96d4-40730cdc4a54`。产物位于 `release/tauri/add4d512-c253-4c87-96d4-40730cdc4a54/`；检查及清理回执位于 `docs/rust-migration/evidence/release-20261110-5/`。

| 产物 | 实测字节 |
| --- | ---: |
| 应用目录（临时副本已回收） | 29,224,362 |
| OC-Chan-0.1.0-mac-arm64.zip | 11,431,405 |
| OC-Chan-0.1.0-mac-arm64.dmg | 11,569,511 |

生产feature仅 `custom-protocol`，311个Rust依赖、580份许可文件、架构、资源预算及ad-hoc签名均已核验。生产包已检查，未替换正式应用运行；没有Developer ID签名、公证或公开在线更新验证。构建保留Cargo配置弃用、未使用函数/import及Vite警告。最终证据应使用release-5与full-verify-18，不用较早通过记录代替。

## 清理、展示与未覆盖范围

- 本次生产临时 `.app`已通过归属入口注销、删除，ZIP/DMG保留。盘点时开发实例及release目录未发现OC Chan.app副本，命令行范围内无迁移工作区进程。正式 `/Applications/OC Chan.app`及其PID99645、99650、99651、99654保留；这是盘点时刻的记录，后续操作必须重新核对身份。
- 五个早期失败目录明确保留：`3dLeVO`触发许可证嵌套src保护，`1f4M2Y`、`nDNSNx`、`K0ABJF`、`sx0YYN`缺匹配stopped凭证。见 `cleanup-20261110-2.json`与 `delivery-lifecycle-20261110-5.json`。未伪造排空回执或绕过保护。
- 最终HTML为 `docs/rust-migration/implementation.html`。绑定当前shell实测pane9723805958155，复用浏览器块50934017163287并固定右侧；最后shown=true、driven=false。本地文件链接与页内锚点有效，原生CLI验证了主题切换、目录跳转及324px窄页无横向溢出，并保留实际截图。
- Eval浏览器接口即使指定原生Tern及上述block仍返回no_window。原生CLI宽屏设置报告1280×860，但DOM仍324×206、截图325×207；宽屏复验未通过，未当作宽屏证据。异常已报工具QA；同一页面已恢复右侧并释放接管，没有切到外部浏览器。详细回执为 `receipt-native-final-20261110-5.json`。
- 未覆盖：真实可见窗口的Dock、托盘、焦点、连续缩放、玻璃材质、VoiceOver及物理60/120Hz动效；系统授权交互与通知实际投递；正式安装和签名更新；24小时、睡眠/网络切换、16GiB及其他硬件/macOS。

## 后续动作

以下仅在新增授权或所需条件具备后执行，不表示本轮仍有后台任务：

1. 如需合入main，先审阅迁移分支与最新main差异，保留原工作区用户改动；仅在取得合并授权后执行。
2. 用户明确要求可见窗口验收后，覆盖上述原生界面、辅助功能及物理动效场景，记录硬件和刷新率。
3. 具备Developer ID、公证及更新源条件后，验收生产安装、升级、取消和失败恢复；安装授权不能由本次本地构建推导。
4. 扩大耐久与硬件验证时，复用有界性能工具、同负载顺序比较及完整进程归属记录，保留缺口。
5. 处理五个失败目录前重新取得真实归属、退出和清理依据；需要越过现有保护时另行明确授权，不自动删除源码worktree。

恢复提示：进入 `/Users/zixiaobowen/myProjects/oc-chan-rust-migration-20261109` 的 `feat/rust-tauri-migration-20261109`。方案、评审、实现及本地工程验收已结束；用户已追加授权commit并push当前分支，先以本地Git及GitHub分支核对发布状态。最终证据是full-verify-18、stress-7、soak-3、comparisons-final及release-5。不得重跑已适用检查、恢复旧Electron兼容路径或将无头结果当原生可见/正式安装验收。保留原工作区、正式应用、五个拒绝清理目录、全部失败原始证据和源码基准，不把旧任务交接改动纳入提交。根据用户新增目标继续，不依赖旧Eval变量，也不自动合并main、发布或部署。
