# 设置优先修复交接 · 2026-11-03

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`fix/settings-accessibility-recovery`（本轮读取 `.git/HEAD` 确认）。
- 目标：修复设置走查提出的三项问题：200% 放大布局、侧栏辅助文字可读性、设置保存失败的恢复指引。
- 状态：三项修复及最终打包应用验收完成。八项设置沿用现有实现。未执行 Git 提交或推送，未安装到 Applications，未签名、公证或发布。
- 背景：[八项设置实现与初次走查](2026-11-02-desktop-settings.md)。原走查的 29/40 是当时的主观评价；本轮没有重新评分。

## 已完成

### 200% 放大与焦点

- 移除根布局对 860px CSS 宽度的依赖；CSS 视口不超过 760px 时，主导航进入可滚动的原生 popover，设置分类改为原生下拉框，详情单列滚动。
- 默认原生内容尺寸 1280×860 在 zoom=2 时为 640×430 CSS 视口；最小内容尺寸 880×640 在 zoom=2 时为 440×320。最终包两种尺寸均无横向溢出，最小尺寸下八分类均可达。
- 根因修复：原先 CSS 在重排事件处理前隐藏控件，浏览器先清除了焦点。主导航和设置分类现在使用同一受控重排状态，先记录焦点，再切换布局并在布局提交后转移至对应控件。
- 实测分类按钮↔分类下拉框、主导航当前按钮↔展开按钮的双向焦点转移。分类与设置值保持。
- 顶栏保留 macOS 原生窗口按钮空间；popover 和详情分别在可用范围内滚动。

### 侧栏可读性

- 品牌说明、设备说明与计数辅助文字设置 12px 下限，包括用户选择最小正文档位时。
- 最终包浅色、最小字号的实际计算样式：普通辅助文字对侧栏底色为 5.20:1，琥珀色计数为 4.81:1；取色来自真实渲染页面。
- 深色英文、大字号、最小窗口已查看截图。以上对比度结果只覆盖记录中的侧栏元素，不代表全应用无障碍认证。

### 保存失败恢复

- 错误呈现包含受影响的设置、失败原因、设置路径、恢复步骤及“重试这项修改”；保留本次修改意图，错误不被静默吞掉。
- 原始诊断放入可展开、可选择复制的只读文本框；长路径允许换行。
- 保存失败时展示实际设置；确认中断明确表示保存结果未知，不一概宣称未保存。
- 保存和重试期间阻止重复提交并保留焦点；重试完成且用户没有主动移走焦点时，回到原设置控件。
- 最终包使用独立 profile，将真实 `settings.json` 暂时替换为同名目录，触发 EISDIR。错误可见；310 字符诊断全文可选中；恢复原文件后重试成功，深色设置生效，焦点回到已选中的 `dark` 单选框。故障目录与备份已恢复。

## 关键文件

- `src/renderer/src/App.tsx`：受控重排状态、主导航 popover 与跨布局焦点协调。
- `src/renderer/src/SettingsView.tsx`、`settings.css`：八分类导航、紧凑下拉框与详情重排。
- `src/renderer/src/styles.css`、`tokens.css`：根布局、导航及侧栏文字尺寸和颜色。
- `src/renderer/src/SettingsSaveError.tsx`、`settings-error.css`、`settings.tsx`：恢复指引、诊断、重试状态和焦点处理。
- `src/shared/settings.ts`、`src/main/settings.ts`、`src/main/index.ts`：设置结果、保存错误与 IPC 路径相关契约。
- `README.md`、`DESIGN.md`、`.impeccable/design.json`：实际行为说明、文字下限、760px 重排与断点元数据。
- 同一工作区存在 Agent 筛选、Tern 跳转等并行改动。以上是本轮相关范围，不是全工作区改动归属清单。

## 实际验证

本节登记有直接回执的最终构建与运行证据，不用旧版回执替代当前结果。

- `npm run package`：最终焦点修复后通过，包含 `tsc --noEmit`、原生 helper 构建、Electron Vite 构建和 `electron-builder --mac dir --publish never`。未以全仓测试作为完成检查。
- 真实启动 `release/mac-arm64/OC Chan.app`，回读 `app.isPackaged === true`；渲染路径位于包内 `app.asar/out/renderer/index.html`。
- 最终布局记录共 30 条：默认窗口、最小窗口、深色英文大字号下八分类的 200% 布局、759px/761px 断点两侧、15 次连续原生尺寸变化、半屏尺寸、原生全屏和真实错误状态。记录中的根文档及设置布局均无横向溢出。
- 通过 Electron 原生接口实际进入并退出全屏：内容尺寸 2560×1440、zoom=2，对应 CSS 视口 1280×720。半屏验收是程序设置原生窗口尺寸，并非操作 macOS 分屏菜单。
- 连续尺寸变化使用 `BrowserWindow.setContentSize`，不是物理拖动标题栏。72 个 requestAnimationFrame 间隔，中位 16.7ms、P95 17.6ms、最大 17.6ms；它们是帧回调间隔，不是完整渲染耗时。
- 最终真实 EISDIR→恢复文件→重试成功、诊断选择和焦点结果已记录。最终功能验收及性能采样的浏览器错误记录均为空。
- 受影响的 8 个 UI 源文件执行一次 `impeccable detect --json`：0 warning、15 条 `design-system-radius` advisory。涉及源码圆角与设计声明尺度的差异，回执保留；未新增忽略项，也未扩大为圆角或设计元数据整治。

### 性能采样范围

- 环境：Apple M4 Max、16 逻辑核心、arm64、Darwin 27.2.0、Electron 45.2.1、Chromium 156.0.8078.75，外接屏 59.94Hz、scaleFactor=2。
- 最终采样窗口可见且有焦点，CSS 视口 1280×860。连续 24 次通过真实设置 IPC 交替保存浅色/深色，每次等待两个动画帧并核验主题已生效；24 次均完成。
- 最终保存 IPC 中位 12.7ms、P95 27.2ms；该次进程创建至 DOMContentLoaded 为 328.76ms。整个操作窗口约 966.98ms，五个应用进程累计 CPU 增量 0.646s，结束时合计 working set 771.89MiB。
- 原始基线、中间版本、最终版本及进程级数据均保存在 `verification.json`。三次采样的预热经历和实时采集数据并不完全相同，尾延迟有波动，不能据此宣称性能改善、等效或统计意义上的无回归。

## 证据与产物

- 应用：`release/mac-arm64/OC Chan.app`。
- 完整数据：`.impeccable/review/settings-priority-fixes-2026-11-03/verification.json`。
- 默认浅色：该目录 `default-light-1280.png`。
- 最小窗口深色英文：`minimum-dark-en-100.png`、`minimum-dark-en-200.png`。
- 默认尺寸 200%：`default-dark-en-200.png`。
- 原生全屏 200%：`fullscreen-200.png`。
- 实际保存错误：`save-recovery-200.png`。
- 独立验收数据目录：`/tmp/oc-settings-priority-lGzx32/`，含 baseline、revised、final profile；未操作用户正常应用数据目录。
- 最终功能验收实例 `oc-settings-priority-final-focus` 已退出码 0；性能采样结束后已释放浏览器接管并调用专用应用退出。验收资料保留，生产代码中没有加入测试开关。

## 限制与注意

- VoiceOver、物理标题栏拖动、物理菜单栏点击、硬件休眠、其他操作系统及全仓验证不在本轮通过项中。
- 录屏尝试因 PATH 无 ffmpeg 失败，没有生成视频；未安装额外工具。保留原生截图、连续尺寸变化和帧间隔数据，不能称作已完成录屏验收。
- 启动日志仍有宿主 NODE_OPTIONS 不受打包 Electron 支持的提示；本轮未修改宿主配置或隐藏日志。
- 保留 15 条圆角尺度 advisory；它们不等于已确认的本轮功能故障，也未被消音。若以后调整设计规范，应单独核对真实圆角用途。
- 未执行提交、推送、安装、签名、公证或发布。不要全量暂存、reset、强推或清理并行任务文件。

## 后续动作

1. 用户试用时从当前 `.app` 启动，按实际需要补充 VoiceOver 或物理窗口操作验收；不要把程序化原生接口验收表述为这些项目已经通过。
2. 后续设置变更以现有 30 条布局及错误恢复证据为基线，只验证受影响行为；无新增改动或风险时不重复已通过检查。
3. 如用户要求提交，先核对设置与并行 Agent/Tern 修改的归属，只暂存明确授权的范围。
4. 如用户要求分发，再处理安装目标、签名、公证和发布；当前是未签名本机应用包。

## 恢复提示

在 `/Users/zvf003/ZStack/oc-chan` 继续，先读本交接与现行规则。当前分支 `fix/settings-accessibility-recovery`，200% 设置重排、侧栏可读性、保存失败恢复三项修复已完成并在真实打包应用中验收。产物 `release/mac-arm64/OC Chan.app`，证据 `.impeccable/review/settings-priority-fixes-2026-11-03/`。不要重复已通过验证，不把 29/40 的旧走查评分作为新评分，不把原生接口测试描述为物理操作或 VoiceOver 验收。性能数据仅为短采样。保留工作区并行改动；未提交、推送、安装或发布。

## 后续布局调整

用户随后明确要求八项设置同页平铺。分类导航、分类下拉框及独立大预览区现已删除；最新实现和验收见 [设置同页平铺交接](2026-11-03-flat-settings.md)。本文件中的分类布局及相关焦点转移记录仅描述先前版本。
