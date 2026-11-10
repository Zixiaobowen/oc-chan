# GitHub Actions 与自动预览发布

- 仓库：`/Users/zixiaobowen/myProjects/oc-chan`；最终隔离工作区：`/private/tmp/oc-release-fix-20261110`，当前分支`main`；修复分支`fix/actions-release-20261110`已快进合入，起点为`175664a89e002be1185b27a5c678061545bb291a`。
- 用户目标：代码推送后自动构建，将 macOS DMG/ZIP 自动上传 GitHub Releases。

## 已确认与修改

现场 GitHub API 确认仓库 public，默认 main；默认 workflow 权限 contents:read，发布 job 显式 contents:write；没有 Apple 发布 Secrets。修复前最新成功运行 `42779262535` 的 release job skipped，只有旧 `v0.1.0` Release。

原有工作流只接受稳定版本标签，main 仅生成 Actions artifact。修复后 main push/main手动构建成功后发布 `preview-<run-number>-<shortSHA>`，绑定完整提交，三附件为 ad-hoc arm64 DMG、ZIP、SHA256SUMS；Pre-release、非Latest、不上传latest.json。PR不发布；稳定v标签仍要求签名与公证；不覆盖既有Release/tag/附件。

最近失败 `42775275844` 的真实锁测试依赖 `/usr/bin/python3`，5秒超时SIGTERM且输出为空；不能证明其内部具体卡在shim、导入或调度。私有C辅助工具使用现有xcrun clang，真实查询SDK struct flock/F_GETLK，保留PID/范围/EOF子进程退出断言并增加退出后解锁观察；产品gate未改。

独立评审发现原发布脚本用REST releases/tags查询draft，但GitHub CLI官方源码明确该接口仅查询published，draft需GraphQL按pending tag取ID，再REST releases/<id>。已修复真实查询契约，并更正旧测试的错误模拟，保留既存draft拒绝语义；独立复核确认该阻塞关闭。

## 文件

`.github/workflows/build.yml`；`scripts/release-config.mjs`；`scripts/prepare-release.mjs`与测试；`scripts/publish-release.mjs`与测试；`scripts/local-install-readiness.test.mjs`；新增`local-install-lock.test.c`；`scripts/ci-tests.mjs`；中英文README；`docs/distribution.md`。中英文README已对照本轮安装/下载行为审阅和同步。

## 已有检查证据

- `node --test scripts/local-install-readiness.test.mjs scripts/ci-tests.test.mjs`：26/26通过，包含真实macOS锁与EOF退出。
- `actionlint 1.7.12 -shellcheck= -pyflakes= .github/workflows/build.yml`：通过；未执行ShellCheck/Pyflakes。
- `npm run test:release`：修复真实draft API后101/101通过。包含stable/preview草稿读取、来源绑定、篡改与超限、权限与GraphQL错误、附件不完整、重复发布及Latest保持。
- 真实只读GraphQL查询不存在Release返回`data.repository.release=null`且exit0。
- 本地不跑全仓测试；云端按现有CI映射做定向测试及真实WKWebView、打包、审计。
- 已提交并推送 `f3a6213fdd5573a778dc98bcaf4b6b5f9f9864bd`；现场GitHub ref读取一致。[Build macOS #56](https://github.com/Zixiaobowen/oc-chan/actions/runs/42843573848) 的macOS构建、真实WKWebView、依赖审计及安装包检查通过；发布job在读取附件目录时失败，未创建预览Release。
- `npm run push:main` 的GitHub推送和当前工作区清理成功；随后因外部删除旧工作区但登记仍在，清理该旧路径报ENOENT，整体命令exit1。未删除失效登记或其他分支；这不表示GitHub推送失败。
- HTML回执通过Tern原生WKWebView读取，实际1280 CSS px宽页与462 CSS px分栏截图已检查；浅色主题计算色值和链接键盘焦点正常，事件记录为空。原生viewport请求虽返回成功但未改变停放页实际尺寸，不能宣称360px验收通过；问题已报工具QA。
- 浏览器helper接管返回no_window，而绑定当前TERN_PANE的`tern browser`可正常访问；改用原生CLI完成检查。最终回执已更新并释放接管，详见后文；没有使用外部Chrome。
- 云端真实无头Tauri/WKWebView验收完成：`oc-chan-renderer-smoke-56`（artifact 13779545096），`complete=true`、`errors=[]`、`fault=null`；2026-11-10 15:27:28Z至15:39:03Z。生产Rust采集、IPC与真实React渲染已运行；报告确认fixture进程和目录、保留实例清理完成。证据下载到`/private/tmp/oc-release-smoke-56-u1ApVO/result.json`。不包含可见原生窗口或OS通知投递验收。
- 稳定Latest基线：`v0.1.0`，Release ID `434182593`，发布时间`2026-11-04T16:41:41Z`。#58预览公开后的现场API比对确认ID与tag均未变化。
- #56发布失败根因：download-artifact v8对单个pattern匹配将文件直接展开到`artifacts`，而CLI读取`artifacts/oc-chan-macos-arm64-56/latest.json`。实际下载日志与ENOENT明确证实。工作流现改为exact name并显式指定对应子目录，去掉不适用的merge-multiple；不添加路径兼容或降级逻辑。
- 路径修复经actionlint通过；下载真实#56分发artifact到显式命名目录后，原prepare-release CLI成功生成且仅生成DMG、ZIP、SHA256SUMS，`shasum -a 256 -c SHA256SUMS.txt`两项OK。证据目录`/private/tmp/oc-release-dist-56-4xFILX`。未重复运行未修改的101项发布测试。
- 后续修复`ad5fe2e5fa825b8ad11346d75cd087249e9c336f`已推送main并经GitHub ref确认；[Build macOS #57](https://github.com/Zixiaobowen/oc-chan/actions/runs/42848991728) 在真实WKWebView验收失败，Release未运行。原文：`OC_PLUGIN_PROTOCOL: Host IO exceeds negotiated reassembly reservation`，来自`Driver.exchange` (`scripts/smoke/main-probe.mjs:109`)；不能因#56通过就归为随机抖动。后续已定位并修复下述顺序竞态。
- 根因已由源码证实：`host.rs` 在BoundedIo worker中发送IoEnd，外层IO task尚未释放IoReservation；SDK收到terminal后立即申请下一IO。串行64KiB→4MiB或4MiB→64KiB会因旧预留未扣除误拒，ResultEnd也存在JoinSet未回收窗口。实际#57日志没有逐IO身份，不能断定是哪一项触发。
- 已在`host.rs`、`host_io.rs`将终态元数据经现有BoundedIo泛型返回给supervisor；JoinSet回收后统一释放预留、发送IoEnd/IoError。预算、wire contract和成功完成后的取消语义不变；原始cleanup与发送失败聚合保留。`host_tests.rs`增加5项确定性屏障/边界/错误回归。主代理`cargo test -p oc-core plugins::host::tests`通过8项，`cargo test -p oc-plugin-sdk runtime::tests`通过4项。协议文档同步于`docs/rust-migration/plugin-contract.md`。
- 同机基线工作区`/private/tmp/oc-release-io-baseline-20261111`（ad5fe2e，detached且锁定）；依赖须独立npm ci，项目依赖审计拒绝跨工作区node_modules软链接。原始stress尝试的软链接已仅移除自身链接并修正安装。
- 基线baseline/stress第二次运行未完成：`/private/tmp/oc-release-io-baseline-stress-r2-20261111/result.json`报告`Requested event load fell behind more than 1s`及performance cleanup错误；shutdownReport显示全部资源current为0，launcher确认本实例已清理。完整stress前后对照及持续高负载未通过验收，不宣称性能提升或长期无OOM。
- 同机`--mode smoke --scenario daily`前后均complete=true、errors=[]。Apple M5 Max/18核/128GiB，macOS27.2、Node22.23.4；证据分别为`/private/tmp/oc-release-io-baseline-daily-20261111/result.json`和`/private/tmp/oc-release-io-fixed-daily-20261111/result.json`。应用至interactive 6767.6→4283.9ms，输入至commit单样本111→110ms，交互往返4.44→4.76ms；应用后代RSS采样峰值164.31→164.97MiB，合并关联WK进程492.00→497.25MiB。关联CPU样本1→5，均值35.88%→21.14%（单核口径）；基线纯后代CPU无完整区间，关联进程可能共享。样本不足以判定性能变化，未观察到该短场景内OOM。
- `npm run smoke:renderer -- --scenario marketplace --out /private/tmp/oc-release-io-fixed-marketplace-20261111`通过，complete=true、errors=[]。真实无头Tauri/WKWebView、Rust插件安装/更新/回退/卸载与重启路径已执行；退出documents、requests及全部全局资源归零，测试实例、driver、fixture进程和目录已清理。
- 独立ReviewIoTerminal只读复核未发现阻塞问题；检查了8并发、4MiB准入、成功/失败/取消终态顺序、三处排空、进程/写队列/panic错误路径。该复核不替代真实Actions回执。
- 本次提交前重新审阅中文README；顺序修复不改变用户操作、插件协议格式、支持范围或发布条件，中英文README均无需增补。协议内部完成约束已更新。
- 竞态修复提交`49d8e536fb91f9f1631d883c1eeb3a80ce73f4a2`已通过`npm run push:main`推送并由GitHub ref再次核对。[Build macOS #58](https://github.com/Zixiaobowen/oc-chan/actions/runs/42857885722)绑定同一完整SHA，构建、真实WKWebView、安装包/依赖审计及发布全部成功。当前工作区临时应用清理成功；入口仍因旧登记`oc-chan-release-automation-20261110`已被外部删除而exit1，没有清理该登记或其他任务。
- 最终回执继续复用Tern块`51024211476499`；现场发现它位于其他标签，已用`tern move 51024211476499 right-of 9723805958155 --json`显式绑定当前`TERN_PANE`右侧，`inspect`确认同一Row左右叶分别为会话和回执。helper仍报no_window，CLI正常，已报工具QA；没有打开Chrome或新浏览器块。
- 最终回执已刷新为发布成功，下载/Release/Actions链接核对正确；原生暗色截图`/private/tmp/oc-release-receipt-58-bW6agR/native-final.png`已检查，同一WebKit内隔离srcdoc视口约360/480/1280 CSS px布局通过，没有超出1px取整差的整页横向溢出。窄尺寸为iframe视口，不冒称调整了真实Tern窗口。已release接管，driven=false、rightSplit=true；用户当前位于其他标签，回到本会话即可看到右侧回执。
- 公开交付：[preview-58-49d8e53](https://github.com/Zixiaobowen/oc-chan/releases/tag/preview-58-49d8e53)，Release ID `440665967`，draft=false、prerelease=true，tag和target_commitish均指向完整提交`49d8e536fb91f9f1631d883c1eeb3a80ce73f4a2`。仅有DMG、ZIP、SHA256SUMS，无latest.json。
- 匿名下载验收通过：`/private/tmp/oc-release-public-58-aXBrgj/receipt.json`，2026-11-10 17:16:16Z；curl禁用个人配置且未传登录凭据，三附件均可下载，两个安装包的字节数和公开清单SHA256一致。DMG SHA256=`bfe752f20cbacd778ae6866d26888e2b2729e657b3a5261031d7a50e35a3d808`；ZIP SHA256=`05f0768089eba2d44ca6823acce3f613b021c91274c1c80c90420c81df05fba4`。一次性核验脚本已移除，安装包和回执保留。
- #58云端原始证据：`/private/tmp/oc-release-smoke-58-UzOPVe/result.json`，scenario=all、complete=true、errors=[]、fault=null；16:51:54Z至17:05:26Z。首次、重启、恢复三个实例的documents/requests及资源current均为0；fixture进程与目录、driver、保留实例全部清理。无头验收不包含可见原生窗口与OS通知投递。
- 最终证据提交前再次阅读中文README；本次只归档已验证结果，中英文使用说明无需变化。没有在本地追加全仓测试或重新运行已适用的通过项。

## 工作区变化与限制

原修复目录`/Users/zixiaobowen/myProjects/oc-chan-release-automation-20261110`两次在编辑中被外部清理移除；第二次虽有git worktree lock，登记仍在而文件不见。本轮未执行该清理。主目录随后被另一任务切到`feat/worktree-garden-20261110`，不得切换或覆盖其分支。最终移至上列/private/tmp独立工作区，已锁定。其他任务的未提交文档、截图、资源和分支全部保留。

GitHub官方Create Release规则：若目标提交的workflow内容相对当前默认分支不同，token需Workflows:write，而内置GITHUB_TOKEN无法获得。正常当前main发布可用；若构建中又修改workflow，旧构建不能假装发布成功，应明确保留诊断并由新main运行发布。不得用不匹配的源码SHA生成附件/标签。

没有Developer ID密钥，正式签名、公证和应用内稳定升级未验收。本轮不安装/替换正式应用、不启动可见开发窗口、不删除源码worktree、个人数据、其他会话资源或旧Release。

## 后续使用与未验收项

1. 后续产品代码推送main，查看Build macOS结果与对应preview Release；下载DMG或ZIP并核对公开SHA256清单。
2. 如需正式稳定发布，配置Apple签名、公证Secrets并推送与包版本一致的v标签；本轮未验收这一路径或正式应用升级。
3. 若继续长时资源验收，先处理现有压力发生器负载落后，再建立完整前后对照；不要将本轮短时测量当作长期OOM证明。
4. 已被外部移除的旧工作区仍有登记；需另获明确授权后处理登记，不删除其他会话的工作区、分支或个人数据。

## 恢复提示

本轮OC Chan的GitHub Actions与自动预览Release修复已完成。隔离工作区/private/tmp/oc-release-fix-20261110，当前main；产品提交49d8e536fb91f9f1631d883c1eeb3a80ce73f4a2，Actions 42857885722全部成功，preview-58-49d8e53已公开且匿名下载校验通过，稳定Latest仍为v0.1.0。先读此handoff与新任务要求再继续，不重复已通过的检查。正式签名、安装升级及完整压力对照未验收。原主目录属于另一任务feat/worktree-garden，不切换其分支，不删除其资源或暂存无关文件。

来源：[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)；[官方draft查询实现](https://github.com/cli/cli/blob/trunk/pkg/cmd/release/shared/fetch.go)；[Create Release权限规则](https://docs.github.com/en/rest/releases/releases#create-a-release)。核对日期：2026-11-10。
