# Stats 对照与托盘系统监控 · 2026-11-04

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`main`；GitHub 提交阶段沿用现有开发分支，不切换共享工作区分支。
- 目标：对比本机 Stats，借鉴有价值的系统监控细节；菜单栏 OC Chan 下拉面板支持多个监控项同时展示，默认显示全部摘要，并可自由勾选组合。
- 状态：代码、定向测试、完整构建及原生 Electron 集成 smoke 已通过；未覆盖 `/Applications/OC Chan.app`，未打包发布。

## 已实现

- 托盘默认同时显示 Agent／任务计数和 CPU、内存、磁盘、网络摘要；“显示内容”展开原生复选框，每项指标独立展开详情，可同时展开多个。窗口内容区为 380×560；头部与底部打开主界面按钮固定，选择区与指标独立滚动，200% 缩放后仍可达。
- CPU、内存显示当前值、最多 60 点真实历史及各自前五进程；内存展示 App／Wired／Compressed 与 Swap。磁盘只显示数据卷空间，不声称是磁盘 I/O。
- 网络展示默认接口名、上下行即时速率和双线趋势；接收为实线，发送为蓝灰虚线；缺失样本断线，不按零值补齐。无数据与采集错误保持可见。
- 主窗口同步增加内存分项、网络趋势与 CPU／RSS 排序选择。内存前十独立从完整受限 ps 输出选择，不是 CPU 前十重排。
- 采集复用已有 vm_stat、ps、networkStats，无新运行时依赖、采集进程或永久计时器。进程采集仍为 4 秒、4 MiB 输出预算；两个榜各 10 条，历史 60 点。
- `oc-chan.tray-panels` 保存至多五项枚举组成的 JSON 数组于当前 profile 的 localStorage；支持全取消，解析前检查长度不超过 128 字符。无效值、重复项和读写失败明确提示，重新勾选可保存有效组合。旧单项存储路径不再读取或兼容。隐藏时解绑面板订阅；显示时获取新快照，后台继续采样。
- 主监控容器宽度 ≤620 CSS px 时单列，使用更高选择器优先级避免旧全局媒体规则覆盖。网络发送线同样修正了级联覆盖。

## Stats 对照证据

本机 `/Applications/Stats.app/Contents/Info.plist`：3.0.24，build 853。安装 Frameworks 包含 CPU、RAM、Disk、Net、GPU、Sensors、Battery、Bluetooth、Clock、Remote。

主代理用 `plutil -convert json -o -` 结构化读取本机 Stats 偏好，确认 CPU、RAM、Disk、Network、GPU、Sensors 的 state 为 true；Battery、Bluetooth 为 false。CPU/RAM/Disk widget 为 mini，Network 为 speed。仅输出这些范围内字段。

本机 `en.lproj/Localizable.strings` 经 plutil 解码，确认 Usage history、Top processes、Popup、App/Wired/Compressed/Swap、Network interface、Read / Write history 文案。借鉴模块化查看、历史与分项、资源排行及接口归属说明，未复制上游代码或素材。

边界：Stats 的 System Events AX 枚举在 activate 前后均返回 0 menu bars、0 windows。不能声称已逐面板实测 Stats，也未把共用 Top processes 文案当作其 RAM 排名算法证据。GPU、温度、风扇、电池、蓝牙、磁盘 I/O、memory pressure、长时历史不属于本次已实现能力。官方参考：https://github.com/exelban/stats/blob/master/README.md 。

## 文件

- `src/main/collectors/system.ts`、`system.test.ts`
- `src/shared/types.ts` 中 SystemSnapshot 的 5 个新增字段
- `src/main/index.ts` 仅托盘宽高 380×560
- `src/renderer/src/TrayView.tsx`、`SystemView.tsx`
- 新增 `src/renderer/src/SystemMetrics.tsx`、`system-metrics.css`、`tray.css`
- `README.md`、`DESIGN.md` 与本交接

初始工作区已有侧栏、安装 hook、README/DESIGN/App/styles/package 等改动；过程中其它任务同时实现主题与任务执行历史。均保留；未撤销、全量暂存或替它们改实现。当前 main index、shared types、文档包含混合改动，后续提交须按改动块处理。

## 首轮基础指标验证（单选交互已替换）

- `node_modules/.bin/tsx --test src/main/collectors/system.test.ts src/main/monitor.test.ts`：9/9 通过。未跑全仓测试。
- `npm run build`：最终共享工作区通过 TypeScript、原生 helper、Electron Vite 主进程/preload/renderer 构建。
- 集成中曾因其它任务缺失 themes、schedule-history、hermes-history 与 API 未接齐失败；未掩盖错误。先在 `/tmp/oc-stats-native.umTndk` 用提交 `9fafc1539e943c6bf4ec5b82fd5aa3de829fbc02` 加本次改动验收；其它文件就绪后完整工作区构建通过，并启动最终工作区构建完成集成 smoke。
- Impeccable detector 对本次 5 个 UI 源文件返回 `[]`。未改动全局视觉体系。
- 原生 Electron 使用隔离 profile `/tmp/oc-stats-review-20261104`、CDP 9369、inspector 9239；未改个人设置。
- 已验证：五项切换、关闭/打开、reload、完整应用重启后保留 network；打开主界面按钮隐藏托盘并显示主窗口；主窗口内存榜 10 行；数据分项加和等于 memoryUsed；默认接口 en0。
- 主窗口内容区 1280×860、880×640，容器 619px/621px 分别为单列/双列；原生全屏内容区 2560×1440。尺寸变化保持内存排序。
- 主窗口 200% 为 440×320 CSS px，托盘 200% 为 190×280 CSS px；英文、深色、15px 大字号、长主机名/错误、缺失网络速率及空样本已检查。没有根节点横向溢出。错误/空态通过明确标识的临时 IPC 注入，不冒充现场真实故障。
- 运行时 reduced-motion 开启后控件仍可切换；没有新增入场或循环动画。托盘刷新前后 scrollTop 均 100，选项保持 memory。主/托盘浏览器 errors 为空。
- 键盘验证限制：原生 select 可以展开并取得焦点，但 CDP/osascript 的方向键尝试未稳定改变所选项，部分尝试失去前台焦点。不能声称已通过 macOS 原生方向键选项切换；未据此修改共享原生 select。

## 首轮资源与性能

硬件 Apple M4 Max / 128 GiB，主显示器 SAMSUNG 2560×1440 逻辑分辨率、2×缩放、59.94Hz。其它本机任务持续运行。

- 系统手动 refresh 六次：基线 42.1–50.8ms，最终 40.8–48.6ms。短时现场结果，不宣称加速。
- Electron 常驻五进程 RSS 采样峰值：基线 757232 KiB；多次 reload/放大/错误注入后的最终采样 884704 KiB；显式 GC 后回到 760400 KiB。两次进程寿命/操作历史不同，不能把峰值差当作功能常驻增量，也不将回收结果当作长期无泄漏证明。
- 40 次 hide/show 与五种面板切换约 7 秒；ps 200ms 采样覆盖整个应用后代树，最多 10 个进程，观察峰值 848848 KiB（约 829 MiB）。50 个同时发起的 system refresh 约 53.8ms 完成，无错误，history=60、CPU rows=10、memory rows=10。
- 托盘 GC 后 document=1；jsEventListeners 155→155，后续采样 154，没有单调增长证据。节点数受不同面板和 React 未提交/保留树影响，不能用这些计数宣称严格节点恒定。
- 4,194,283 字节、94,156 条合成 ps 记录连续解析 20 轮，约 486.8ms；两榜始终各 10，RSS 最大进程和 CPU 最大值断言通过。独立压力进程 maxRSS 144608 KiB，无 OOM。临时脚本已删除。
- 未验证：长时运行/插件反复启停、其它硬件/120Hz、原生 Split View 配对、VoiceOver、真实菜单栏图标物理点击、已安装 app、新主题全量组合。未新增插件生命周期；不能将本轮短测当作完整 OOM 验收。

证据目录：`.impeccable/review/stats-tray-2026-11-04/`，含 `validation.json`、默认/窄窗/200%/英文深色/排行/最终集成/全屏截图。临时隔离源码位于 `/tmp/oc-stats-native.umTndk`，仅供验证，不是另一个开发分支。

## 后续修正：多指标同时展示

- 用户进一步明确需要同时看多个指标。修改仅涉及 `TrayView.tsx`、`tray.css` 及本轮文档，没有新增采集器、依赖、计时器或采集请求。
- 指标摘要始终可见；详情折叠时不创建图表和进程榜。通过稳定的指标 key 保持各项独立展开状态。复选组合替代旧互斥下拉框，首屏默认显示四项系统指标与 Agent／任务计数。
- `npm run typecheck`、`npm run build` 通过；之后仅修改托盘 CSS，最终 `node_modules/.bin/electron-vite build` 再次通过。未重跑未改动的采集器测试或全仓测试。
- 无头真实 Electron 渲染验收：多项同显、CPU／内存同时展开、四项详情同时展开、复选框空格操作、保存／reload、全取消空态均通过。无效组合与超过 128 字符的存储值显示明确错误，重新勾选后错误消除。无头阶段仅模拟 document visibility 以启动托盘订阅，数据仍来自真实 IPC 与采集。
- 200% 验收发现网络读屏标签的绝对定位使根页面额外纵向滚动；将 `.tray-content` 设为定位容器后，根页面高度与视口一致，只在指标内容区滚动。
- 原生验收使用 `npm run dev:window -- --inspect` 创建的独立实例，实际托盘内容区 380×560。默认四项同显，复选框键盘空格、CPU／内存同时展开、Escape 隐藏、重新显示组合与详情保留、reload 恢复组合均通过。系统刷新前后 scrollTop 均 374.5，memory 摘要保持焦点；关闭再打开会回到内容顶部，未声称滚动位置跨关闭保留。
- 原生英文／深色／大字号下，在 281×415、279×411、190×280 CSS px 验证了窄布局断点两侧与 200% 放大；根页面和内容区均无横向溢出，底部打开主界面按钮可达。运行时 reduced-motion 开启后，连续 20 次展开／收起正确回到折叠状态，详情节点释放。打开主界面操作实际显示主窗口并隐藏托盘。浏览器 errors 为空。
- 相同无头实例、相同采集负载，每场景采样 15 秒、间隔 1 秒：仅 CPU 摘要的应用后代树采样 RSS 峰值 733.98 MiB、Electron 进程平均 CPU 合计 0.672%；全部摘要为 733.19 MiB / 0.683%；全部详情展开为 728.73 MiB / 0.839%。这是单项／多项同实例短时对照，不是旧代码与新代码的严格基准，也不证明长期无泄漏或性能提升。
- 证据：同目录下 `multi-tray-validation.json`、`multi-tray-native-default.png`、`multi-tray-native-selection.png`、`multi-tray-native-200-en-dark.png`。未验证物理菜单栏点击、VoiceOver、长时运行、其它硬件及已安装应用；本轮没有修改主窗口布局或插件生命周期。
- 无头实例由本任务主动 SIGTERM 结束，退出码 143，启动器日志确认清理 `.dev-instances/instance-Kuoe5d`；原生实例正常退出码 0，并清理 `.dev-instances/instance-ovrijz`。两个 browser 接管均已释放，其他任务实例保留。以上实现验收阶段未提交、推送、安装或发布；后续 GitHub 交付范围见下节。

## 下一步与恢复

1. 用户若授权本机更新，再使用当前构建打包并覆盖 `/Applications/OC Chan.app`，核验个人设置未变与安装后实际托盘。
2. 在安装版中补验多选组合的完整应用重启、物理菜单栏点击与 VoiceOver；主窗口的 Split View 保留为首轮未覆盖项。
3. 用户若要 GPU/温度/风扇/磁盘 I/O，先按公开插件契约落实硬件数据源及资源预算，不能用本次容量/CPU读数代替。
4. 提交时保留其它任务在 main index/shared types/README/DESIGN 的改动，按用户授权处理；本次未提交、推送、安装或发布。

恢复提示：继续 `/Users/zvf003/ZStack/oc-chan` 的 Stats 对照和托盘指标任务。当前最终交互是默认同时展示四项系统摘要，通过“显示内容”复选组合，各项详情可同时展开；旧单选界面已替换。首轮 9 项采集相关测试通过，后续多选改动已通过类型检查、构建、真实无头与原生 Electron 交互验收；详情、资源采样和限制见本交接。当前分支 main，工作区有主题、任务历史、侧栏和安装 hook 的并行改动，勿覆盖。未更新已安装 OC Chan，后续依据用户新授权操作，不重复已通过且适用的验证。

## 首轮独立复核与收尾

- 采集正确性 reviewer 完整对照指定源码和差异，结论 correct，未发现本次引入的确定问题；未自行执行测试。
- UI reviewer 检查九张指定截图、相关源码与 craft-floor，结论 ship，未发现合入前必修项。原生键盘、VoiceOver、长时压力等限制继续保留，未被静态复核消除。
- 基线、隔离功能、最终集成三个验收进程均正常退出，工具回执 exit code 0。主窗口与托盘 browser 接管均已释放，无本任务后台验收应用继续占用资源。

## GitHub 提交阶段

- 用户明确要求“提交合并到 github”。操作前本地 `main` 与 `origin/main` 都是 `5a658e3`，无分歧；GitHub 默认分支仍为 `master`。沿用当前开发分支，将本次功能直接提交并推送到 `main`，不变更默认分支。
- 仅提交本任务的系统采集、内存分项与独立排行、网络趋势、托盘多项展示及相关文档。`src/main/index.ts` 只包含托盘尺寸改动，`src/shared/types.ts` 只包含系统指标字段，README／DESIGN 按内容拆分。侧栏、任务历史、无头开发与本机安装 hook 等并行改动保留在工作区。
- `pre-push` 当前会执行本机覆盖安装。本次授权范围为 GitHub 提交，使用单次 Git 配置跳过安装 hook，不修改持久配置，不覆盖 `/Applications/OC Chan.app`。提交身份使用 `bowen.sun <bowen.sun@zstack.io>`。
- 本节记录提交范围与验证上下文；实际提交 SHA、远程接收与 Actions 状态以本轮 Git／GitHub 返回和最终交付为准。

## 默认分支合并阶段

- 功能提交 `d163aa17814fdbe62c451b18e1d2f124169578dc` 已推送并从远程 `refs/heads/main` 读回。独立提交快照 `npm run build` 通过，系统／Monitor 9 项测试和设置／拓扑 24 项测试均通过。
- 核对工作流后确认 CI 仅监听默认分支 master，因此继续创建 PR #2，使用固定提交的 `feat/system-tray-metrics` 分支合入 master。完整范围为 main 上已有的拓扑、主题和本次监控三个提交，共 30 个文件；Git 原生差异与 GitHub 文件列表完全一致。
- 首个 PR 构建 `41815365370` 的 macOS arm64 与 x64 均通过，DMG／ZIP、应用架构、校验和与产物上传完成。拓扑独立复核未发现阻断；主题复核发现跨明暗模式的保存错误隐藏，已在 `SettingsView.tsx` 修复并完成双向实际回归，详见主题交接。修复后的提交须重新通过 PR 构建后才执行合并，不把旧 head 的通过记录当作最终通过。
