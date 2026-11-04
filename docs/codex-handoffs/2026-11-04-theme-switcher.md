# 设置主题切换 · 2026-11-04

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`main`；实现阶段未切分支。用户随后授权 commit 并 push 到 GitHub，交付范围为本次主题功能及文档。
- 用户目标：设置新增主题切换，可参考 Tern settings。
- 状态：源码、定向测试、构建和独立 macOS Electron 窗口验收完成。未打包安装，未覆盖 `/Applications/OC Chan.app`。
- Git 交付：账号已回读为 `Zixiaobowen`，远程为 `https://github.com/Zixiaobowen/oc-chan.git`。共享文件按主题改动块提交，保留其它任务的未提交内容；本次推送单次禁用会覆盖本机应用的 pre-push hook，不修改其持久配置。推送结果以 Git 回执和 GitHub 远程提交回读为准。

## 实现

- 在外观下增加“主题”行，六套配色：OC Chan、GitHub、Nord、Catppuccin、Solarized、Gruvbox，每套均有浅深版本。
- 实际观察本机 Tern 0.9.11（f93bb18）独立实例的 Settings → Appearance：配色缩略卡片、hover 整窗预览、click 保存、明暗分别记住。原参考截图 `/tmp/oc-chan-theme-reference-shots/serve/themes.png`。只借鉴交互和展示方式，没有复制 Tern 的完整主题库。
- 鼠标悬停、键盘聚焦预览主窗口；点击、原生方向键或空格选择并保存。Esc、离开选择区、失焦、隐藏、离开设置页或改变明暗模式取消未保存预览。预览不写文件，不广播托盘。
- `lightTheme` / `darkTheme` 独立持久化，默认均 `oc-chan`；系统明暗信号决定使用哪一套。保存后主窗口和托盘同步使用配色，原生窗口背景也匹配。
- `src/shared/themes.ts` 静态保存所有语义颜色；主进程和 renderer 共用。原默认颜色逐项保留，其余是命名主题的界面适配。无新依赖、后台任务、缓存或长期动画；预览监听随生命周期释放。
- 持久文件统一表示经过验证的用户覆盖项，读取时合并应用默认值。删除 `validateSettings` 的 partial 参数和“文件必须含全部字段”约束；未知键、显式非法值、损坏 JSON 和 IO 错误仍拒绝。不包含旧字段映射、版本分支或迁移脚本。
- 复用现有保存队列、原子替换、原生回滚、错误就近展示和重试路径。失败时恢复已保存配色，避免预览掩盖失败。
- 卡片默认三列，设置容器 ≤420px 两列、≤280px 一列。原生单选框提供名称、选择状态和键盘语义；没有新增颜色或入场动画。

## 文件范围

新增：
- `src/shared/themes.ts`
- `src/renderer/src/ThemePicker.tsx`

修改：
- `src/shared/settings.ts`
- `src/main/settings.ts`
- `src/main/settings.test.ts`
- `src/main/index.ts`：仅主题导入及窗口背景取色链路
- `src/renderer/src/settings.tsx`
- `src/renderer/src/SettingsView.tsx`
- `src/renderer/src/settings.css`
- `src/renderer/src/tokens.css`
- `README.md`、`DESIGN.md`、`PRODUCT.md`、本交接

工作区同时有侧栏、安装脚本、定时任务历史和托盘方面的改动；这些不属于本任务，已保留。期间主进程和文档由并行任务继续更新，不能按整文件回退或全量暂存。

## 实际验证

- `node_modules/.bin/tsx --test src/main/settings.test.ts`：10/10 通过。覆盖合法/非法主题、有效覆盖项、并发独立保存、重启读取、空间不足回滚与重试等行为。未运行全仓测试。
- 主题相关 renderer、shared、settings、desktop-settings 的严格定向 TypeScript 检查通过。
- 最终 `npm run build` 通过：TypeScript、原生 helper、主进程/preload/renderer 构建。首轮曾被并行任务历史功能的 Promise.withResolvers 与 optional monitor 类型错误阻断；后续该工作区错误已消失，最终构建成功。未将首次失败报告为通过，也没有自行修改这些无关模块。
- 静态对比度计算：6 主题 × 浅深 × 26 对文字/背景，共312对，全部 ≥4.5:1，最低4.5322。包括正文、辅助、强调文字在常见底色和选择态，以及状态文字和对应状态底色、on-accent/accent。
- Impeccable detect 执行一次，仅3条 advisory：缩略图3px和微小色块2px圆角未在设计表内。已将这两种有意的缩略图几何值写入 DESIGN.md；没有把它们改成控件尺寸，也未重复扫描。
- 实际运行命令：`env -u NODE_OPTIONS node_modules/.bin/electron out/main/index.js --user-data-dir=/tmp/oc-chan-theme-review-20261104 --remote-debugging-port=<9374/9375/9376> --inspect=<9244/9245/9246>`。原生 profile 回读为 `/private/tmp/oc-chan-theme-review-20261104`。三次均独立配置，无实际个人配置写入。
- 六套浅/深共12种配色逐一点击保存，断言实际CSS变量和持久设置正确。
- 验证悬停不写设置、离开恢复、Esc恢复、键盘方向键/空格、隐藏取消、系统明暗事件按对应保存值切换。首轮发现“仅hover未focus时Esc未取消”，已改为选择器生命周期内的 window keydown 监听，之后复测通过。
- 真实保存失败：将独立profile目录暂时设为不可写，点击主题触发权限错误，原配色与磁盘设置保持；恢复目录权限后点击“重试这项修改”成功。长诊断展开及200%放大未产生横向溢出。
- 主窗口与托盘的DOM配色、CSS背景、BrowserWindow原生背景三者一致。正常退出后再次启动，浅色GitHub、深色Catppuccin成功恢复。
- 实际内容区1280×860、880×640、1024×640；设置容器559/561px覆盖行布局断点，419/421px覆盖2/3列断点，279/281px覆盖1/2列断点。200%时880×640对应CSS440×320、devicePixelRatio4；额外300%用于1/2列边界。所有根节点和主题网格无横向溢出。
- 11个原生窗口宽度步骤880→1280通过；实际原生全屏CSS2560×1440可选择主题。未进行macOS两应用原生Split View配对，半屏宽度检查不算Split View验收。
- 中英文、15px字号、原生单选键盘、运行时 prefers-reduced-motion:reduce（matchMedia回读true后方向键切换）通过。六个主页面均使用保存主题，未发现页面根节点横向溢出；浏览器异常记录为空。
- 测试窗口后台时rAF/部分浏览器操作曾超时，使用System Events呈现真实PID后继续；高倍缩放最后用主进程executeJavaScript回读实际CSS视口。此前未等窗口尺寸落定的采样已由等待后的数据替换，不能将它当作响应式验收。

## 性能与资源证据边界

硬件：Mac Studio M4 Max、128GB、SAMSUNG显示器约59.94Hz、缩放2。相同1280×860设置页，在真实采集后台下进行12次明暗切换，计时包括保存和两次rAF。

- 修改前/最终切换中位值：50.0 / 50.1ms；样本最大值110.4 / 82.5ms。
- Electron五进程前后采样RSS最大合计：811888 / 789168 KiB；采样CPU合计约4.95% / 5.65%。这是端点采样，不是完整应用树峰值；现场存在其它任务与不同采集内容，不能据此宣称性能提升或长期内存上界。
- 60次主题hover突发约1.536秒；堆采样约5.2–7.2MB，显式GC后约3.9MB。GC前后DOM监听器1129→185、document保持1。监听器减少包含旧页面资源回收，正确结论仅为此短测未观察到持续累积。
- 未测启动时间、120Hz硬件、真实触控屏、VoiceOver实际朗读、长时间运行或OOM压力；新功能固定6张卡片、1个预览值和可释放监听器，不引入随输入增长的数据结构。没有用此短测声称整体应用无OOM。

证据目录：`.impeccable/review/themes-2026-11-04/`
- `validation.json`：场景、原始性能采样、尺寸与资源记录。
- `light.png`：Nord浅色设置。
- `dark.png`：最终重启后Catppuccin深色设置。
- `zoom-200.png`：英文、较大字号、200%放大主题卡片。

## 限制与下一步

源码验收结束时未提交、推送、打包、安装或部署；用户随后追加授权 commit 和 push，按文首所述范围交付。独立Tern参考与Electron测试进程均正常退出，浏览器接管已释放。

1. 若用户要求本机覆盖安装，再使用当前项目安装流程；本任务未授权覆盖安装。
2. 本次 Git 交付只包含主题功能与文档，按改动块区分并行任务，禁止全量暂存；后续其它功能的提交遵从其对应授权。
3. 若继续扩充主题，在同一themes.ts、THEME_IDS和语义颜色契约下增加；复用当前卡片与保存链路，定向检查对比度和实际界面。
4. 若需要完整性能或无OOM证明，另做同构建隔离对照、整个进程树峰值采样与长期压力，不重复已通过的普通设置检查冒充该证据。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan` 的主题切换任务。用户要求参考Tern settings，已实现6套浅深主题、hover整窗预览、click/键盘保存、Esc/离开/隐藏取消、浅深各自持久化、托盘同步和保存失败回滚重试。最终 npm run build 与10项设置测试通过，真实原生独立profile验证重启恢复、12种配色、窄窗/全屏/200%及断点。证据位于 `.impeccable/review/themes-2026-11-04/`。用户已追加授权 commit 和 push，Git交付按文首范围执行，以远程回执为准。没有安装；工作区还有并行的托盘/任务历史/侧栏/安装脚本改动，保留它们。按用户新要求继续，不重复全仓测试。
