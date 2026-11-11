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
