# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

macOS 桌面应用中的 React 界面；`src-tauri` 使用 Tauri / WKWebView 承载前端，保留系统窗口与原生平台能力。

## Stack

实现采用 Rust core 与 Tauri 桌面宿主，React 负责界面、React Flow 负责 2D 关系图、Three.js 负责项目星系。Rust 负责采集、有界 IO、SQLite worker、插件生命周期、设置、事件和 Sparkle 更新接线。Node 仅用于开发、构建编排及验收工具；生产后台不运行 Node。

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
- The default 3D view groups each root-agent project directory into a galaxy and each confirmed task branch into a star system. Main agents and subagents have distinct celestial representations and children follow their actual task across directories. Missing parents, cycles and unconfirmed roots remain explicitly unassigned. Project and task focus, agent lookup, keyboard navigation and bounded dragging support inspection. Decorative stars do not represent additional agents or activity. GPU resources, labels and position caches are bounded, with explicit rejection on overload and disposal on view exit.
- In the 2D view, OMP nodes offer a context menu that navigates to the exact Tern session tab and presents its native window. Confirm session identity again before navigation; children use confirmed ancestry to locate their owning main session. A bundled Tern plugin exposes the logical window key in the native title, and an Accessibility helper selects the unique native window menu item and verifies stable foreground focus. Missing or stale targets, unavailable permissions, disabled integration, and failed native presentation produce a visible error. Native permissions, fullscreen transitions and foreground focus require separate acceptance for the merged version; headless checks do not establish these results.
- Native Liquid Glass has a 0–100 intensity slider, default 65; 0 turns it off. Chrome can reveal the native material while data remains on solid surfaces. Dragging previews without persistence, release saves, and keyboard adjustments save after 250ms. Escape, blur, hide or leaving settings cancels previews. Accessibility transparency/contrast preferences take precedence and retain the user's saved intensity.
- 开发与自动验收默认使用隔离、真实隐藏的 Tauri / WKWebView 窗口。认证 Unix driver 和 WebKit capture 只编译进 `acceptance` 构建；生产不包含验收入口。可见开发窗口仍需明确原生交互请求，隐藏窗口截图不证明 Dock、系统权限、VoiceOver 或可见呈现效果通过。
- A bottom-left settings entry exposes appearance, theme, language, text size, interface font, code font, tray-click action, macOS login startup, Dock visibility and prevention of idle sleep together on one scrollable page. Each setting uses a direct radio group, select or switch; no category switching is needed. Theme swatches follow Tern's hover-to-preview and click-to-save interaction, with independent light/dark choices across six built-in palettes. Unsaved previews end on Escape, leaving the picker, window blur/hide or leaving settings. Local preferences apply immediately and persist across restarts; errors appear beside the affected setting and failed changes roll back. Login registration is owned by macOS, reflects actual system approval and is unavailable in development instances. Login startup stays in the menu bar without opening the main window or preventing sleep. The tray panel shares the main window's saved appearance and preferences.
- 应用更新通过 Rust 宿主接入 Sparkle 2.10.1，固定使用 `Zixiaobowen/oc-chan` 的稳定 appcast，以 Ed25519 校验 feed 和 ZIP；无需付费 Apple 会员。设置保留手动检查与自动检查开关，下载、安装和重启由 Sparkle 标准界面负责；自动下载关闭，普通退出不自动安装。开发/无头实例只探测，默认 ad-hoc 签名不等于 Apple 公证。当前开发、CI、发布目标为 arm64；包预算和真实安装验收继续独立执行。
- OC Chan uses a blue-and-white brand palette and the OC mark. The macOS menu bar renders the monochrome mark as a 22 × 18 point template image with 1× and 2× representations.

## Evidence on Hand

The project started empty. Local OMP CLI and macOS launchd are available. Counts must come from runtime collection, not example data.

2026-11-17 用户确认恢复 React 界面并保留 Rust 核心。复用迁移前的完整界面、设计体系和 Three.js 场景，同时保留后续 Rust 功能；不因技术替换删减范围。历史截图与测试仅作参考，恢复后的构建、界面、交互和正式安装须分别验证。

## Product Principles

- Make counts explainable by the underlying list and coverage.
- Refresh without interrupting inspection.
- Do not equate missing permissions with zero activity.
