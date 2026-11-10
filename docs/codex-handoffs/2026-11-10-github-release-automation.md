# GitHub Actions 与自动预览发布

- 仓库：`/Users/zixiaobowen/myProjects/oc-chan`；最终隔离工作区：`/private/tmp/oc-release-fix-20261110`，分支 `fix/actions-release-20261110`，基于 `175664a89e002be1185b27a5c678061545bb291a`。
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
- 浏览器helper接管返回no_window，而绑定当前TERN_PANE的`tern browser`可正常访问；改用原生CLI完成检查。最终仍须更新、显示当前回执并释放接管，不使用外部Chrome。
- 云端真实无头Tauri/WKWebView验收完成：`oc-chan-renderer-smoke-56`（artifact 13779545096），`complete=true`、`errors=[]`、`fault=null`；2026-11-10 15:27:28Z至15:39:03Z。生产Rust采集、IPC与真实React渲染已运行；报告确认fixture进程和目录、保留实例清理完成。证据下载到`/private/tmp/oc-release-smoke-56-u1ApVO/result.json`。不包含可见原生窗口或OS通知投递验收。
- 稳定Latest核对基线：`v0.1.0`，Release ID `434182593`，发布时间`2026-11-04T16:41:41Z`。预览公开后须再次比对。
- #56发布失败根因：download-artifact v8对单个pattern匹配将文件直接展开到`artifacts`，而CLI读取`artifacts/oc-chan-macos-arm64-56/latest.json`。实际下载日志与ENOENT明确证实。工作流现改为exact name并显式指定对应子目录，去掉不适用的merge-multiple；不添加路径兼容或降级逻辑。

## 工作区变化与限制

原修复目录`/Users/zixiaobowen/myProjects/oc-chan-release-automation-20261110`两次在编辑中被外部清理移除；第二次虽有git worktree lock，登记仍在而文件不见。本轮未执行该清理。主目录随后被另一任务切到`feat/worktree-garden-20261110`，不得切换或覆盖其分支。最终移至上列/private/tmp独立工作区，已锁定。其他任务的未提交文档、截图、资源和分支全部保留。

GitHub官方Create Release规则：若目标提交的workflow内容相对当前默认分支不同，token需Workflows:write，而内置GITHUB_TOKEN无法获得。正常当前main发布可用；若构建中又修改workflow，旧构建不能假装发布成功，应明确保留诊断并由新main运行发布。不得用不匹配的源码SHA生成附件/标签。

没有Developer ID密钥，正式签名、公证和应用内稳定升级未验收。本轮不安装/替换正式应用、不启动可见开发窗口、不删除源码worktree、个人数据、其他会话资源或旧Release。

## 后续动作

1. 用真实#56分发artifact验收明确下载目录，校验修改后的workflow；提交推送该路径修复，观察新的完整main流水线。
2. 核对预览Release状态、完整标签SHA、三附件、下载SHA256及稳定Latest未变。
3. 写回实际回执，更新当前Tern右侧HTML证据页；释放浏览器接管，不关闭用户分栏。

## 恢复提示

继续OC Chan的GitHub Actions与Release修复。最终隔离目录/private/tmp/oc-release-fix-20261110。用户要求main自动构建发布，预览三附件不进稳定更新；签名标签保留。先读现场状态和此handoff，再收齐子代理结果与针对性验证，不能将mock测试通过宣称为真实发布成功。原主目录有另一任务feat/worktree-garden，禁止切其分支、删除其资源或暂存无关文件。

来源：[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)；[官方draft查询实现](https://github.com/cli/cli/blob/trunk/pkg/cmd/release/shared/fetch.go)；[Create Release权限规则](https://docs.github.com/en/rest/releases/releases#create-a-release)。核对日期：2026-11-10。
