# 原生标题栏侧栏按钮对齐（2026-11-11）

## 现场与范围

工作目录为 `/Users/zvf003/ZStack/oc-chan-sidebar-main-20261111`，开始时 `git status --short` 无改动。用户报告已安装应用的侧栏按钮比真实红绿灯低；用户截图中两者中心相差约22物理像素，在2×屏幕上为11逻辑点。此结论只针对该截图，不把网页截图当作原生窗口证据。

主窗口在 `src-tauri/src/windows.rs` 使用 `TitleBarStyle::Overlay`、`hidden_title(true)`。旧按钮规则为 `top:13px;height:28px`，CSS中心27px；这按网页顶栏中心排列，未核对AppKit标准窗口按钮中心以及WK obscuredContentInsets。

主代理随后从新driver读取真实同实例数据：三枚标准按钮中心均为16pt，close矩形为 `(9,9,14,14)`，minimize/zoom的x分别32/55；WK bounds为1280×860、flipped=true、顶部obscured inset=0、pageZoom=1，contentLayoutInWebview从y=32开始。DOM旧按钮中心为27px，精确低11pt，与用户截图一致。

据此将 `.sidebar-toggle` 的top从13px改为2px，保留28px命中高度和16px图标：`2 + 28 / 2 = 16`。收起/展开共用同一固定规则，不改品牌区，不改变原生红绿灯位置。代码注释记录32pt标题栏和WK坐标依据；不是靠反复截图试数值。

## 几何证据入口

`src-tauri/acceptance/wk-driver.mm` 的现有 `inspect` 操作扩充 `geometry.windowButtons`，逐个返回真实 `standardWindowButton` 的 `close/minimize/zoom`：

- `frameInWebview`：通过AppKit `convertRect:fromView:` 从按钮bounds转换的NSView矩形。
- `topFromWebview`、`centerYFromWebview`：考虑WK是否翻转后的、从WK顶部向下计量的逻辑点。
- `hidden`：实际按钮自身隐藏状态；按钮不存在则为null，不伪造几何。

原有 `geometry.obscuredContentInsets`、`pageZoom`、`magnification` 保留。对于未捏合的页面，DOM中心转换为原生点后与按钮中心比较：

```js
const r = document.querySelector('.sidebar-toggle').getBoundingClientRect()
const nativeCenter = geometry.obscuredContentInsets.top + (r.y + r.height / 2) * geometry.pageZoom
const delta = nativeCenter - geometry.windowButtons.close.centerYFromWebview
// 对close/minimize/zoom均要求 Math.abs(delta) <= 0.5 逻辑点。
```

DOM矩形须通过driver eval读取，geometry通过同一实例inspect读取；不对NSView坐标或Retina像素直接套用CSS数值。展开、收起两态须分别检查，并保留实际回执。

## 缩放与局部导航样式

当前生产host/renderer没有WK pageZoom设置或页面缩放入口；用户可操作的是三档字体大小和画布缩放。侧栏按钮采用固定CSS尺寸，不随 `--font-scale` 改变。必须覆盖三档字号，不将CSS 200%截图冒充WK pageZoom或系统显示缩放验收。若以后引入WK页面缩放，须将真实原生几何转换为当前CSS坐标，不能沿用固定数值假设。

按主代理追加分工，仅在styles.css为统一「插件」入口补充flex标题行与独立28px展开按钮；标题has-current和selected状态由App.tsx负责，展开按钮复用原hover/focus与aria-expanded箭头旋转。未修改App.tsx或品牌区。

## 主代理验证

子代理未运行build/tests/lint/formatter、安装、提交或推送。主代理负责构建含新增inspect字段的acceptance实例，再采集原生几何和最终可见窗口。

最窄现有行为场景：

```sh
env PATH="/Users/zvf003/.cargo/bin:$PATH" npm run smoke:renderer -- --scenario sidebar --out /tmp/oc-chan-sidebar-native-alignment-20261111
```

输出目录必须未存在。补充上述原生中心断言，覆盖展开/收起、880×640与1280×860、三档字号。无头结果只能证明同实例原生几何与DOM关系；安装后仍须可见窗口截图确认原生红绿灯与图标在同一水平线。

实际结果：`npm run typecheck` 通过；`sidebar` 场景证据 `/tmp/oc-chan-native-alignment-plugins-20261111` 与 `marketplace` 场景证据 `/tmp/oc-chan-unified-plugins-marketplace-20261111` 均返回 `complete:true, errors:[]`。三档字号×展开/收起的原生中心断言通过；统一插件入口及安装、禁用、卸载、重启导航通过。已审阅并同步中英文README及开发文档。提交推送与安装回执待补记。

功能提交 `e6a26d880621bf37d300390f27336a32f36b3804` 已推送GitHub main并回读确认；`npm run install:local` 成功，安装器报告真实React/IPC/采集/历史就绪，PID82717。正式应用窗口1693可见截图 `/tmp/oc-chan-installed-alignment-visible-20261111.png` 已查看：侧栏图标与原生红绿灯同一水平线，一级导航仅一个「插件」。首次隐藏窗口截图只有空白背景，不作为验收证据。

可见窗口同时发现系统监控插件 `OC_PLUGIN_TRUST: Installed bundled package id is not trusted by this build`，采集处于停用。安装回执不等于该插件健康；当前任务未变更插件信任/重新安装插件，后续应单独定位，不能宣称所有插件正常。原工作区和个人数据保留。此补记只改handoff，已核对中英文README无需再改。

## 后续品牌上移与侧栏功能化（待主代理验收）

用户要求把 OC Chan 上移到标题栏，移除侧栏「OC Chan / 本机运行观察」和左下角「此 Mac / 本地采集 · 只读访问」。本次采用紧凑纯字标，固定 left120/top2/height28/font12，与按钮中心同为16px；不保留35px图标或副标题。展开/收起位置一致，收起顶栏从200px开始避让字标，沿用横向滚动与窄窗图标入口，未新增顶栏行。紧凑导航模式字标放left84，导航按钮仍在标题栏下。

侧栏上内边距从66px降到40px，紧贴拖动区域下沿开始功能导航；删除旧brand专用样式和短窗覆盖，下内边距12px使设置入口贴近窗口底部。删除唯一Device插槽调用、RendererSlot联合成员、RendererContribution属性、系统插件Device组件/注册及专用CSS；系统插件Footer、托盘主机信息、来源和设置入口保持原行为。

已有sidebar smoke扩展真实几何断言：三档字号×展开/收起，品牌中心对原生close中心误差≤0.5pt、品牌边界稳定、品牌与按钮/首导航互不覆盖、展开首导航在drag区域下方且设置靠近底部；880px大字号英文下逐个滚动并真实点击顶栏入口，检查命中与视口边界；640px下检查菜单按钮及弹出菜单首项/设置可达。没有加入源码或文案快照测试。

本次子代理仅完成修改，未运行build/test/lint/formatter、安装、提交。以上新断言尚未执行，前文通过回执属于修改前版本。主代理最窄验证为 `npm run typecheck` 和 `npm run smoke:renderer -- --scenario sidebar --out <新目录>`；原生窗口可见截图再确认字标/红绿灯对齐。本次已读取impeccable context/layout/craft-floor，按明确委派直接推导窄范围布局，未新增视觉世界或子代理；检测器按禁止子代理验证的任务边界留给主代理。

主代理验证：类型检查通过；`/tmp/oc-chan-titlebar-brand-diagnosed-20261111/result.json` 为 `complete:true, errors:[]`，已查看重启截图，品牌位于顶部，菜单从40px开始，设备块移除且设置贴底。首次 `/tmp/oc-chan-titlebar-brand-20261111` 的六组合对齐通过，但后续导航click缺目标且失败诊断被command group EPERM覆盖；补充精确click表达式及保留原错误的诊断后同场景通过。首次缺目标的具体原因未确认，不将诊断补强称为产品修复。仅本次布局验收通过，不将采集来源错误当作已修复。

品牌/设备块修改已提交 `eaf3db3b135acbedb7746a585c079a5fc3864b52`，GitHub main回读一致。正式安装成功，PID11320；已查看可见窗口1808截图 `/tmp/oc-chan-brand-installed-20261111.png`，OC Chan字标与按钮/红绿灯同一中心线，收起顶栏未遮挡。展开布局和设备块删除由真实WK截图与定向场景证明。系统监控OC_PLUGIN_TRUST仍存在，未在本次布局任务修复。云端CI尚未完成；此交接补记不影响已审阅的中英文README。
