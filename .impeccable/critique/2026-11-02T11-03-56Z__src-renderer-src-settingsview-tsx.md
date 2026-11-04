---
target: 设置功能走查
total_score: 29
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 1
target_identity: "file:/Users/zvf003/ZStack/oc-chan/src/renderer/src/SettingsView.tsx"
target_fingerprint: "sha256:d744e4ed89a72f51e2c9618808eddb5e51d810f22e504bde0fe062b6a5bb348a"
target_path: /Users/zvf003/ZStack/oc-chan/src/renderer/src/SettingsView.tsx
timestamp: 2026-11-02T11-03-56Z
slug: src-renderer-src-settingsview-tsx
closed: true
---
Method: dual-agent (A: SettingsCritiqueA · B: SettingsCritiqueB)

走查结论：**常规设置路径已跑通，发现 1 项 P1、2 项 P2，综合体验评分 29/40。** 本轮只做评估，没有修改业务源码。目标：`src/renderer/src/SettingsView.tsx`；模式：Operate。

设置页适合当前本机监控工具的使用场景：系统字体、绿色主题、原生单选框和开关保持一致；代码字体样本、托盘说明和休眠边界体现了产品用途。八项分类是明确需求，现有分类数量本身不是问题。主要改进点在放大后的布局、辅助文字可读性和失败后的恢复指引。

## 优先问题

**P1｜200% 放大后，设置详情出现横向裁切。**

原生内容窗口仍为 1280×860，Electron 放大至 200% 后，CSS 视口宽度为 640px，但页面被撑到 860px。详情从 x=390 开始，说明文字和控件右侧需要横向移动才能看全。

根因在 [styles.css:20](/Users/zvf003/ZStack/oc-chan/src/renderer/src/styles.css:20) 的全局最小宽度，以及 [settings.css:64](/Users/zvf003/ZStack/oc-chan/src/renderer/src/settings.css:64) 在窄空间仍保留双列布局。[现场截图](/Users/zvf003/ZStack/oc-chan/.impeccable/review/settings-walkthrough-2026-11-02/a-zoom-200.png)。

建议按可用 CSS 宽度重排：放大时收起主导航，将八项分类放到详情上方的可展开列表，详情单列显示，同时保留字号和焦点。对应 `$impeccable adapt`。

**P2｜侧栏辅助文字偏小，部分浅色文字对比不足。**

品牌副标题和底部设备说明在默认档为 10px。浅色主题下，品牌副标题、Agent 数量和定时任务数量的检测对比度为 **4.3:1**，低于普通小字的 4.5:1 标准。

位置见 [styles.css:26](/Users/zvf003/ZStack/oc-chan/src/renderer/src/styles.css:26)、[styles.css:40](/Users/zvf003/ZStack/oc-chan/src/renderer/src/styles.css:40) 和 [tokens.css:9](/Users/zvf003/ZStack/oc-chan/src/renderer/src/tokens.css:9)。[现场截图](/Users/zvf003/ZStack/oc-chan/.impeccable/review/settings-walkthrough-2026-11-02/b-light-zh-1280.png)。

建议提高辅助说明的最小字号，并调整浅色侧栏文字颜色，使这些文字达到至少 4.5:1。字号下限属于可读性设计标准，不能表述成 WCAG 规定了最小像素字号。对应 `$impeccable typeset`、`$impeccable colorize`。

**P2｜保存失败后，用户知道失败，但缺少具体恢复步骤。**

当前错误区直接显示 `settings:update`、`EISDIR`、`rename` 和临时文件路径，最后只提示“解决错误后重新选择”。保留真实错误和实际设置是正确的，但恢复动作仍需用户自行推导。

位置见 [SettingsView.tsx:100](/Users/zvf003/ZStack/oc-chan/src/renderer/src/SettingsView.tsx:100)。[错误截图](/Users/zvf003/ZStack/oc-chan/.impeccable/review/settings-save-error.png)来自此前真实失败场景，已与当前源码核对；本轮没有再次制造文件故障。

建议按真实错误类型显示“原因、影响、下一步”，将完整异常放入可展开、可复制的技术详情。例如该场景可明确说明“设置文件位置被同名文件夹占用，本次修改未保存，当前设置已保留”，再提供对应恢复指引。对应 `$impeccable clarify`，恢复动作配合 `$impeccable harden`。

## 体验评分

这是启发式设计评价，不是测试通过率或完整无障碍认证；十项均适用。

| 评价项 | 分数 | 主要依据 |
|---|---:|---|
| 系统状态可见性 | 3/4 | 分类、选中值、保存状态清楚；预览状态有歧义 |
| 与现实习惯匹配 | 3/4 | 说明具体；“托盘”和 macOS“菜单栏”术语有混用 |
| 用户控制与自由 | 3/4 | 可直接改回设置，焦点保留；返回时分类重置 |
| 一致性与标准 | 3/4 | 控件和视觉一致；原生设置菜单、对比度待完善 |
| 错误预防 | 4/4 | 受限选项、防重复提交、副作用说明完整 |
| 识别优于记忆 | 3/4 | 选项可见；放大后部分信息需要跨屏寻找 |
| 灵活性与效率 | 2/4 | 键盘路径可用；放大和返回分类增加操作成本 |
| 美观与简约 | 3/4 | 常规布局清楚；辅助文字和英文换行可改善 |
| 错误诊断与恢复 | 2/4 | 错误可见、设置保留；恢复指引不足 |
| 帮助与说明 | 3/4 | 每类有就近说明，Dock 与休眠边界尤其明确 |
| **总分** | **29/40** | **良好，以上三项优先改进** |

## 已经做得好的部分

- **键盘操作和焦点表现有效。** Tab 可进入选中的单选框、下拉框和开关；方向键、字体键盘选择、空格切换均有实际保存结果，焦点环可见。
- **最小窗口的常规显示成立。** 880×640、英文、深色、15px 下，已走查页面没有横向溢出，详情通过纵向滚动容纳。[窄窗截图](/Users/zvf003/ZStack/oc-chan/.impeccable/review/settings-walkthrough-2026-11-02/b-dark-en-880.png)。
- **桌面行为说明具体。** Dock 隐藏后的返回路径、退出释放防休眠、屏幕熄灭及合盖边界都有说明。

常规窗口的认知负荷检查没有发现明确失败项；200% 放大时，视觉层级和阅读上下文受到影响。正常操作以即时反馈结束，失败场景则容易结束在“知道失败，但不知道下一步”的状态。

## 不同使用者的风险

- **Sam，依赖放大或键盘：** 键盘基本路径已验证；主要风险是 200% 重排和辅助文字可读性。本轮未做 VoiceOver 验收。
- **Jordan，首次使用：** 正常设置说明足够；文件保存异常仍要求理解底层技术信息。
- **Alex，熟练用户：** 从“代码字体”离开再回来会回到“外观”；原生应用菜单没有设置入口及 `⌘,`，增加了少量重复操作。

## 小问题

- 暂停显示时，页头写“显示已暂停”，外观预览仍写“实时显示已开启”。预览区域有明确标签，因此不能据此判为业务状态错误；改成“状态样式示例”会更清楚。[现场截图](/Users/zvf003/ZStack/oc-chan/.impeccable/review/settings-walkthrough-2026-11-02/a-paused-preview.png)。
- 返回设置时可以保留最近分类。
- 可以补齐 macOS 设置菜单与 `⌘,`。
- 窄窗英文的 `behavior.`、`automatically.` 会单独落在最后一行，属于排版细节，文字没有截断。

## 检测结果

源码扫描为 0 项；三组实际界面扫描累计 **4 次 warning、6 次 advisory**，包含重复命中，不能算作十个独立问题。检测补充发现了小字、对比度和英文孤词换行；没有确认的技术误报，但字号阈值与孤词提示需要按实际用途判断。

原始截图、交互结果和检测 JSON 已保存到 `.impeccable/review/settings-walkthrough-2026-11-02/`。既有错误截图仍位于 `.impeccable/review/settings-save-error.png`。
