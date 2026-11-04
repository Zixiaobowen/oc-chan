# Select 箭头留白修复与验收 · 2026-11-03

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`fix/settings-accessibility-recovery`（本轮初始状态；仓库尚无提交，已有文件全部未跟踪，不能把整个目录当成本轮修改）
- 目标：走查所有页面的 select 并直接修复；用户随后明确指出下拉箭头贴右边框的问题，优先修复该问题。
- 状态：5 个 select 已统一修复、打包、安装并普通启动。未提交或推送，未上传或发布。

## 已完成

- 全部使用位置：Agent 活跃状态 1 个；定时任务范围、状态 2 个；设置界面字体、代码字体 2 个。概览、系统监控、数据来源、托盘没有额外 select。
- `components.tsx` 增加 `NativeSelect`，内部仍为原生 `<select>`，保留 option / optgroup、事件、标签和焦点。统一使用现有 Lucide `ChevronDown`，装饰 SVG 为 aria-hidden 且 pointer-events:none。
- 共享样式：图标 16px，图标区域到右边框 10px，垂直居中；文字右侧 padding 36px、左侧 10px。设置页只覆盖容器宽度、字号和纵向间距，不再覆盖水平留白。
- 5 个调用全部切换，没有保留旧箭头分支或另做自定义选项弹层。
- 构建发现 `src/main/desktop-settings.ts` 缺失，导致 index.ts 的现有 import 报 TS2307。依据修改前 `out/main/index.js` 中标记为该模块的完整实现恢复 TypeScript 模块，保留托盘图标、语言解析、主题、Dock、防休眠及错误行为；没有添加兜底实现。文件缺失原因未确认。
- README、DESIGN 已记录共享控件和真实本机安装位置。

## 文件范围

- 修改：`src/renderer/src/components.tsx`、`AgentsView.tsx`、`SchedulesView.tsx`、`SettingsView.tsx`、`styles.css`、`settings.css`。
- 恢复：`src/main/desktop-settings.ts`。
- 文档：`README.md`、`DESIGN.md`、本交接。
- 证据：`.impeccable/review/selects-2026-11-03/`。

## 实际验证

- `npm run build`：首次因缺失 desktop-settings 模块失败；恢复模块后通过，含 TypeScript、原生 helper 和 Electron Vite 构建。
- `node --import tsx --test src/main/settings.test.ts`：10/10 通过。未运行全仓测试。
- `node_modules/.bin/electron-builder --mac dir --publish never`：通过。
- 从新 `release/mac-arm64/OC Chan.app` 启动真实应用，app.isPackaged=true。隔离配置 `/tmp/oc-select-review-cd0OEe`，未用个人设置作故障或偏好实验。
- 5 组显示状态各走 3 页，共 25 个控件测量：1280×860 浅色中文/13px；1280×860 深色英文/13px；880×640 浅色中文/12px；880×640 深色英文/15px；880×640 深色英文/15px/200%（CSS 视口440px）。全部箭头右距10px、垂直偏差0、控件无横向越界。
- 最小窗口200%时滚动到控件本身，确认5个箭头中心的命中元素都是SELECT；已查看对应截图，不将页头截图当成控件视觉证据。
- 点击界面字体的箭头，原生 select 的 `:open` 实测为 true；图标不截获点击。
- Agent 活跃状态实际更新；任务个人配置+等待触发实际显示9项；清除筛选恢复范围/状态all并聚焦搜索框。
- 界面字体 Helvetica Neue、代码字体 Monaco 实际保存，正文/字形样例使用对应字体。Tab 从界面字体到代码字体，焦点环2px，保存后焦点仍在代码字体。
- 恢复的桌面模块实际 smoke：Dock隐藏/显示回读 false/true；防休眠开启/关闭时首个原生blocker状态 true/false。随后恢复全部隔离偏好。
- 独立评估 A：`SelectDesignReview`，源码及真实CDP观察；B：`SelectDetectorReview`，源码检测22条design-system-radius advisory，无select直接命中。未把静态扫描无命中当成箭头没有问题，也未进行新的完整critique评分/趋势流程。

## 安装与当前运行

- `/Applications/OC Chan.app` 已用新包更新，个人用户数据目录未替换。
- release与安装包的app.asar SHA-256一致：`98acdfc0fc5ce1f6ddaec8531230d9b9ab5248a4d0fa3f4673971ef1ca5290ea`。
- 安装后实测app路径为 `/Applications/OC Chan.app/Contents/Resources/app.asar`，用户数据为 `/Users/zvf003/Library/Application Support/OC Chan`，设置页两项字体select的箭头右距均10px。
- 隔离走查、隔离新包、安装验收进程均退出码0。浏览器和Inspector句柄均已释放，9365/9366验收端口检查无监听。
- `app.relaunch` 请求后没有发现普通进程，随后用macOS `osascript ... activate` 实际启动成功。最终PID为58050，命令为 `/Applications/OC Chan.app/Contents/MacOS/OC Chan`，不带调试参数。

## 证据与边界

- `after-layout.json`、`after-behavior.json`、`after-native-menu.json`、`restored-desktop-settings-smoke.json` 为实际回执。
- `after-desktop-light-zh-{agents,schedules,settings}.png`：三页收起态。
- `after-200-visible-{agents,schedules,settings}.png`：实际滚动到控件后的200%画面。
- `installed-final.png` 捕获的是安装包概览画面，不能作为设置箭头截图；安装后的设置样式由实际DOM几何回执确认，箭头视觉证据见上述新包截图。
- CDP的ArrowUp/Enter未能提交macOS原生弹出菜单选择；已关闭菜单，没有据此修改产品键盘行为。原生菜单内部绘制、系统级方向键选择及VoiceOver未完成验收。Tab焦点、菜单展开和选择后的业务效果已有实际证据。
- 原先窗口恢复时发现进入原生全屏，主代理已确认full=true并退出全屏恢复1280×860；没有把尺寸不一致的早期截图当作窄窗验收。
- 没有新增永久测试或留下执行脚本；截图、JSON及隔离profile保留供追溯。没有删用户日志、聊天、worktree或无关文件。

## 用户限制与后续动作

- 用户明确要求走查后直接修，不再就已发现问题请求确认；原生交互保留，箭头留白统一。
- 保留已有未提交和并行改动；不全量暂存、reset、强推或清理。
- 后续可做的3件事：在已安装应用直接查看三页下拉框；如需补充系统菜单键盘/VoiceOver证据，使用真实系统输入；若用户授权提交，先明确本轮文件与并行改动归属后仅提交对应范围。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan`。用户指出的所有select箭头贴边已通过共享NativeSelect修复，5处调用已迁移，真实新包5组显示状态、筛选、字体保存与Tab焦点验收通过。另依据现有构建产物恢复了缺失的desktop-settings.ts，构建及10项设置测试通过。新包已安装到Applications并以普通参数运行，未提交推送。先读本交接，按新问题定向验证，不重复全仓测试；保留所有其它未提交改动。
