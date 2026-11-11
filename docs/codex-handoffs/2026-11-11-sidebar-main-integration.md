# 侧栏收起整合交接（2026-11-11）

## 范围与来源

用户授权本会话侧栏功能进入 GitHub main，并更新本机应用。集成工作树为 `/Users/zvf003/ZStack/oc-chan-sidebar-main-20261111`，基于 `origin/main` 的 `e613d02`；原工作区 `/Users/zvf003/ZStack/oc-chan` 含并行改动，只读取指定侧栏 diff，未修改、暂存或提交原目录。

## 当前实现

- 最新 main 已采用 Rust / Tauri 2 / WKWebView。偏好新增在 `crates/oc-core/src/settings/model.rs` 与 `src/shared/settings.ts`，沿用 Rust 设置存储、严格补丁解析及现有 React 保存队列，未恢复 Electron 文件。
- 固定红绿灯旁按钮及 ⌃⌘S 切换；收起后核心页面、市场和已安装插件出现在顶栏，来源及设置在右侧。展开时保留 main 新增的插件分组、市场生命周期和插件面包屑。
- 分隔线最小188px，再向左64px收起；恢复拖动前宽度。取消、隐藏、失焦与卸载均释放拖动资源和选择阻止监听。宽度与收起偏好独立保存。
- 保存过程中不以较早回执覆盖最新切换意图；队列排空后按实际设置收敛，失败回滚并给出侧栏布局错误和重试。导航隐藏文字仍有显式无障碍名称。
- 使用200ms CSS短过渡，无View Transitions依赖或覆盖点击的快照层；减少动态效果时取消。窄视口使用现有popover菜单，快捷键开关菜单而不改写偏好。
- 中英文README、当前开发文档与功能参考同步。原diff中的发布渠道和拓扑菜单改动未移植。

## 变更文件

- `src/renderer/src/App.tsx`
- `src/renderer/src/SidebarResizeHandle.tsx`
- `src/renderer/src/SettingsSaveError.tsx`
- `src/renderer/src/styles.css`
- `src/shared/settings.ts`
- `crates/oc-core/src/settings/model.rs`
- `scripts/smoke-renderer.mjs`
- `scripts/smoke/scenarios.mjs`
- `scripts/smoke/sidebar-scenarios.mjs`
- `scripts/smoke/notification-scenarios.mjs`（导出现有隔离设置写拒绝 helper 供复用）
- `README.md`、`README.en.md`
- `docs/development.md`、`docs/features.md`
- 本交接文件

## 验证交给主代理

实现子代理按分工未运行测试、构建、lint、formatter、安装或推送，以下为待执行命令，不是通过声明：

```sh
npm run typecheck
cargo test -p oc-core --lib settings::
npm run smoke:renderer -- --scenario sidebar --out /tmp/oc-chan-sidebar-20261111-new
```

输出目录必须不存在。`sidebar` 场景先通过既有市场场景离线安装真实系统插件，再验收所有顶栏入口、来源设置、固定按钮、快速队列、64px拖动阈值与宽度保留、真实设置目录写拒绝回滚和重试、880px大字号英文与640px紧凑导航，读取实际settings.json并复用相同profile重启。写拒绝复用通知场景的 `withSettingsWriteDenied`，只操作经过身份确认的隔离profile目录，在finally精确恢复权限；宿主fault-command只支持monitor命令，不用于settings。拖动明确发送Driver的drag类型（AppKit LeftMouseDragged），并断言按下已进入resizing状态。完整 `all` 场景也包含这项验收。

主代理可另运行 Impeccable 机械检查（子代理禁止运行 lint）：

```sh
/Users/zvf003/.omp/agent/skills/impeccable/scripts/impeccable detect --json src/renderer/src/App.tsx src/renderer/src/SidebarResizeHandle.tsx src/renderer/src/SettingsSaveError.tsx src/renderer/src/styles.css
```

快捷键及同步快速连点由DOM事件触发React，脚本明确标注；普通导航、按钮、拖动使用真实AppKit输入。无头不证明可见动画、原生快捷键或VoiceOver验收。安装后主代理在真实窗口检查 ⌃⌘S、连续反向点击、拖动收起/恢复、紧凑导航、系统减少动态效果及VoiceOver名称；重启确认偏好。提交、推送、GitHub回执及 `npm run install:local` 均由主代理完成，并补充实际结果。

## 设计上下文说明

已读取 graphify/impeccable 指引并使用当前App实际实现作为窄范围移植依据；未构建新图谱。Impeccable提示design sidecar过期，属于既有设计文档漂移，不在本任务修复范围。子代理依照明确简报完成，无新增视觉方向访谈。

## 主代理执行记录

- `npm run typecheck` 通过。
- `env PATH="/Users/zvf003/.cargo/bin:$PATH" cargo test -p oc-core --lib settings::`：1 passed，206 filtered out。
- 首次命令环境缺少 Cargo 路径；仅为本次命令添加已安装的 `~/.cargo/bin`，未修改全局配置。
- 首次真实 WK 场景在拖动阈值处失败；截图显示260px未移动。根因为脚本向原生驱动发送 `move`，对应无按键 `NSEventTypeMouseMoved`。已改成 `drag` 对应 `NSEventTypeLeftMouseDragged`，保留63/64px边界断言并新增拖动已开始断言。产品代码未为此改变。
- 宿主不支持对 `settings_update` 使用 fault-command；改用既有隔离profile写拒绝helper，finally恢复权限，保留回滚/重试断言。
- `npm run smoke:renderer -- --scenario sidebar --out /tmp/oc-chan-sidebar-20261111-resumed`：`complete:true`、`errors:[]`。真实WK导航、拖动阈值、失败回滚重试、紧凑菜单及同profile重启通过，已查看收起布局截图。测试进程与实例清理由runner确认。未进行可见动画/原生快捷键/VoiceOver及性能前后对比验收，不宣称这些通过。
- 已快进整合远端 `18a2e94`（仅安装证据文档）。功能提交 `4c8f8edff641754e5b6803018df2face3d32fec4` 已正常推送 GitHub main，GitHub API 回读同SHA。
- `env PATH="/Users/zvf003/.cargo/bin:$PATH" npm run install:local` 成功。生产包安装至 `/Applications/OC Chan.app`，真实React、IPC、Agent/任务/事件采集及Hermes历史就绪，PID 40166。版本字段仍为0.1.0，本次内容以提交SHA识别。系统插件保持未安装状态。
- 安装证据：`release/tauri/installations/installation-lYqYjB/installed.json`，同目录 `oc-local-install-cc93ae52-4dde-4e78-bbf6-767c41461969/receipt.json`。仅安装器清理本次构建来源app；个人数据、原工作区及所有工作树保留。
- 中英文README均已审阅并同步侧栏操作。最终证据补记仅修改本交接，不影响README事实，无需再次改写。云端CI另行报告，不以安装通过代替CI。

## 恢复提示与下一步

在 `/Users/zvf003/ZStack/oc-chan-sidebar-main-20261111` 的 `feat/sidebar-main-20261111` 继续；用户已授权推送 GitHub main 并更新本机应用。保留原混合工作区及其他工作树。

1. 如需继续视觉验收，在正式应用核对原生快捷键和可见动画；当前不宣称完成。
2. 后续修改以最新远端main为基线，保留原目录混合工作。
3. 查看GitHub本次提交的CI结果；本地定向验收和安装回执已完成。

## 原生对齐纠正

用户反馈按钮低于真实红绿灯后，以AppKit按钮frame和WK顶部inset实测定位：原生中心16pt，旧DOM中心27px，偏差11pt。侧栏按钮改为top=2px、height=28px；详情及原生几何验证方法见 [原生标题栏对齐交接](2026-11-11-native-sidebar-alignment.md)。新增driver字段与局部CSS已实现，最终定向场景及安装后的可见对齐由主代理补记，不沿用上次无头截图宣称原生对齐通过。
