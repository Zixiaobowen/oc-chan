# 更新与安装事务契约

应用内更新由 `src-tauri` 的 Rust 宿主接入 Sparkle 2.10.1，React 设置页运行于系统 WKWebView。旧 `oc-core` 更新控制器、`latest.json` 与在线安装助手已删除，不保留兼容路径。`oc-installer` 保留本地安装就绪库；本地交付安装和 Sparkle 在线更新各自取得证据，不能宣称复用同一替换、回滚或就绪事务。实现存在不代表已发布资产、完成真实更新安装或替换本机正式应用。

## 发布源与签名

生产源固定为 `https://github.com/Zixiaobowen/oc-chan/releases/latest/download/appcast.xml`，客户端不含 GitHub 凭据，不接受用户自定义源或生产测试地址。稳定版 appcast 与 ZIP 都使用 Ed25519 签名；公钥来自 `resources/sparkle.json`。本机私钥保存在专用 macOS keychain 的 `local.oc-chan.desktop` 账号，CI 使用 `SPARKLE_PRIVATE_KEY` Secret；私钥不得进入源码、日志、公开文档或发布附件。

开启 `SUVerifyUpdateBeforeExtraction` 和 `SURequireSignedFeed`，签名过期 fallback 为 0；不得在签名无效、过期或缺失时降级为未签名更新。固定 Bundle ID 为 `local.oc-chan.desktop`，发布版本遵循稳定 `X.Y.Z`，版本、归档与 appcast 必须一致，失败保留真实错误，不把检查失败显示为已是最新版本。

Sparkle 来自完整官方 2.10.1 framework，归档 SHA-256 与逐文件 pin 共同核验来源与内容。上游签名 helpers 以及签名封印内的 Headers/Modules 必须保留，不裁剪或重签上游 helpers。主应用可采用 ad-hoc 签名，应用更新不再以缺少 Developer ID 为禁用理由。Ed25519 验证不等于 Apple Developer ID、公证或 Gatekeeper 认可，也不免除首次安装的用户批准；不要求付费 Apple 开发者会员。

## 宿主与 Sparkle 的职责

React 设置显示更新状态和自动检查选项，显式检查经 Tauri 命令交给 Sparkle；下载、安装、用户确认与重启由 Sparkle 标准界面管理。正常安装版的自动检查由 Sparkle 调度，不再由 Rust 核心维护启动延时和周期。自动下载关闭，普通退出不自动安装更新。

开发与无头实例只探测更新，不启动标准下载/安装界面。更新场景独立使用 `npm run smoke:renderer -- --scenario updates`，不能把探测成功当作安装或重启成功。旧版 0.2.0 没有 Sparkle，首次切换必须手动安装带 Sparkle 的新包。

## 本地安装就绪

本地安装继续核验交付来源、目标身份、受控路径与实际签名，使用真实新应用的就绪证据；失败保留现场，不能只凭进程存活判定安装成功。`src-tauri/src/readiness.rs` 等待真实主窗口文档握手及 React 提交，`ReadyEvidence` 包含 `renderer_entry="main:index.html:react-commit"`、`renderer_committed=true`、`action_round_trip=true`，以及采集、历史和插件状态。没有的数据源应明确表达 unavailable/disabled，不能填成功空结果或跳过已安装但失败的插件。

该就绪库属于本地安装流程，不是 Sparkle 安装完成的自定义提交门禁。正式应用替换须另获授权，遵循[本地交付与手动升级](../distribution.md#本地交付与手动升级)中的退出、整包替换、就绪核验与失败保全规则。

## 构建与验收边界

`release/tauri/` 的 `build.json` 使用 schema 3 和 `renderer: "react"`；开发 features 为 `["acceptance", "custom-protocol"]`，生产为 `["custom-protocol"]`。稳定版发布签名 `appcast.xml`，不再产生旧 schema 2 的 `latest.json`。认证 driver、WKWebView 探针与截图只在 acceptance 构建；测试源和验收入口不得进入生产。

签名工具测试、宿主测试、真实隐藏场景、标准 Sparkle 界面、真实安装/重启以及生产包体积分别验收。不得用单测或 ad-hoc 包测试宣称 Apple 公证通过，不得把历史包体积当作新增 framework 的体积结果；真实隐藏和安装流程的结果以独立回执为准。

所有新构建应用归入受控 release 目录；源码 worktree、分支、用户数据、ZIP/DMG 与证据不自动删除。`push:main` 仍须等 GitHub 实际接收且远端确认后才清理归属明确的资源，不把 pre-push 视为成功。
