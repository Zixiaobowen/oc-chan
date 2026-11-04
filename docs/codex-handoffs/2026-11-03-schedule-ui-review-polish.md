# 定时任务页走查、技术检查与细节打磨 · 2026-11-03

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`fix/settings-accessibility-recovery`（本轮读取 `.git/HEAD` 确认）
- 用户目标：对刚完成的定时任务页做“走查 + 技术检查 + 细节打磨一条龙”；期间用户要求“继续”。
- 已完成：独立源码/视觉评审、实际界面问题复现、局部修复、定向运行验收、文档更新、普通应用启动。未提交、推送、安装到 Applications、签名、公证或发布。

## 评审方法与范围

使用 Impeccable 的 critique / audit / polish。已运行一次 `impeccable context --target src/renderer/src/SchedulesView.tsx`，不存在该视图的专属 surface brief，沿用 PRODUCT.md / DESIGN.md 的桌面 Operate 风格。

- A：`DesignReview`，独立源码 + 主代理提供的四张真实窗口截图，体验评分29/40。
- B：`ScheduleAudit`，独立源码审计，五维暂评分14/20。
- 两个 scout 没有 eval/browser/bash 接口，未自行操作窗口或运行检测器。A 完成后，主代理负责实窗操作和 detector。没有将这个执行边界包装成两代理独立运行验收。
- 评审快照：`.impeccable/critique/2026-11-03T07-28-19Z__src-renderer-src-schedulesview-tsx.md`，继承的五组优先问题已处理，使用保留的 snapshot_file 精确关闭。此目标首轮29/40，无历史趋势；未捏造修改后评分。
- `.impeccable/critique/ignore.md` 不存在。Electron CDP 路径没有启动 live-server 或注入浏览器 overlay。归档用临时正文已删除。

## 变更

### `src/renderer/src/SchedulesView.tsx`

- 搜索复用当前语言的 `scheduleText` / `jobSource`，memo 随语言变更；不再发生英文页面显示 Every month / OMP task 却搜不到的情况。真实任务名保留原文，筛选仍忽略大小写与首尾空白。
- 原生范围菜单以 optgroup 区分“按配置来源”和“按运行范围”，四个选项的实际筛选语义不变。
- 将既有清除操作移至结果栏；有结果、零结果、加载和失败期间均可清除非默认条件，恢复 scheduled/all/all/空查询并聚焦搜索框。
- 结果数量单独使用 polite、atomic 的 status；时间戳不加入播报。列表只标记“采样于”，不再与暂停状态冲突。
- 任务按钮暴露详情展开状态，选中行使用主题选择色；完整名称和来源可悬停查看。
- Esc 或关闭详情返回原任务；若原任务已被过滤或移出快照，返回搜索框。保留的详情明确解释任务不在当前筛选结果中。
- 共享 ScheduleTable 的概览调用不传 selectedId，因此没有错误的展开语义，继续导航到任务页。

### `src/renderer/src/styles.css`

- 定时任务表头、来源、状态默认辅助字号12px；筛选、结果栏、详情标签在最小字号偏好下不低于11px。
- 窄窗筛选组靠近排列并自然换行，避免 justify-content:space-between 把范围和状态推到两端。
- 结果栏换行、清除控件最小高度、选中状态、详情焦点环与覆盖说明字号；删除不再使用的 schedule-empty-actions。
- 复用语义主题变量，没有改全站调色、共享圆角或其他模块的布局约定。

### `src/renderer/src/App.tsx`

- 调度页接收已有 `samplingError`，包含首次桌面快照连接失败，而不只接收 schedules.error。
- 根因修复：首次快照失败后，单个 Agent / System 更新不能提前清除整体连接错误；收到三个分区，或完整快照/手动重试成功后恢复。每个分区自己的错误仍单独展示。
- 定时任务页从错误提示触发重试时，先将焦点放到稳定的搜索框，避免错误按钮卸载后焦点落到 BODY。

### 文档

README.md、DESIGN.md 已同步实际搜索、菜单分组、焦点、字号、状态播报和错误恢复规则。没有修改采集器、调度配置、任务权限、全局模型或其它项目代码。

## 实际运行检查

- 最终 `npm run package -- --config.directories.output=release/schedule-polish-final` 通过；包括 `tsc --noEmit`、原生辅助程序构建、Electron Vite 构建与 arm64 目录打包。
- 实际应用验证英文 Every month 匹配9条、英文来源 OMP task 匹配7条；逐条名称与未搜索前的显示文本结果对照。
- 有结果与零结果的清除均恢复默认条件与搜索焦点。
- 打开详情后焦点进入详情，按钮 aria-expanded 有效；筛掉原任务后关闭返回搜索；原任务仍在时 Esc 返回任务按钮。
- 原生控件的 Tab 顺序：任务范围 → 任务状态 → 搜索定时任务。这里通过 Electron/CDP 的可信键盘输入验证，不能替代 macOS 弹出菜单选值或 VoiceOver 朗读。
- Accessibility.getFullAXTree 证实结果 status 的 live=polite、atomic=true。时间戳不在该区域。
- 实际原生窗口内容区880×640、959/961/1119/1121×860、1280×860、2560×1320，以及1280×860的200%页面缩放（640×430 CSS视口）；核心筛选控件可达，无根页面横向溢出，个人/等待筛选的8项结果保留。
- 英文深色、大字号、880×640与200%缩放复验通过；最终最小字号的目标功能文字计算值均>=11px。后续仅修改App错误协调/重试焦点，CSS及任务视图未再变更，这些检查仍适用。
- 概览中的共享调度表实际显示4行，没有根溢出，aria-expanded为空，点击仍进入任务页。
- 隔离实例通过既有 monitor:changed IPC 注入首次加载、首次采集失败、保留快照失败，确认数量待确认/未知、旧数据保留和筛选不丢失；恢复真实快照。异常注入证明前端状态处理，不是制造真实系统权限故障。
- 首次桌面连接失败回归：临时使真实 monitor:snapshot handler 抛错，并在隔离实例延迟调度分区推送；页面显示“采集失败 · 数量未知 / 尚未取得调度数据”。观察到真实 agents、system 更新后错误仍保持。恢复原始 handler/send 后点击真实重试，实际采集恢复10项个人任务、错误消失、范围保留。
- 最终重试焦点回归：注入一次调度错误，点击重试，恢复10条个人任务且焦点仍在搜索框。
- 正常界面检查时 renderer errors 返回空。异常注入产生的明确测试错误不当作产品错误隐藏。
- 未新增永久测试（本视图没有现成renderer测试框架），没有运行全仓测试，也没有重复运行本轮未修改的采集器测试。最终行为以实际包中的上述场景作为回归证据。

## 检测器证据

- 修改前源码 `detect --json SchedulesView.tsx` 返回[]，没有把源码静态干净当作界面合格。
- 修改前 CDP 在“全部”1046行状态返回2098个实例：2096条 undersized-ui-text（4表头、1046来源、1046状态），1条coverage-note tiny-text warning，1条sampling-status tiny-text advisory。
- 修改后源码扫描 SchedulesView.tsx / App.tsx / styles.css：13条既有 design-system-radius advisory，均来自未改动的3/4/7/8/10px圆角，没有为消告警扩改设计系统或添加ignore。
- 修改后 CDP 在个人配置10行、中文浅色默认字号状态，只返回顶部采样说明11px的1条tiny-text advisory，没有warning。前后列表状态不同，不把原始告警数作同口径统计。
- 现有颜色的计算样本：浅色muted/white5.84、accent/selection4.75、warning/surface4.88；深色muted/surface7.10、accent/success6.37。不是全状态WCAG认证。
- 后续App两处错误协调/焦点逻辑改动没有改变检测器检查过的布局、颜色或字号，没有重复运行仍适用的detector。

## 原生输入限制与工具过程

- macOS原生下拉菜单选值未取得有效回执。早期同bundle旧实例/基线实例争抢激活；确认后正常退出用户旧版，并清理本轮基线进程，再验证精确目标PID。可信键盘事件已进入下拉框、:open也能为true，但OS菜单选值未得到成功回执；没有修改原生控件来迎合验收脚本。
- 普通交付实例的 System Events 能识别PID4754及AX属性，但AXWindows数量为0，访问window 1报-1719。临时将应用的AXManualAccessibility从false改为true仍为0；已恢复false。这项界限如实保留，未宣称VoiceOver或原生菜单键盘验收通过。
- 两次检查脚本字符串/方法签名错误已纠正，未作为产品问题修复。初次退出旧应用的JXA将零参terminate写成函数调用，虽然脚本报错，kqueue实际确认旧PID96375退出0；没有重复强杀用户应用。
- 本轮基线PID63369被inspector连接拖住退出，停止了自己创建的baseline服务；其余验证实例在app.quit之后显式关闭inspector并正常退出0。
- tgrep工具只能查询会话当前repo根目录，无法覆盖此绝对路径；LSP返回无可用语言服务，所以已用专用grep核对ScheduleTable和useDetails调用者。没有假称LSP引用检查成功。

## 普通应用交付

- 最终应用：`/Users/zvf003/ZStack/oc-chan/release/schedule-polish-final/mac-arm64/OC Chan.app`
- 服务：`occhan-schedule-polish-delivery`，PID4754；普通启动，无inspector、CDP、隔离profile参数，移除了工具环境NODE_OPTIONS。
- 普通启动完成后通过应用既有second-instance路径显式呈现主窗口。AppKit确认bundle正确、finishedLaunching=true、hidden=false、terminated=false；CoreGraphics主窗口17534 onScreen=true，1280×860。
- 原生交付截图：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/occhan-schedule-polish-yflg2mpu/schedule-polish-delivery.png`，已读取查看，显示正常概览。上述原生AX探查未改变页面或用户设置。
- 最终个人任务页截图：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15bf665f39d68c6a.webp`。
- 英文深色最小窗口截图：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15bf64dccd2b02b0.webp`。
- 截图和隔离profile在系统临时目录，不保证长期保留。所有本轮验证应用及browser接管已结束，只保留普通交付应用；未生成HTML回执。

## 后续动作与限制

1. 使用最终应用的“定时任务”页查看个人配置、状态组合和可随时清除的结果栏；真实任务数量随本机配置变化，不把本次10/8/2作为固定值。
2. 若继续做原生可访问性认证，先解决System Events/AXWindows为0的窗口可见性链路，再记录菜单键盘选值与VoiceOver实际朗读；不得将本轮Tab/Esc/AX树检查代替它们。
3. 需要提交、推送或安装时，分别取得对应授权，并保留共享工作区已有其他改动；不全量暂存、不覆盖运行中的.app。
4. 不执行、停用、删除或修改真实调度任务；不修改OMP全局模型、规则、聊天、日志、技能或其它项目。

## 恢复提示

继续 /Users/zvf003/ZStack/oc-chan 的 fix/settings-accessibility-recovery。用户要求定时任务页走查+技术检查+细节打磨，已经交付。改动集中 SchedulesView.tsx、styles.css、App.tsx 以及README/DESIGN。解决本地化搜索、统一清除、结果播报、详情/重试回焦、范围菜单分组、暂停文案、最小字号以及首次快照错误被其他采样提前清除。最终包 release/schedule-polish-final/mac-arm64/OC Chan.app，普通服务occhan-schedule-polish-delivery PID4754，原生窗口17534已onScreen并截图确认。类型检查/构建/打包和定向实窗场景通过，未跑全仓测试；macOS下拉菜单键盘选值与VoiceOver未通过验收，System Events可见进程但AXWindows=0，临时AXManualAccessibility已恢复。未提交、推送、安装或发布；不要重复已适用检查或扩大到调度执行/全局配置。
