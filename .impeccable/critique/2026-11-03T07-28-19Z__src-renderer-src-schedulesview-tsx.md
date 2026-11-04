---
target: 定时任务页走查、技术检查和细节打磨
total_score: 29
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
target_identity: "file:/Users/zvf003/ZStack/oc-chan/src/renderer/src/SchedulesView.tsx"
target_fingerprint: "sha256:174f03f9c86465584336e3f7309041e5fe91736ceabfcd592ec2976a83b2127a"
target_path: /Users/zvf003/ZStack/oc-chan/src/renderer/src/SchedulesView.tsx
timestamp: 2026-11-03T07-28-19Z
slug: src-renderer-src-schedulesview-tsx
closed: true
---
⚠️ DEGRADED: single-context (runtime detector/browser checks performed by main; two isolated scout assessments have no browser/execution tools)

Target: src/renderer/src/SchedulesView.tsx. Mode: Operate. A: DesignReview; B: ScheduleAudit, isolated source assessments; A additionally inspected four real screenshots captured by main. Preserve existing green desktop tool visual system.

## 修改前体验评分

|启发式|分数 /4|证据|
|---|---:|---|
|状态可见|3|暂停时列表仍写每30秒更新|
|现实语言|3|个人来源与用户运行域需要区分|
|用户控制|3|统一清除仅在零结果出现|
|一致性|3|原生控件一致，恢复路径缺口|
|错误预防|4|只读界面，未知与停用分开|
|识别而非记忆|3|标签清楚，范围解释较晚|
|效率|2|四维组合有效，撤销条件偏繁琐|
|简洁与视觉|3|层级清楚，长计划阅读压力和小字号|
|错误恢复|3|保留快照、明确失败、提供重试|
|帮助|2|有来源说明，范围解释可提前|
|合计|29/40|Good|

技术源码评分：可访问性2、性能3、主题3、响应式3、实现一致性3，共14/20；不等于完整WCAG、VoiceOver或性能认证。

## 设计与检测证据

真实名称、执行计划、运行范围和状态构成四列主线，浅色绿色侧栏与深色绿色表面一致。默认1280x860、个人筛选、880x640和英文深色四张主代理实屏均被A独立查看；窄窗换行未见裁切。主代理实际复现英文Every month显示但搜索零结果、筛掉原行再关闭详情后activeElement为BODY、暂停提示与每30秒更新矛盾。

源码检测器返回[]。CDP检测全部1046任务状态：2098实例，包括2096条undersized-ui-text（4个表头、1046行来源、1046行状态）、1条coverage-note tiny-text warning、1条sampling-status small tiny-text advisory。实例数不是独立问题数；字体告警不是自动成立的WCAG违规。现有文字主题对比度的计算样本：浅色muted/white5.84、accent/selection4.75、warning/surface4.88；深色muted/surface7.10、accent/success6.37。源文件未发现目标特有硬编码颜色。

## 优先问题

- [P2] 英文显示与搜索脱节。SchedulesView.tsx:68-77 搜索原始中文字段，显示则用scheduleText/jobSource；language不在memo依赖。修复复用当前语言的显示格式化，保留真实任务名称。命令：polish。
- [P2] 详情原行被筛除以及清除按钮卸载后焦点丢失；结果计数缺polite status。components.tsx:26-29、SchedulesView.tsx:108-114。任务视图安排稳定搜索输入作为恢复位置，原行仍可见时保留原回焦；仅计数播报，时间戳和整表不进入live region。命令：polish。
- [P2] 有结果时缺统一清除、范围菜单混合来源与运行域。SchedulesView.tsx:85-90,109-112。移动既有清除到结果栏并保留默认重置语义，原生optgroup区分配置来源/运行范围。命令：clarify/polish。
- [P2] 暂停时列表仍宣称每30秒更新。SchedulesView.tsx:108。列表仅显示快照采样时间，暂停/错误由已有顶部统一呈现，不引入重复状态。命令：clarify/polish。
- [P2] 表头、任务来源和状态为10px。styles.css:81,90,97。局部修正定时任务表与覆盖说明，保留整体密度、字号偏好、深浅主题。命令：typeset/polish。

## 优点与认知负荷

只读与计数口径诚实；窄窗不隐藏核心控件；详情按需展开，错误保留上次快照。认知负荷低至中等：类型3项、范围4项、状态6项仅展开时可见。长重复计划增加阅读负担，但本轮保留完整语义与时区，不随意截断或重写采集器。

## Persona

Alex：多条件恢复需要逐项撤销；Jordan：个人配置不是当前用户的同义词；Sam：恢复焦点和结果播报有实际缺口，原生键盘及VoiceOver需区分验证状态。以上为针对本机只读观察流程的分析，不推及所有用户。

Questions skipped: 用户明确要求走查、技术检查、细节打磨一条龙，已授权修复以上局部问题；无需再次选择命令或确认相同范围。
