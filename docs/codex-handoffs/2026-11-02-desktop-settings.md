# 桌面设置交接 · 2026-11-02

- Repo：`/Users/zvf003/ZStack/oc-chan`
- 当前 branch：`fix/tern-native-navigation`（交付时读取 `.git/HEAD`；同一工作区有并行 Tern 原生跳转等改动）。
- 目标：左下角设置入口与外观、语言、文字大小、界面字体、代码字体、托盘点击行为、显示程序坞、防止休眠八项二级设置。
- 状态：八项实现及本轮验收完成。未执行 Git 提交或推送，未安装到 Applications，未签名、公证、上传或发布。

## 已完成

- 左下角固定设置入口，八项分类导航；控件即时应用并自动保存。
- 外观：跟随系统 / 浅色 / 深色；主窗口、图表、拓扑画布与托盘共用语义颜色。
- 语言：跟随系统 / 简体中文 / English；界面与原生菜单切换，用户数据与原始诊断保留原文。
- 字号：12 / 13 / 15 px；界面字体：系统默认 / PingFang SC / Helvetica Neue；代码字体：系统等宽 / Menlo / Monaco。实际正文、路径、PID 等消费对应变量。
- 托盘点击可展开 360×430 小面板或恢复并聚焦主窗口；关闭主窗口后仍可恢复；右键菜单可打开主窗或退出。托盘底部主按钮不随内容滚动。
- Dock 图标显隐与 `powerSaveBlocker` 已接入；防休眠只阻止空闲休眠，关闭或退出释放。
- 严格校验、串行事务、原子写入、原生效果回滚与可见错误；坏文件不静默重置。保存错误后可以继续修改。
- 独立视觉复核发现保存期间 `disabled` 造成焦点丢失。已在真实 Electron 复现 INPUT→BODY；改为 `aria-disabled`，用控件 guard、统一 change guard 和 Provider pending ref 阻止重复提交。Dock 的非 macOS 不可用状态仍保留原生 disabled。
- README、PRODUCT、DESIGN 已同步，保留并行任务新增内容。

## 关键调查 / 修改范围

- `src/shared/settings.ts`：设置枚举及快照契约。
- `src/main/settings.ts`、`settings.test.ts`：校验、持久化、串行事务、回滚。
- `src/main/desktop-settings.ts`、`index.ts`：原生主题、Dock、防休眠、托盘、主窗口和 IPC。
- `src/preload/index.ts`：受限设置桥接。
- `src/renderer/src/settings.tsx`、`SettingsView.tsx`、`settings.css`：Provider、八项设置、焦点与错误状态。
- `src/renderer/src/App.tsx`、`TrayView.tsx`、`i18n.tsx`、`tokens.css`、`styles.css` 及既有监控页面的语言、主题和字体消费。
- `README.md`、`PRODUCT.md`、`DESIGN.md`。

## 已运行的检查与实际结果

- `node --import tsx --test src/main/settings.test.ts`：当前状态验收 7/7 通过。覆盖字段与枚举校验、坏文件、并发保存、原生失败、原子替换失败、回滚失败和非法 patch。
- `npm run typecheck`：当前状态验收通过。
- `npm run package`：最终焦点修复后通过。包含 `tsc --noEmit`、原生 helper 构建、Electron Vite 构建及 `electron-builder --mac dir --publish never`。未运行全仓测试。
- 最终产物：`release/mac-arm64/OC Chan.app`。真实启动该可执行文件，确认 `app.isPackaged === true`，渲染地址为包内 `app.asar/out/renderer/index.html`，不是开发网页。
- 当前状态核对：包内主进程、preload、renderer HTML 及两份 JS/CSS assets 与 `out/` 逐字节一致；包生成时间晚于当前 App 与设置控件修改时间，先前真实应用验收仍适用于这个产物。
- 验收使用独立目录 `/tmp/oc-chan-settings-n1mq5l/profile`。最终包在应用入口断点注入 `app.setPath('userData', ...)` 后恢复启动；未添加生产专用测试开关。
- 八项设置写入 `settings.json` 后冷启动恢复；实测 Dock 隐藏与显示、主窗恢复、主题跟随系统、全部字号及系统/具体字体。
- Electron 实际界面覆盖浅色中文、深色英文、1280×860、880×640 大字号与 360×430 托盘。托盘主按钮底边 410，小面板高 430，无横向溢出。
- 托盘的原生 `click` 事件分别走小面板 / 主窗路径；原生 `webContents.sendInputEvent(Escape)` 能隐藏托盘。物理菜单栏坐标点击未取得 click 回执，不能声称物理点击验收通过。
- `pmset -g assertions` 曾确认验收进程的真实防休眠断言；开关关闭后 blocker 列表为空。最终包 PID 90899 退出码 0，quit 日志 `SETTINGS_QUIT_BLOCKERS []`，退出后 `pmset -g assertions` 无该 PID 残留。
- 最终 `.app` 连续 ArrowDown / ArrowUp 切换外观后，焦点仍为对应 INPUT；连续 Space 切换防休眠后焦点仍为 switch；字体选择后仍聚焦 `ui-font`。
- 最终包将设置目标临时改为目录，实际触发 EISDIR：错误可见、值回滚到 Helvetica、焦点仍为 `ui-font`、busy=false。恢复文件后重新选择系统字体成功，错误清除且焦点保留。临时目录故障及备份已恢复。
- 英文调度详情、系统监控标题与实际 Monaco 路径字体已检查。画布初次布局稳定后切换中英文，节点位置和 viewport 均保持。
- 原生事务只读复核未发现实质缺陷；视觉复核发现的焦点 P2 已修复，定向复核 disposition=ship；两次复核均未替代主代理实测。

## 可定位证据

- `.impeccable/review/settings-packaged-final.png`：最终真实应用包，浅色中文 1280×860。
- `.impeccable/review/settings-final-desktop.png`：深色英文、大字号。
- `.impeccable/review/settings-final-narrow.png`：880×640，八项分类可达。
- `.impeccable/review/settings-final-tray.png`：底部主按钮完整可见。
- `.impeccable/review/settings-save-error.png`：真实磁盘失败提示。
- 最后修改仅改变保存时焦点 / busy 处理，旧深色及窄窗截图的视觉布局仍适用。

## 已知边界与执行注意

- macOS 为本次验收平台；未覆盖 VoiceOver、200% 缩放、多显示器、合盖硬件休眠或其他操作系统。
- 未完成物理菜单栏点击验收；原生事件处理与实际窗口结果已覆盖。
- 验收工具曾因原生窗口尺寸变化及初次画布布局未完成超时。重新在明确尺寸截图；在初次布局稳定后才核验画布语言切换。不要把早期不稳定视口比较当作产品缺陷。
- `.app` 启动日志有宿主 NODE_OPTIONS 不受打包 Electron 支持的提示；应用仍成功启动并完成上述验收，没有为此修改仓库配置或吞掉错误。
- 隔离验收进程及浏览器接管均已关闭，临时 bootstrap 脚本已移除，截图与验收资料保留。不要误删用户聊天、日志、worktree 或其它任务文件。
- 工作区存在并行改动且本轮没有可靠提交差异基线；不要全量暂存、reset、清理或把所有文件归入本任务。当前 branch 以现场为准。

## 下一步

1. 用户试用时从 `release/mac-arm64/OC Chan.app` 启动，重点体验菜单栏实际点击及个人字号 / 字体偏好；普通启动使用正常应用数据目录。
2. 若用户要求提交，先识别设置修改与并行 Tern 工作的归属，仅提交明确获授权范围；当前未授权推送、安装或发布。
3. 若要分发应用，先确认签名 / 公证及发布授权，再处理 Developer ID；当前产物是本机未签名应用包。

## 新线程恢复提示

在 `/Users/zvf003/ZStack/oc-chan` 继续。先读本交接与现行项目规则。左下角八项设置已实现，持久化、原生效果、真实 `.app` 及焦点修复已通过定向验收。不要重复已通过检查；新增修改再选相关验证。最终产物 `release/mac-arm64/OC Chan.app`，截图 `.impeccable/review/settings-packaged-final.png`。未提交、推送、安装或发布；保留共享工作区的并行 Tern 原生跳转等改动。物理菜单栏点击、VoiceOver 和硬件休眠未验收，不把原生事件测试表述为这些场景通过。

## 设置设计走查补充

- 当前目标：用户调用 impeccable“走查”，评估设置页及直接关联的桌面行为；本轮没有修改业务源码。
- 当前 repo / branch 仍为本文开头所列位置与 `fix/tern-native-navigation`；保留共享工作区其它任务的改动。
- 目标文件：`src/renderer/src/SettingsView.tsx`，Operate 模式；并检查 `settings.tsx`、`settings.css`、`styles.css`、`tokens.css`、`App.tsx`、`TrayView.tsx`、主进程设置和菜单路径。
- 独立评估 A：`SettingsCritiqueA`。该 reviewer 没有 browser 工具，由主代理按其要求代采原始截图和交互数据，A 独立判读。B 未运行前 A 已完成。
- 独立评估 B：`SettingsCritiqueB`，独立执行源码与三个 Electron CDP 状态的检测，未读取 A 结论。
- 综合评分 29/40，全部十项 Nielsen 启发式适用；这是主观体验评价，不是测试通过率或无障碍认证。
- 优先问题：P1，默认原生内容窗口 1280×860 在真实 200% zoom 下产生 640×430 CSS 视口，根布局仍宽 860px，需横向移动才能读完整详情；P2，侧栏 10px 辅助文字和浅色 4.3:1 对比；P2，保存错误直接输出技术异常，缺乏按原因给出的恢复步骤。
- 小观察：暂停时外观预览固定显示“实时显示已开启”；返回设置重置分类；缺少原生设置菜单 / ⌘,；窄窗英文孤词换行。未把这些写成核心设置不可用。
- 实际走查：八分类浅色中文、880×640 深色英文 15px、真实 Electron 200% zoom、Tab / 方向键 / 空格 / 下拉键盘选择；回读字体、字号、语言、托盘偏好、Dock 与防休眠设置值。Dock 开关同时回读原生可见性。未测试物理菜单栏单击、VoiceOver、合盖或真实休眠。
- 错误呈现使用既有真实错误截图，并核对当前源码；本轮没有再制造文件故障。
- 命令：`impeccable critique-storage slug src/renderer/src/SettingsView.tsx`；`impeccable detect --json src/renderer/src/SettingsView.tsx`；三次 `impeccable detect --cdp 9340 --target 'OC Chan Critique Target' --json`；`critique-storage write` 与 `trend ... 5`。
- 检测结果：源码 0；三个 live 状态依次为 primary/advisory 2/3、1/2、1/1，累计 4 次 warning 和 6 次 advisory，包含重复。英文孤词属于排版提示；字号阈值不是 WCAG 绝对像素标准。
- 检测无操作失败，三次窗口均 visible；Desktop CDP 流程没有 overlay 或 live-server。主代理浏览器 target 发现与 read :raw 的工具限制分别用 CDP `/json/list` 和逐文件归档处理，没有据此更改产品实现。
- 隔离 profile：`/tmp/oc-chan-critique-C0j2Vm`。已恢复 light / zh-CN / default / system / system / tray / showDock=true / preventSleep=false、外观分类、滚动0、1280×860、zoom1；所有接管释放，专用应用 PID 61406 退出码0。
- [完整走查快照](../../.impeccable/critique/2026-11-02T11-03-56Z__src-renderer-src-settingsview-tsx.md) 已保存主文件内容指纹；这是该 target 首次快照，无历史趋势。临时报文正文已删除。
- 原始截图、键盘回执及 detector JSON：`.impeccable/review/settings-walkthrough-2026-11-02/`，含 manifest、7个JSON与6张截图。既有错误截图仍在上级 review 目录。

### 走查后的下一步

1. 根据用户对优先级和范围的选择决定后续修复；当前走查结果本身不是已完成修复的证明。
2. 优先用 adapt 处理 200% 重排，再按获选范围处理侧栏可读性及真实错误的恢复指引；保留八分类、绿色主题、实际诊断和用户未提交改动。
3. 修改后再运行受影响的定向检查、真实 Electron 常规/窄窗/200% 场景与必要检测，最终 polish；不重复与新改动无关的整仓验证。

恢复提示：继续本项目时先读本追加与完整 critique 快照，再检查证据目录。本轮只做走查，未改业务源码，未提交或推送。不要把 29/40 当作无障碍通过，也不要把建议写成已实现；等待或遵循当前用户明确选择的后续范围。


## 三项优先修复完成 · 2026-11-03

200% 重排、侧栏辅助文字与对比度、保存失败恢复已完成，并通过最终打包应用验收。当前交付与限制见 [设置优先修复交接](2026-11-03-settings-accessibility-recovery.md)。本文件前述走查评分和待选择范围属于当时记录，不是当前待办或新的评分。

最终功能验收及性能采样的隔离应用均退出码 0；未提交、推送、安装或发布。
