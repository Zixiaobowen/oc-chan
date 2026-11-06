# 2026-11-06 更新功能合并到 main

- Repo：`/Users/zixiaobowen/myProjects/oc-chan`
- 集成工作区：`/Users/zixiaobowen/myProjects/oc-chan-main-integration-20261106`，分支 `main`。
- 目标：按用户要求将更新功能合并到主分支并推送。原工作区继续保留在 `feat/app-updates`，不切换或清理并行任务的工作区。
- 合并双方：主线 `531cb6bd27cf5520434dd15b9c882d7770f13b6a`；更新功能 `430e663534d22aae411492958e385bef9490db02`。本文件随合并提交保存；最终提交标识和远端推送回执见本轮交付。

## 已完成的集成

- 更新检查、受限流式下载、取消、原生签名交接、更新设置和 OC 菜单栏图标合入近期主线。保留主线的办公拓扑、调度历史、事件、原生玻璃、无头开发与 IPC 安全边界。
- 更新插件接入现有主进程退出流程；在无头验收中拒绝打开外部发行说明页面，保持主线的外部操作限制。
- 沿用主线的 arm64 支持范围及冻结预算。发布工作流使用 macOS 26 arm64；发布准备只接受 arm64 DMG/ZIP，公开发布附件为两份安装文件、频道元数据和 SHA256SUMS.txt。没有恢复旧功能分支中的 Intel 发布范围。
- `js-yaml@4.3.2` 与 `semver@7.8.6` 作为构建依赖打入主进程，不恢复外置生产 node_modules。主进程与 renderer 分别生成许可证清单，包检查与依赖审计合并检查两份实际清单。
- 保留主线按受影响文件选择测试、真实 Electron smoke、原生模块签名、依赖审计和包内容/体积门禁。同步 README、PRODUCT、依赖审查说明及对应测试。

## 关键文件

- 生命周期与 IPC：`src/main/index.ts`、`src/main/plugins/app-updates.ts`、`src/preload/index.ts`、`src/shared/updates.ts`。
- 更新实现：`src/main/plugins/{update-controller,update-source,native-update}.ts`、`src/main/app-updates.test.ts`。
- 页面集成：`src/renderer/src/{App,SettingsView,UpdateSettings,main,updates}.tsx`、`updates.css`；调度历史及拓扑冲突保留主线实现。
- 发布与门禁：`.github/workflows/build.yml`、`package.json`、`package-lock.json`、`electron.vite.config.ts`、`scripts/{dist,release-config,prepare-release,publish-release,ci-tests,check-package,dependency-review}.mjs` 及相关测试、`docs/dependency-review-policy.json`。
- 原始功能验收：`docs/codex-handoffs/2026-11-05-app-updates.md`。其中双架构和依赖分类描述是功能分支历史状态，当前集成状态以本文件及 README 为准。

## 实际运行的验证

- `node --import tsx --test --test-concurrency=2 src/main/app-updates.test.ts scripts/prepare-release.test.mjs src/main/shutdown.test.ts src/main/ipc-boundary.test.ts src/main/schedule-history.test.ts src/main/collectors/hermes-history.test.ts src/main/plugins/schedules.test.ts src/renderer/src/view-state.test.ts scripts/ci-tests.test.mjs scripts/check-package.test.mjs scripts/dependency-review.test.mjs`：144/144 通过。
- 发布范围调整为 arm64 后，`npm run test:release`：17/17 再次通过；`node --check scripts/publish-release.mjs` 通过。上述 17 项是前一组的子集，不相加作为独立测试数量。
- `npm exec -- install-electron && npm run package`：类型检查、Vite、原生模块及真实 arm64 `.app` 打包通过。构建仍有 renderer chunk 超过 500 kB 的现有提示，不以关闭提示隐藏它。
- `npm run audit:dependencies -- --output release/dependency-review-arm64.json`：审查通过，报告 6 个受影响依赖节点；通过表示符合现有审查策略，不表示无漏洞。
- `node scripts/dist.mjs --arm64`：生成真实 DMG、ZIP 与 `latest-mac.yml`。
- `npm run check:package -- --app '<集成工作区>/release/mac-arm64/OC Chan.app' --arch arm64 --artifacts-dir release --output release/package-manifest-arm64.json`：内容及冻结预算通过；app=270796636、ASAR=2088220、Swift helper=134480 字节。
- 使用 `/usr/bin/shasum -a 256` 为上述实际 DMG/ZIP 生成校验清单，再调用 `prepareRelease` 生成临时发布目录：版本、架构、精确大小、SHA-512、SHA-256 校验和发布准备全部通过。临时发布副本已删除，真实产物保留。
- `node scripts/develop.mjs --inspect` 启动真实、隔离、无头 Electron；通过 CDP 点击设置，确认更新区域可见、开发模式明确禁用更新、根页面无横向溢出，浏览器错误列表为空，并截图。内容区 1280×860 CSS px、设备比例 2。开发宿主显示 Electron 版本 45.2.1；不据此宣称已安装的应用版本发生变化。
- 已释放本次浏览器接管并停止 `ocUpdatesMergeSmoke`；退出日志确认开发进程组已退出、隔离实例目录已清理。
- 没有运行全仓测试，没有重新执行历史原生窗口/性能压力验收；历史证据范围见原功能交接。

## 本地最终产物

位于集成工作区的 `release/`，均为本地 ad-hoc 包，未发布：

- `OC-Chan-0.1.0-mac-arm64.dmg`：119827022 字节；SHA-256 `d141c856d6ba767bfa4ec2f6c88e8c7cdae24d880bfdecde8b8fcca200ed9fe4`。
- `OC-Chan-0.1.0-mac-arm64.zip`：116337806 字节；SHA-256 `755b29520814478189c99bcbcae1d4cbb07f6faedc2ac33c39ef9557c0c5b282`。
- 包检查与依赖审计报告：`release/package-manifest-arm64.json`、`release/dependency-review-arm64.json`。

## 已知限制与授权边界

- 用户尚无 Apple 开发者账号。Developer ID 签名、公证、公开签名版本发布、重启后真实版本变化仍未验收；本地校验不能替代这些步骤。
- 本轮是合并并推送 main，不打版本标签、不创建 Release、不覆盖 `/Applications/OC Chan.app`。当前本机仓库没有启用 `core.hooksPath`；仓库中的 pre-push 安装脚本存在不等于此次推送执行了安装。
- 不公开私有源码、不清理用户数据、不删除分支或 worktree。已有另一发布会话时必须核对远端标签，不能重用历史标签或将本轮分支推送视为发布授权。
- GitHub Actions 的结果必须读取该提交对应的实际回执；本地通过不代表云端通过。

## 后续动作

1. 根据 main 的最终提交核对 GitHub Actions 结果及其产物，保持本地、云端、已安装应用和公开发布四类证据分开。
2. 用户取得 Apple 开发者账号后，配置 Developer ID 证书、公证凭据及公开分发仓库的最小权限令牌，不在聊天或源码保存凭据。
3. 核对未占用版本号和远端标签，通过签名发布门禁制作首个正式基线，再按授权手动安装。
4. 发布更高版本后，在实际安装应用验收检查、下载、取消、重启、版本变化及个人设置保留，并补充签名安装全进程树的资源验证。

恢复提示：继续 OC Chan main 的更新功能集成。原工作区在 feat/app-updates，隔离集成工作区为 `/Users/zixiaobowen/myProjects/oc-chan-main-integration-20261106`。主线与更新功能已解决冲突，保留办公拓扑、原生玻璃、无头/IPС边界、按影响范围测试、依赖和包体积门禁；当前发布范围为 arm64。144 项定向测试、调整后的 17 项发布测试、真实 Electron 设置页、DMG/ZIP及发布准备通过。先核对当前 main 和对应云端回执，不重复已通过且仍适用的检查；用户无 Apple 开发者账号，签名升级仍受阻，不能用本地 ad-hoc 包冒充发布或升级成功。
