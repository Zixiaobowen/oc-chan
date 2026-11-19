---
name: oc-chan-release-install
description: 用于 OC Chan 打包交付、准备或发布 GitHub 预览版和稳定版、检查 Release 附件与 Sparkle 更新源、安装或升级本机 OC Chan，以及验收安装和回滚。只要求 Git 提交或推送时使用 commit-push。
---

# OC Chan 发布与安装

以仓库根目录的 [发布与安装](../../../docs/distribution.md) 和 [更新事务契约](../../../docs/rust-migration/update-contract.md) 为准。开始时确定用户授权的操作、来源和目标。已有授权直接执行。Git 提交、推送、发布、替换正式应用和额外清理分别按各自的授权范围处理。

## 锁定交付来源

- 本地源码记录工作树、分支和完整 HEAD。若包含未提交改动，用 `delivery.json` 的源码清单与摘要标识实际构建输入。已有本地交付按用户给定的目录验证。
- GitHub 交付记录仓库 `Zixiaobowen/oc-chan`、完整提交 SHA、Actions 运行和精确标签。预览标签为 `preview-<运行编号>-<七位SHA>`，取包内产品版本时回读该提交的版本元数据。预览与稳定包可能有相同产品版本，用标签、提交和摘要确认实际来源。稳定标签为 `vX.Y.Z`，渠道以标签的 `regular` 或 `lts` 为准。
- 从当前回执或同一任务的会话上下文确认来源。发现工作树、标签、版本、渠道或摘要与目标不符时，保留证据并停止使用该候选。

## 本地打包与安装

1. 需要可交付的本机构建时，运行 `npm run delivery:local -- --out release/tauri/<新目录>`，以 `delivery.json`、源码清单和 `SHA256SUMS.txt` 确认交付完成。此路径面向 macOS arm64，基于独立源码快照构建。仅需目录包时使用 `npm run package`，同时需要 ZIP/DMG 时使用 `npm run dist`，从实际 `distribution.json` 取路径。
2. 用 `npm run install:local -- --check-delivery <交付目录>` 复核已有受管交付。获得替换正式应用的授权后，运行 `npm run install:local -- --delivery <交付目录>` 安装该交付，或用 `npm run install:local` 安装获授权的当前源码。工具管理安装锁、旧应用退出、同卷替换、就绪验证与出错还原。
3. 回读本次 `release/tauri/installations/installation-*/` 的 `installation.json`、`oc-local-install-*/receipt.json` 和 `installed.json`。核对 `/Applications/OC Chan.app`、版本和进程身份，以及真实 React 提交、IPC 往返、各采集分区和历史状态。按回执报告不可用或停用的数据源及原因。安装成功后的日志单独确认来源应用副本的清理结果。
4. 从 GitHub ZIP 或 DMG 手动安装时，先按下节验证下载，再检查候选应用的 arm64 架构、Bundle ID `local.oc-chan.desktop`、产品版本和实际 `codesign --verify --deep --strict` 结果。走文档的手动路径，保留可还原旧包，退出旧应用后整包替换唯一正式路径，实际检查新版本、界面、动作、采集、历史和设置。已下载附件与受管本地交付使用各自的入口和证据。

## GitHub 发布与下载

- 预览先查目标 SHA 的 `Build macOS`（`build.yml`）运行与对应 Release。需要且已授权重新触发 `main` 预览时，向 `build.yml` 提供 `--ref main -f expected_sha=<完整SHA>`。预览为 Pre-release。PR 和其他分支的构建只生成 Actions 产物。
- 稳定版按 [版本管理](../../../docs/distribution.md#版本管理) 执行。在 `main` 运行 `release-prepare.yml`，传入 `bump` 和从文件读取的 `notes`，等待版本 PR 的指定提交验证；按授权审阅和合并，核对发布说明、双语 README 及远端 `main`。版本就绪后用 `release-stable.yml` 的 `version`、`channel` 发布，记录实际选中的 `main` SHA、不可变标签与标签构建。保持已选版本和渠道。稳定签名在 CI 使用 `SPARKLE_PRIVATE_KEY`，核验使用仓库公钥。私钥和令牌始终留在各自的凭据存储中。
- 用 `gh run view` 回读实际 `headSha`、运行结果和发布 job。再按精确标签读取 GitHub Release，核对已公开状态、标签对应的提交、预览标记及完整附件集合。两类均须有对应版本的 arm64 ZIP、DMG 和 `SHA256SUMS.txt`，稳定版另须有 `appcast.xml`。核对 GitHub 附件大小、`state=uploaded` 和 `sha256:` 摘要。需要证明公开下载时，从无凭据下载入口把精确附件取到独立目录，对下载字节重算摘要并与 GitHub 回读比对。
- 从仓库根目录复用现有附件校验。`assets_dir` 为下载目录，`version` 为该构建的产品版本，`appcast_asset` 在稳定版设为 `appcast.xml`，预览设为空。脚本校验 ZIP/DMG 摘要，稳定版同时验证 feed 与 ZIP 的 Ed25519 签名、版本、长度及归档 URL。CI 的发布准备另核对 `package-manifest-arm64.json`，该清单随 Actions 产物保存。

  ```sh
  node --input-type=module - "$assets_dir" "$version" "$appcast_asset" <<'NODE'
  import { inspectReleaseAssets } from './scripts/prepare-release.mjs'
  const [directory, version, metadataName] = process.argv.slice(2)
  const { assets } = await inspectReleaseAssets({ directory, version, metadataName })
  console.log(JSON.stringify(assets, null, 2))
  NODE
  ```

- 发布中断时先检查相关运行、版本分支、PR、标签、草稿和附件，再判断能否按原目标恢复。摘要、签名或来源失败须保留现场。已有标签和 Release 附件保持不可覆盖。

## Sparkle 更新验收

- 验证线上更新源时，先回读 GitHub `Latest` 指向的稳定标签。实际读取 `https://github.com/Zixiaobowen/oc-chan/releases/latest/download/appcast.xml`，将响应与该稳定版已验签附件比对。普通版 feed 可能保留较早的 LTS 条目。核对用户请求的 `regular` 或 `lts` 策略和预期目标版本。
- `npm run smoke:renderer -- --scenario updates` 验证隐藏 Tauri 的更新探测。`npm run smoke:updates` 验证隔离的 Sparkle 安装链路。需要验证线上原地升级时，先核对本机起始版本、更新策略和操作授权，再通过正式应用的 Sparkle 界面验证检查、下载、替换及重启，回读实际路径、目标版本和功能状态。旧版没有 Sparkle 时用手动安装路径。代码签名、Sparkle 验签和 Apple 公证分别记录。

## 清理与回执

- 保留 ZIP/DMG、日志、安装和回滚回执、源码及个人数据。只处理本次归属明确的临时应用副本。额外清理先在相关工作树运行 `npm run cleanup:local` 看候选，只有候选全属已授权范围才用 `npm run cleanup:local -- --apply`。源码 worktree 收尾走 [独立门禁](../../../docs/development.md#任务收尾)。
- 失败时保留原始错误、暂存、`replace-journal.json` 和安装锁现场，核实旧应用是否已还原并运行。在 `installed.json` 已写入但清理失败的情况下，分别报告安装结果与清理故障。
- 交付给用户的回执写明实际提交或标签、版本、渠道、Actions 和下载链接、摘要及签名结果。涉及安装时写明正式路径、实际运行版本及就绪证据，另列回滚和清理的实际状态。每项只认本次取得的证据。
