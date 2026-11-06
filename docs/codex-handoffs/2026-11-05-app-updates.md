# OC Chan 应用更新与菜单栏图标 · 2026-11-05

本文件记录原功能分支的实现与验收；2026-11-06 合入近期主线后的 arm64 发布范围、依赖分类及验证结果见 [主线集成交接](2026-11-06-app-updates-main.md)。

- Repo：`/Users/zixiaobowen/myProjects/oc-chan`
- 工作分支：`feat/app-updates`，从本轮开始时的 `master` 创建。
- 目标：应用版本提醒、下载、重启安装；替换 macOS 菜单栏机器人图标；成功后发布版本并在本机验证升级。
- 状态：实现、定向测试、本地 arm64 DMG/ZIP 与真实窗口验收已完成；真实签名发布及版本升级验收被 Apple 开发者账号阻塞。用户已明确自己尚无 Apple 开发者账号，并选择先完成本地验证。未发布、推送或覆盖 `/Applications`。

## 用户决定与授权

源码保持私有，安装包通过独立公开仓库 `Zixiaobowen/oc-chan-releases` 分发。选择 Developer ID 签名后的应用内下载、重启安装。用户追加授权“做好成功后测试下，可以发一个版本后用本机测”；随后确认没有 Apple 开发者账号，因此没有发布未签名版本来冒充自动安装验收。不能将选择公开分发误解为公开源码。

开始时 `docs/codex-handoffs/2026-11-04-github-release-publishing.md` 已有其它任务修改，本轮未改该文件。其它会话可能仍在处理旧发布流程；后续必须核对实际远端版本和工作区，不能重发已用标签。

## 实现

- `src/shared/plugins.ts` 是最小插件生命周期契约；`src/main/plugins/app-updates.ts` 注册受信任窗口 IPC、签名门禁与原生安装交接。主进程负责插件启动、退出资源清理，Squirrel 拥有最终退出/替换/重启，避免原有 `app.exit()` 抢先跳过安装。
- `update-source.ts` 从固定公开 GitHub 地址读取 `latest-mac.yml`，禁止向不受信任域名或 HTTP 跳转。元数据上限 64 KiB，无 YAML 引用/标签；只选择当前架构 ZIP，稳定版不接收预发布或降级。ZIP 上限 512 MiB，流式写盘，校验精确长度与 SHA-512，预先检查磁盘空间。
- `update-controller.ts` 串行执行检查/下载/安装，取消下载不被操作锁阻塞；启动 30 秒及每 6 小时检查，手动检查重置计时器。检查/下载/原生交接分别限时 30 秒/15 分钟/120 秒；常规进度每 250ms 节流，完成时立即推送最终状态。退出或停用取消请求、释放定时器和临时文件；重新启用清除旧候选状态。
- `native-update.ts` 使用仅绑定 `127.0.0.1` 的临时 feed，随机访问路径、feed 鉴权、最多两条连接，64 KiB 流式交付给 Electron 内置 Squirrel.Mac；仅在原生签名验证及暂存完成后允许主程序清理并退出安装。原生迟到错误有插件级监听，最终交接失败会明确报错并退出，不留下停止服务的空窗口。
- 普通退出不自动安装，会清理 ZIP；明确点击“重启并安装”才交接原生更新器。旧版若没有更新入口，需要先手动安装一个签名的新版本，才能测试后续原地更新。
- `src/shared/updates.ts`、preload、renderer `updates.tsx` / `UpdateSettings.tsx` / `updates.css`：单一主窗口订阅、递增 revision 防乱序，设置页全部状态和操作、新版提示跳转及焦点、中英文、长错误换行。开发模式和未签名包明确禁用；没有客户端令牌或伪造成功状态。
- `src/main/desktop-settings.ts`：机器人位图替换为既有 `resources/brand/oc-chan-mono.svg` 对应的单色 OC 标志，22 × 18 pt，1× / 2× PNG，保持 template image。未改 Dock 图标或其它品牌入口。
- `package.json`、`.github/workflows/build.yml`、`scripts/{dist,release-config,prepare-release,publish-release}.mjs`：普通构建 unsigned；匹配版本的 tag push 才强制 Developer ID 签名、公证和 codesign/stapler/spctl 验证（包括 Swift helper）。独立公开仓库发布，两个架构元数据逐文件核验后合并，先 draft 上传全部资产再公开，不覆盖同名版本，不泄漏私有提交。
- 直接运行时依赖 `js-yaml`、`semver`，与 `argparse` 本地目录合计约 1.46 MiB；均复用已有打包链依赖。评估过的 `electron-updater` 已移除，因其当时版本 metadata 累积无字节上限且 MacUpdater 内部服务无公开 dispose。安装仍由 Electron 原生 Squirrel 完成，未自制应用替换器。
- README、PRODUCT 与本交接同步说明发布门槛和验证范围。

## 实际验证

- `node_modules/.bin/tsx --test src/main/app-updates.test.ts`：最终 10/10 通过。覆盖架构/版本选择、预发布及降级、元数据/文件大小限制、路径与域名、校验失败清理、100 个并发检查合并、取消下载、25 次禁用生命周期、手动操作不被启动计时器覆盖，以及错误态不能绕过签名门禁。
- `npm run test:release`：17/17 通过，后续发布脚本未再变化。覆盖 stable/beta/rc 双架构合并、版本/架构/哈希/大小/路径/重复/缺失文件、错误标签和缺 Secrets。
- `npm run build`：最终 TypeScript、Swift helper、主进程、preload、renderer 构建通过。
- `node scripts/dist.mjs --arm64`：最终 DMG、ZIP、`latest-mac.yml` 与应用内 `app-update.yml` 生成成功；实际为 unsigned，本机没有有效代码签名身份。未跑全仓测试或 Intel 原生构建。
- 真实 Electron/macOS 窗口使用独立临时 userData。设置检查、实际 121,980,522 字节 ZIP 下载、取消后重试、下载完成提示跳回设置并聚焦标题、原生错误展示均通过。该下载使用本地 HTTP 夹具和实际生成 ZIP，夹具假定当前版本 0.0.9/候选 0.1.0，不是公开发布或真实升级。
- 原生 Squirrel 在开发宿主首先因 bundle ID 不匹配拒绝夹具；随后在真实 `.app` 中明确返回“Code signature … did not pass validation”，没有替换应用。两者只证明拒绝/错误路径，不能证明签名成功安装。
- 打包 `.app` 实际启动，`app.isPackaged=true`、版本 `0.1.0`，正确显示 `disabledReason=unsigned`。未覆盖或验收 `/Applications/OC Chan.app`。
- 布局：实际内容 880×640、1280×860、1028×900；200% 页面缩放得到 440×320 CSS px；单独设置 26px 正文及 2× 字号变量；设置容器 559.33 / 561.33 CSS px 断点两侧；真实全屏 2056×1290；880→1280 连续调整、隐藏恢复、中英文、1877 字符错误均无根横向溢出。连续缩放与隐藏恢复后按钮焦点和 scrollTop=8.5 保持。键盘 Tab 可从更新按钮继续进入偏好设置。浏览器 errors 为空。未做原生 Split View 配对、VoiceOver 或其它显示器验收。
- 菜单栏原生截图确认 OC 图形已替换机器人。应用明暗切换均保留图标；系统菜单栏背景本身未切换，不宣称两种系统桌面背景都已实测。没有新增动画。

## 性能与资源证据

硬件 Apple M5 Max / 128 GiB，macOS 27.2.0。独立的旧提交源码与最终代码使用相同 Electron、独立 profile、1280×860、真实概览及可见窗口；每轮 5 秒预热、10 秒采样，间隔 500ms。约 4 个 Agent、1065–1066 条原始调度记录。进程树由 ps 按父子关系收集。

| 指标 | 基线 | 最终 |
| --- | ---: | ---: |
| DOMContentLoaded（ms；不是全应用启动时间） | 65.7 | 59.4 |
| 进程树采样峰值 RSS（MiB） | 655.5 | 690.2 |
| Electron 进程平均 CPU 合计（%） | 0.764 | 0.682 |

首次最终 IPC 样本中位数约 2.75ms，基线约 1.65ms；追加稳态测量为 1.75ms / P95 2.5ms。初期 RSS 差异集中在主 renderer（218.9 对 173.7 MiB），后续闲置及显式 GC 后最终 renderer 为 170.1 MiB，JS heap 约 3.5 MiB。该结果支持初期差异不全是持续保留的资源，不能据此宣称性能提升或完全排除长期退化。

121 MB 实际流式下载的 49 次/100ms Electron 五进程采样峰值为 856.4 MiB；该组使用 `app.getAppMetrics()`，不包含独立原生安装 helper，不能称全应用安装峰值。三次启停后完整下载均成功，末次进程 RSS 总量未持续递增，原生 error listener 数回到 0。未进行小时级运行、极限 512 MiB 包的原生解压、签名成功安装全进程树峰值或 OOM 长时验收。

证据位于 `/tmp/oc-chan-updates-*.json`、`/tmp/oc-chan-tray-{light,dark}.png`。首轮基线 rAF 因窗口遮挡未完成，已用后续可见实例重新采集上述对照，不使用那次超时作为性能结论。

## 当前产物

- `release/OC-Chan-0.1.0-mac-arm64.dmg`：125,665,701 字节；SHA-256 `6fc9b56636d81a4741dbc06f13077b2039c3dd8d62c0195e7b52168ca914d90b`。
- `release/OC-Chan-0.1.0-mac-arm64.zip`：121,980,626 字节；SHA-256 `fc9c4b24be5633c357e064b67243f063720e7cf508f1f390ab23fbed05f72b5d`。
- 两者仅供本机开发验收，未签名/公证/上传。最终 HTML 回执与本文件同名。
- HTML 回执已在当前 Tern 会话右侧展示，浏览器块为 `8169027797007`，归属会话 pane `8169027796997`。原生页面实测宽 303 CSS px，无横向溢出，图片加载及本地链接正确。900 × 900 CSS px 的无窗口 Chromium 补验通过：无溢出、图片正常、Tab 可聚焦首个下载链接且焦点轮廓可见，页面错误记录为空。
- OMP 浏览器接管 Tern 时误报 `no_window`，已反馈；窄栏和展示归属使用 Tern CLI 核验。Tern 尺寸请求返回成功后页面尺寸未变化，因此未将其计作宽屏验收。临时浮动后已恢复原右侧分栏并释放接管；补验用的无窗口页面已关闭。
- 本任务创建的验证服务均已退出，临时基线副本、验收脚本、隔离配置目录及明确属于本轮的 Squirrel 暂存目录已清理。JSON 性能证据、截图和最终安装包保留；未停止用户已有的常驻应用服务。

## 阻塞与恢复

用户没有 Apple 开发者账号。本轮开始时本机有效 codesigning identities=0，私有仓库无 Actions Secrets，目标公开仓库不存在。未代用户申请付费账号、创建公开仓库或复用宽权限个人 Token。由于门槛未满足，没有打发布标签、创建 Release、提交或推送本轮代码。

下一步：

1. 取得 Apple 开发者资格、Developer ID Application 证书及公证凭据；勿在聊天/仓库中粘贴秘密。
2. 初始化独立公开安装包仓库，并配置 README 所列六项 Secrets，发布 Token 只授予该仓库 Contents 写权限。
3. 核对并保留并行任务的提交、版本和工作区；提交并集成本轮功能后，通过 CI 构建首个签名安装版。当前本地 dist 始终 unsigned，不伪造 GitHub 环境变量来签名。
4. 本机先手动安装这个签名基线，发布更高版本，再实际验收检查、下载、重启、版本变化及个人设置保留。
5. 补验 Intel、原生 Split View、VoiceOver、长时资源和签名成功安装时的完整进程树峰值；未完成前保持证据边界。

恢复提示：继续 oc-chan 的 feat/app-updates。更新检查/受限下载/原生签名交接、设置UI、签名发布流程和菜单栏 OC 图标已实现；10+17 定向测试、构建、arm64 unsigned DMG/ZIP及真实窗口已验证。用户授权成功后发布并本机测试，但确认没有 Apple 开发者账号，签名发布仍阻塞。不要公开源码、发布 unsigned 包冒充升级成功，也不要改动另一任务的 github-release-publishing handoff。先读本交接与 README 发布说明，核对实际工作区/远端，再按材料是否具备继续。
