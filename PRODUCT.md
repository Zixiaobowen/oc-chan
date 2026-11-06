# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop application for the local macOS workstation; the interface is rendered inside Electron.

## Stack

Implementation decision: Electron, React and TypeScript. Agent topology offers a Three.js office-building view and a 2D relationship view. The 3D renderer is loaded on demand and shares the existing observation contracts.

macOS Liquid Glass uses the public AppKit NSGlassEffectView through a small Objective-C++ N-API module, compiled with a macOS 26+ SDK. The only added package is a build-time Node API header dependency.

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
- The default 3D view models one project working directory per office floor and one agent per employee. Selecting a floor dims other floors without filtering observations or moving the camera. Missing directory evidence has an explicit unidentified-project floor; observed cross-project relationships remain visible. Floor focus, employee lookup, keyboard navigation and bounded in-floor workstation dragging support inspection. GPU resources, labels and position caches are bounded, with explicit rejection on overload and complete disposal on view exit.
- OMP nodes offer a context menu that navigates to the exact Tern session tab and presents its native window. Confirm session identity again before navigation; children use confirmed ancestry to locate their owning main session. A bundled Tern plugin exposes the logical window key in the native title, and an Accessibility helper selects the unique native window menu item and verifies stable foreground focus. Missing or stale targets, unavailable permissions, disabled integration, and failed native presentation produce a visible error. Native permissions, fullscreen transitions and foreground focus require separate acceptance for the merged version; headless checks do not establish these results.
- Native Liquid Glass has a 0–100 intensity slider, default 65; 0 turns it off. Chrome can reveal the native material while data remains on solid surfaces. Dragging previews without persistence, release saves, and keyboard adjustments save after 250ms. Escape, blur, hide or leaving settings cancels previews. Accessibility transparency/contrast preferences take precedence and retain the user's saved intensity.
- Development and automated acceptance use isolated headless Electron instances by default. A visible development window requires an explicit native-window interaction request.
- A bottom-left settings entry exposes appearance, theme, language, text size, interface font, code font, tray-click action, macOS login startup, Dock visibility and prevention of idle sleep together on one scrollable page. Each setting uses a direct radio group, select or switch; no category switching is needed. Theme swatches follow Tern's hover-to-preview and click-to-save interaction, with independent light/dark choices across six built-in palettes. Unsaved previews end on Escape, leaving the picker, window blur/hide or leaving settings. Local preferences apply immediately and persist across restarts; errors appear beside the affected setting and failed changes roll back. Login registration is owned by macOS, reflects actual system approval and is unavailable in development instances. Login startup stays in the menu bar without opening the main window or preventing sleep. The tray panel shares the main window's saved appearance and preferences.
- Signed macOS builds check the public installer repository `Zixiaobowen/oc-chan-releases` 30 seconds after launch and every six hours, with a manual check in settings. The source repository remains private and clients contain no GitHub credentials. A new version produces an in-app notice; download, cancellation and restart-to-install are explicit user actions. A normal quit discards the staged download without installing. Development and builds without Developer ID signing explain why updates are disabled. Development, CI and tag releases target arm64 in this phase, following the frozen package budgets; Intel is outside the supported scope. Tag releases require Developer ID signing, notarization and verified metadata. Live signed-release and installed-version-change validation remain blocked until the maintainer has an Apple developer account.
- OC Chan uses a blue-and-white brand palette and the OC mark. The macOS menu bar renders the monochrome mark as a 22 × 18 point template image with 1× and 2× representations.

## Evidence on Hand

The project started empty. Local OMP CLI and macOS launchd are available. Counts must come from runtime collection, not example data.

## Product Principles

- Make counts explainable by the underlying list and coverage.
- Refresh without interrupting inspection.
- Do not equate missing permissions with zero activity.
