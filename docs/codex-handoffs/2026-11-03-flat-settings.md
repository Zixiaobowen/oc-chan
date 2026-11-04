# 设置同页平铺交接 · 2026-11-03

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`fix/settings-accessibility-recovery`。本轮开始时 `git status --short --branch` 显示尚无提交、项目文件均未跟踪；保留同一工作区的并行任务内容。
- 用户目标：八项设置同页平铺，移除分类/tab 切换，简单选项直接用 radio、select、switch。
- 状态：完成，最终 `.app` 已验证；用户随后授权本地更新与删除旧版，现已安装到 `/Applications/OC Chan.app` 并正常启动。未提交、推送或发布。
- 本交接的布局说明替代 [此前的设置优先修复交接](2026-11-03-settings-accessibility-recovery.md) 中“八分类导航/分类下拉框”描述；原持久化及错误恢复能力继续保留。

## 实现

- `src/renderer/src/SettingsView.tsx`：八项同时渲染。外观、语言、字号、托盘点击用行内原生单选；界面字体、代码字体用下拉框；Dock 与防休眠用开关。删除分类状态、分类导航、分类重排焦点逻辑、图标卡片及大预览区；代码字体仅保留一行字形样例。
- `src/renderer/src/settings.css`：名称和控件两列、细分隔线、紧凑行距；设置容器不超过 560px 时改为上下排列。控件 DOM 不替换，键盘顺序与阅读顺序一致。保留同文件的托盘样式。
- `src/renderer/src/App.tsx`：移除 SettingsView 已无用途的 compact/focusBeforeReflow 参数；主导航的既有重排和焦点逻辑保留。
- `SettingRow` 将保存失败组件放在对应行下方，原有 Provider、IPC、原生设置与事务逻辑未修改。
- 已同步 `README.md`、`DESIGN.md`、`PRODUCT.md`。

## 实际验证

- `npm run package` 通过，含类型检查、原生 helper、Electron Vite 与 macOS dir 打包。发现并修复滚动问题后再次打包通过；未运行全仓测试，未新增永久测试。
- 最终启动包内可执行文件，回读 `app.isPackaged=true`，页面为 `app.asar/out/renderer/index.html`。验证使用独立 `/tmp/oc-settings-flat-Xb02DZ`，未修改正常应用 profile。
- 八项实际控件均操作并保存；外观使用方向键，防休眠使用 Space，字体使用原生下拉框。保存后焦点保留；Dock 隐藏时回读原生 `app.dock.isVisible() === false`，随后恢复显示；防休眠最终关闭。
- Tab 从外观依次到语言、字号、界面字体、代码字体、托盘行为、Dock、防休眠，不经过额外分类导航。
- 冷启动回读八项设置，匹配上一实例保存的值，包括真实错误重试后的 Monaco。
- 最终包覆盖 1280×860 与 880×640 内容窗口、100% 与 200% zoom、浅色中文默认字号、深色英文大字号。八行始终存在，没有分类导航；默认中文窗口完整显示八项。英文大字号或窄窗允许内容区纵向滚动。
- 最小窗口 200% 下 CSS 视口 440×320，根文档始终 440×320，无横向或外层纵向溢出。代码字体焦点跨所有尺寸变化保持。
- 真正将隔离 profile 的 `settings.json` 换为同名目录，触发 EISDIR：错误仅出现在代码字体行，当前值回滚；恢复文件后点击重试，实际修改成功、错误消失、焦点回到代码字体。最终包同时验证长错误提示展开时无外层滚动。故障目录与备份已恢复。
- `impeccable detect --json src/renderer/src/SettingsView.tsx src/renderer/src/settings.css` 为 `[]`；最后一处定位修复后仅复查 `settings.css`，仍为 `[]`。
- 最终浏览器错误记录为空。专用验收实例均退出码 0，接管已释放。

## 修复中发现的问题

隐藏的单选组 legend 使用绝对定位。移除旧卡片布局时曾一并去掉 fieldset 的定位上下文，导致 legend 相对文档定位，逃出内容滚动边界。200% 时根文档高 789px、视口高 320px，出现两层滚动条。恢复 `.setting-choices { position: relative }` 后实际根文档恢复 320px；最终包正常、滚动到底部及错误展开状态均通过。没有用隐藏根滚动条掩盖问题。

自动化中 `page.evaluate` 位于隔离上下文，不能访问应用 preload API；实际 snapshot 回读使用 Electron `webContents.executeJavaScript`。端口就绪早于页面就绪，以及冷启动恢复 200% zoom 的情况，已按实际页面状态调整验收顺序；这些是验收脚本问题，没有为它们添加产品兜底逻辑。

## 产物与证据

- 应用：`release/mac-arm64/OC Chan.app`，未签名。
- 数据：`.impeccable/review/settings-flat-2026-11-03/verification.json`。
- 默认效果：同目录 `desktop-light-zh.png`。
- 深色英文：`desktop-dark-en.png`、`minimum-dark-en.png`。
- 放大：`default-200-dark-en.png`、`minimum-200-top.png`、`minimum-200-bottom.png`。
- 错误：`code-font-save-error-200.png`。
- 最终隔离 profile 已恢复浅色、中文、默认字号、系统字体、托盘模式、Dock 显示、防休眠关闭，并恢复 1280×860 / zoom=1。

## 边界与后续

未测试 VoiceOver、物理菜单栏点击或硬件休眠。本轮没有改动原生能力实现，界面 smoke、构建、冷启动和真实保存故障是本轮证据；不把它们扩展成全应用认证。

1. 用户试用当前 `.app`，按实际反馈调整密度；保持八项同页，不重新引入分类切换。
2. 后续修改只验证受影响路径；当前检查已经通过，无新增改动时不重复运行。
3. 用户要求提交时，先确认与并行任务的文件/改动归属，仅处理明确授权范围；不要全量暂存、清理或重置。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan`，先读本交接及现行规则。用户明确要求八项设置平铺，已删除分类切换及大预览，当前 UI 是紧凑单页原生控件。最终包已通过窄窗/200% 重排、八项保存、冷启动、键盘顺序、就近错误和重试焦点验证。证据在 `.impeccable/review/settings-flat-2026-11-03/`。用户随后授权安装新版和移除旧版，当前安装位置 `/Applications/OC Chan.app`，正常启动 PID 8483；实际状态以后续现场为准。保留并行改动；未提交、推送或发布。旧交接中的分类布局已被本轮替代。

## 本地应用更新

- 用户明确授权更新本地应用并删除旧版。更新前运行的是 `release/schedule-polish-final/mac-arm64/OC Chan.app`，`/Applications` 尚无安装版；没有指向旧包的固定 Dock 条目。
- 正常退出旧实例后，使用 `ditto` 将 `release/mac-arm64/OC Chan.app` 安装到 `/Applications/OC Chan.app`。两处 `Contents/Resources/app.asar` SHA-256 相同：`40b5ef0b57576ef325c8fb129a08f52c5050e33141c9301a969de6fcd66ff9d4`。
- 从安装位置启动并实测设置页：8 行同时展示、11 个单选输入、2 个字体下拉框、2 个开关、无分类导航、1280×860 根文档无溢出、浏览器错误记录为空。截图 `installed-app.png`，结构化回执 `installation.json`。
- 使用原用户数据目录 `/Users/zvf003/Library/Application Support/OC Chan`；没有修改设置选项。`settings.json` 更新前后 SHA-256 均为 `7e4c276020f2e77642e9f302b263f1326ff6d1f4fca84eb3366b0f5d2cc2ef5e`。
- 四份历史 `.app` 的原路径已全部不存在：`release/activity-filter/mac-arm64/OC Chan.app`、`release/schedule-filters/mac-arm64/OC Chan.app`、`release/schedule-polish-final/mac-arm64/OC Chan.app`、`release/schedule-polish/mac-arm64/OC Chan.app`。仅处理应用包；源码、目录内其余资料与 `release/mac-arm64` 新构建保留。
- 清理调用原生废纸篓接口，不清空废纸篓。第一份包调用后源路径消失，但 JXA 在回读结果时退出 139，未取得目标路径；工具直接列举废纸篓被 macOS 权限拒绝。其余三份通过 Swift Foundation 接口成功移动并取得逐项废纸篓路径，详见 installation.json。第一份目标路径未确认，不把它描述为取得完整回执。
- 临时验收实例 PID 5458 已退出码 0，浏览器接管已释放。随后通过 LaunchServices 正常启动安装版，确认唯一实例 PID 8483、finishedLaunching=true，命令为 `/Applications/OC Chan.app/Contents/MacOS/OC Chan`，没有 inspect 或 remote-debugging 参数。应用保持运行，未执行安装维护之外的服务操作。
