# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop application for the local macOS workstation; the interface is rendered inside Electron.

## Stack

Implementation decision: Electron, React and TypeScript. No existing code or framework was present. This is an implementation choice, not a claimed user preference.

## Users

The workstation owner checking local agent activity, scheduled tasks and machine health.

## Product Purpose

Query and display running agents and subagents, local scheduled tasks, and live system monitoring in a desktop application.

## Capabilities and Constraints

- Use real local data. Display unavailable sources and limits explicitly.
- Distinguish live processes from active model work, and recurring schedules from services.
- Read-only inspection; task execution, process termination, cloud accounts and remote machines are outside this request.
- macOS is the initial implementation target based on the current workstation. Other OS support is undecided.
- Chinese and English interface with an option to follow the system language, keyboard-accessible controls, usable in a resizable desktop window.
- Display agents and subagents as an interactive topology canvas, as requested by the user. Draw only observed parent relationships; retain relationship context while filtering, and support zoom, pan, branch collapse and node details.
- OMP nodes offer a context menu that navigates to the exact Tern session tab and presents its native window, including the two native fullscreen windows verified on this workstation. Confirm session identity again before navigation; children use confirmed ancestry to locate their owning main session. A bundled Tern plugin exposes the logical window key in the native title, and an Accessibility helper selects the unique native window menu item and verifies stable foreground focus. Missing or stale targets, unavailable permissions, disabled integration, and failed native presentation produce a visible error.
- A bottom-left settings entry exposes appearance, theme, language, text size, interface font, code font, tray-click action, macOS Dock visibility and prevention of idle sleep together on one scrollable page. Each setting uses a direct radio group, select or switch; no category switching is needed. Theme swatches follow Tern's hover-to-preview and click-to-save interaction, with independent light/dark choices across six built-in palettes. Unsaved previews end on Escape, leaving the picker, window blur/hide or leaving settings. Local preferences apply immediately and persist across restarts; errors appear beside the affected setting and failed changes roll back. The tray panel shares the main window's saved appearance and preferences.
- Signed macOS builds check a separate public installer repository 30 seconds after launch and every six hours, with a manual check in settings. A new version produces an in-app notice; download, cancellation and restart-to-install are explicit user actions. A normal quit discards the staged download without installing. Development and unsigned builds explain why updates are disabled. Release automation requires Developer ID signing, notarization and verified metadata for both Mac architectures. Live signed-release and installed-version-change validation is blocked until the maintainer has an Apple developer account.
- The macOS menu bar uses the existing OC brand mark as a 22 × 18 point template image with 1× and 2× representations.

## Evidence on Hand

The project started empty. Local OMP CLI and macOS launchd are available. Counts must come from runtime collection, not example data.

## Product Principles

- Make counts explainable by the underlying list and coverage.
- Refresh without interrupting inspection.
- Do not equate missing permissions with zero activity.
