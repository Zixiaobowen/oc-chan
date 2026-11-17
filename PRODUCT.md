# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop

macOS 原生桌面应用；`crates/oc-desktop` 使用 GPUI / Metal 绘制界面与拓扑画布。

## Stack

实现采用 Rust core 与 GPUI 桌面宿主。Agent 拓扑的项目建筑视图与 2D 关系视图由原生画布承载，共享真实观察契约；Rust 负责采集、有界 IO、SQLite worker、插件生命周期、设置、事件和更新事务。Node 仅用于开发、构建编排及验收工具，产品不运行 React、WebView 或 Three.js。

macOS Liquid Glass uses the public AppKit NSGlassEffectView through a small Objective-C++ C ABI bridge compiled with a macOS 26+ SDK. Swift handles verified Tern window navigation. Native plugins use the versioned Rust SDK and separate, bounded processes; production contains no Electron, N-API or CommonJS execution host.

## Users

The workstation owner checking local agent activity, scheduled tasks and machine health.

## Product Purpose

Query and display running agents and subagents, local scheduled tasks, and live system monitoring in a desktop application.

## Capabilities and Constraints

- Use real local data. Display unavailable sources and limits explicitly.
- Distinguish live processes from active model work, and recurring schedules from services.
- Read-only inspection; task execution, process termination, cloud accounts and remote machines are outside this request.
- Data sources exposes persistent switches for agent, schedule/history, system and local event collection. All are enabled by default; disabling collection leaves upstream agents and jobs untouched. Retained snapshots are marked with their timestamps, current counts become unknown, and re-enabling starts fresh collection baselines or restores the durable event cursor. Display pause remains independent.
- Local events retain only confirmed Hermes execution/delivery failures and sustained source outage/recovery metadata. Initial history is baselined; retention, deduplication and query queues are bounded, and excluded coverage is explicit. No task bodies are stored. Local notifications are off by default; explicit source/task subscriptions and type filters control delivery, with local quiet hours, a rolling limit of three notifications per minute and durable non-replay claims. Task names require opt-in. Notification permission is requested only by an explicit user action; denied or unavailable notifications do not stop event collection. Native permission and click acceptance remain separate from headless checks.
- macOS is the initial implementation target based on the current workstation. Other OS support is undecided.
- Chinese and English interface with an option to follow the system language, keyboard-accessible controls, usable in a resizable desktop window.
- Display agents and subagents as an interactive topology canvas, as requested by the user. Draw only observed parent relationships; retain relationship context while filtering, and support zoom, pan, branch collapse and node details.
- The default 3D view models one root-agent project directory per building and each confirmed task branch per floor. A main agent has an office; child agents share workstations and follow their main task across directories. Missing parents, cycles and unconfirmed roots remain explicitly unassigned. Floor focus, employee lookup, keyboard navigation and bounded workstation dragging support inspection. GPU resources, labels and position caches are bounded, with explicit rejection on overload and complete disposal on view exit.
- OMP nodes offer a context menu that navigates to the exact Tern session tab and presents its native window. Confirm session identity again before navigation; children use confirmed ancestry to locate their owning main session. A bundled Tern plugin exposes the logical window key in the native title, and an Accessibility helper selects the unique native window menu item and verifies stable foreground focus. Missing or stale targets, unavailable permissions, disabled integration, and failed native presentation produce a visible error. Native permissions, fullscreen transitions and foreground focus require separate acceptance for the merged version; headless checks do not establish these results.
- Native Liquid Glass has a 0–100 intensity slider, default 65; 0 turns it off. Chrome can reveal the native material while data remains on solid surfaces. Dragging previews without persistence, release saves, and keyboard adjustments save after 250ms. Escape, blur, hide or leaving settings cancels previews. Accessibility transparency/contrast preferences take precedence and retain the user's saved intensity.
- 开发与自动验收默认使用隔离、真实隐藏的 GPUI 窗口。认证 Unix driver 和 Metal capture 只编译进 `acceptance` 构建；生产不包含验收入口。可见开发窗口仍需明确原生交互请求，隐藏窗口截图不证明 Dock、系统权限、VoiceOver 或可见呈现效果通过。
- A bottom-left settings entry exposes appearance, theme, language, text size, interface font, code font, tray-click action, macOS login startup, Dock visibility and prevention of idle sleep together on one scrollable page. Each setting uses a direct radio group, select or switch; no category switching is needed. Theme swatches follow Tern's hover-to-preview and click-to-save interaction, with independent light/dark choices across six built-in palettes. Unsaved previews end on Escape, leaving the picker, window blur/hide or leaving settings. Local preferences apply immediately and persist across restarts; errors appear beside the affected setting and failed changes roll back. Login registration is owned by macOS, reflects actual system approval and is unavailable in development instances. Login startup stays in the menu bar without opening the main window or preventing sleep. The tray panel shares the main window's saved appearance and preferences.
- 具备 Developer ID 更新资格的 macOS 构建在启动30秒后及每6小时检查固定公开源 `Zixiaobowen/oc-chan`，客户端不含 GitHub 凭据。设置保留手动检查；开发和 ad-hoc 构建可查询新版并显示真实错误，但不能下载或安装。发现新版仅提示，下载、取消和重启安装均为显式操作，普通退出丢弃暂存。当前开发、CI、标签发布目标均为 arm64；沿用冻结包预算，Intel 不在支持范围。标签发布须签名、公证并校验元数据；GPUI 的实际签名发布和已安装版本升级仍需独立验收。
- OC Chan uses a blue-and-white brand palette and the OC mark. The macOS menu bar renders the monochrome mark as a 22 × 18 point template image with 1× and 2× representations.

## Evidence on Hand

The project started empty. Local OMP CLI and macOS launchd are available. Counts must come from runtime collection, not example data.

GPUI 迁移保留上述全部功能与设计要求，不因实现或验收缺口删减范围。当前文档不证明 GPUI 构建、视觉、交互或正式安装已通过；旧宿主验收只能作为历史证据。

## Product Principles

- Make counts explainable by the underlying list and coverage.
- Refresh without interrupting inspection.
- Do not equate missing permissions with zero activity.
