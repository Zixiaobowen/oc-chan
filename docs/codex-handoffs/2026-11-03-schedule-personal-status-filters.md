# 定时任务个人配置与状态筛选 · 2026-11-03

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`fix/settings-accessibility-recovery`，本轮读取 `.git/HEAD` 确认。
- 用户目标：保留“当前用户 / 系统”运行范围，增加能排除 Apple 等后台任务的个人配置筛选；同时增加任务状态筛选。
- 状态：两项功能、定向检查、真实应用验收、文档及正常应用交付完成。没有提交、推送、安装到 Applications、签名、公证或发布。

## 实现与文件

- `src/shared/types.ts`：`ScheduledJob.origin` 为必填字段，区分 `personal / system / application / unknown`；没有兼容字段或迁移。
- `src/main/collectors/schedules.ts`：在采集时识别来源，缓存仅增加归类值，不缓存或向界面输出完整参数、环境或任务正文。OMP 元数据合并、Hermes 内部任务和当前用户 crontab 都提供明确个人来源。标准 launchd 配置依据受保护系统目录、Apple 名称、用户目录中的个人命名及实际脚本入口分类；应用包、Library 内应用脚本和 Hermes 调度器自身不纳入个人任务。只有运行时信息的非 Apple 服务保留未知来源。
- 个人命名使用用户 LaunchAgents 目录里的 `com.user.` / `local.`；个人脚本指向当前主目录、排除 Library、应用包及 node_modules。入口可以直接执行或经常见解释器执行；Python 支持不取参数的开关及 `--`，不把内联代码、选项值或任意后续参数里的路径当作入口。
- `src/main/collectors/schedules.test.ts`：更新相关必填契约，新增来源边界、应用排除、脚本参数和错误归类的回归覆盖。
- `src/renderer/src/SchedulesView.tsx`：范围新增“个人配置”，状态提供所有状态 / 运行中 / 等待触发 / 已停用 / 未加载 / 状态未知；与类型及搜索共同过滤。个人来源解释就近显示；空结果可清除全部条件并恢复默认定时任务视图。
- `src/renderer/src/styles.css`：仅为调度工具栏增加换行、宽度约束与空结果操作布局。
- `README.md`、`DESIGN.md`：同步筛选语义和可见性边界。
- `src/main/index.ts`、`src/preload/index.ts` 只用于核对 IPC 与启动行为，没有修改。保留共享工作区原有 Agent 筛选和设置修复。

## 判定边界

“当前用户”是运行域，并不表示用户创建；Apple LaunchAgents 同样在该域运行。macOS 没有每项 launchd 配置的创建者记录，“个人配置”是有依据的来源识别，不是创建者认证。不能确认的任务保留在所有范围；不把所有非 Apple 项目直接当作用户创建。状态严格跟随现有徽标：未知不当作停用，非零上次退出码不覆盖当前运行状态。

真实验收发现工具更新任务使用 `python3.11 -u -B <script>`，首版只检查紧邻解释器的参数而遗漏该任务。已修正入口解析并保留回归测试，最终包中该任务已进入个人配置。

## 实际检查

- 最终 `node --import tsx --test src/main/collectors/schedules.test.ts`：21/21 通过。脚本开关修正后重跑了这一个受影响文件。
- 最终 `npm run package -- --config.directories.output=release/schedule-filters`：通过，包含 TypeScript 检查、原生辅助程序构建、Electron Vite 构建和 arm64 目录打包。
- `impeccable detect --json --scope layout src/renderer/src/SchedulesView.tsx src/renderer/src/styles.css`：返回 `[]`。之后只修改采集端脚本解析，UI 源码未再改动。
- 未运行全仓测试。

## 真实应用验收

在最终包及独立 profile `/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/occhan-schedule-verify-ndrlhxsf` 中使用本机真实数据，未执行或修改任何定时任务。

- 总计 34 条定时任务，其中“当前用户”20 条，“个人配置”10 条：8 条等待触发、2 条已停用。个人列表包括 7 条 OMP 任务、1 条 Hermes 内部任务、工具更新及 GitHub issues 日报脚本；Apple 任务、GoogleUpdater 和 Hermes cron-tick 排除。这是验收快照，不是未来固定数量。
- 逐行比较真实快照和渲染名称/状态，36 组类型、范围、状态组合通过；包含未知状态无匹配的空结果。
- 大小写不敏感搜索、长搜索词空结果、清除类型/范围/状态/搜索通过。打开详情后改变状态筛选仍保留详情，关闭可正常返回。
- 实际原生窗口内容区：880×640、959/961/1119/1121×860、1280×860、1280×1320、2560×1320，以及全屏 2560×1440。筛选控件可见，没有根页面横向溢出，个人/等待筛选和8条结果保持。
- 原生 200% 页面缩放：1280×860 内容区对应640×430 CSS视口，控件可达、无根页面横向溢出。另在880×640下临时将文字变量加倍，随后恢复。
- 中文浅色与英文深色均查看过实际页面；长执行计划在表格内部换行。
- 在隔离实例通过既有 `monitor:changed` IPC 注入“加载中 / 首次失败 / 保留快照后失败”状态，验证数量未知、错误可见及筛选不丢失；随后恢复真实后端快照。此项证明界面状态处理，不是再次制造实际权限故障。
- 键盘试验中目标未稳定停留在下拉框，页面转至设置；没有取得任务状态下拉的有效原生键盘选择回执，不能声明键盘或 VoiceOver 验收通过。已恢复隔离设置与真实任务页面。连续物理拖动缩放、硬件多显示器及长时资源压力未验收。
- 一次 inspector 验收脚本因嵌套字符串转义产生 SyntaxError；已改用直接聚焦 helper。该错误来自验收注入脚本，未修改产品实现来隐藏它。

## 性能观察

相同本机配置，修改前/后各一次冷采集及五次缓存采集：前为1049条、后为1048条。冷采集567.87/620.45ms，缓存采集中位15.18/17.26ms，累计CPU483.81/508.73ms，进程RSS108101632/116998144B，采样时JS堆16427624/27070464B。后台服务及GC有波动，这些是短样本原始值，不能据此宣称内存或总体性能改善，也没有测出长时内存上限。

真实页面在相同34条定时任务上切换“所有范围 / 当前用户”16次，等待两帧后的P50前后均33.4ms，P95为37.5/35.3ms；渲染端最终代码与此测量时相同。此数据仅表示所测筛选交互，没有作为整机性能结论。

## 正常应用交付

- 本轮应用：`/Users/zvf003/ZStack/oc-chan/release/schedule-filters/mac-arm64/OC Chan.app`。
- 持久服务：`occhan-schedule-filter-delivery-v2`，PID `96375`。普通启动，没有 inspector、CDP 或隔离 profile 参数，移除了工具环境的 `NODE_OPTIONS`。
- 首次正常启动PID94556因旧版PID65763占用单实例锁而退出0；源码 `app.requestSingleInstanceLock()` 证实该退出路径。通过 AppKit 按PID及精确bundle路径正常退出旧版，用kqueue收到退出事件后启动新版，没有强制杀进程或改动单实例机制。
- 新版 AppKit 核对：正确bundle、finishedLaunching=true、hidden=false、terminated=false、activated=true。CoreGraphics主窗口14670在屏幕上，1280×860；原生截图显示真实监控概览。
- 交付截图：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/occhan-schedule-verify-ndrlhxsf/schedule-delivery.png`。个人筛选截图：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15bf4b061a08aba9.webp`。这些处于系统临时目录，不保证长期保留。
- 本轮基线、首次验收、最终验收应用及浏览器接管均已结束。现有正常用户设置未改写，没有安装或覆盖 Applications，也没有替换其他打包目录。

## 限制与下一步

中文沟通；保留用户和并行任务改动；只读观察任务，不创建、执行、停用或修改真实调度配置。不修改OMP模型、全局规则、聊天、技能或其他任务工作区。

1. 使用本轮应用进入“定时任务 → 范围 → 个人配置”，状态下拉可进一步查看等待触发或已停用任务。
2. 若出现新的个人脚本未被识别，先核对真实入口与来源证据，扩展通用解析及对应行为测试，不按具体任务ID强行放行。
3. 若后续补原生键盘、VoiceOver或物理拖动验收，先确认目标窗口和焦点，再记录实际回执；不将本轮未取得的回执写成通过。
4. 用户要求提交、安装或分发时再分别执行；先识别共享工作区其他改动，不全量暂存，不覆盖运行中的应用包。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan` 的 `fix/settings-accessibility-recovery`。本轮新增定时任务“个人配置”和状态组合筛选，来源由采集端必填origin字段提供。21项定向测试、最终打包、36组真实筛选、多尺寸及200%缩放检查通过；个人任务验收为10条（8等待、2停用）。正常服务 `occhan-schedule-filter-delivery-v2` 使用 `release/schedule-filters/mac-arm64/OC Chan.app`，旧版已正常退出释放单实例锁。未提交、推送、安装或发布。阅读本文边界，不将来源识别当作创建者认证，不重复仍适用的检查，保留其他会话改动。
