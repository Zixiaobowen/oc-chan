# 更新机制修复合入 main

- 日期：2026-11-09。
- Repo：`Zixiaobowen/oc-chan`。
- 集成 worktree：`/Users/zixiaobowen/myProjects/oc-chan-update-main-20261109`，本地分支 `integrate/update-main-20261109`。
- 目标：按用户“合并到main并push”的指令，将此前更新机制修复与公开更新源修正合入最新主线。
- 结果：修复提交 `269595c255fc122081b668f4cb762dd81457c775`，双亲合并 `8c5a2ed3d924c57a008d100fd68d33206b2b359b`；第一亲为远端主线 `3118aeacaed9263b79d562763cd243383f9a9463`。`git push origin HEAD:refs/heads/main` 成功，`git ls-remote origin refs/heads/main` 读回同一合并 SHA。
- 云端：[Build macOS 42630401983](https://github.com/Zixiaobowen/oc-chan/actions/runs/42630401983) 已为合并提交启动；记录时为 `in_progress`，没有将其记作通过。

## 合并结果

保留主线的 Kubai 图标、开发包手动检查更新、权限设置和系统监控完整插件。冲突涉及 `README.md`、`scripts/check-package.mjs`、`scripts/ci-tests.mjs`：保留面向社区用户的新 README，将工程说明迁到 `docs/development.md`；包门禁使用 Kubai 依赖并接入五文件来源快照；测试选择保留新的插件路径及交付、发布直接调用方。

本轮修复包括输出目录参数、schema 2 历史交付来源核验、版本格式契约、安装就绪 SemVer、FIFO 拒绝、Latest 单调发布、CI 产物保留策略。客户端、打包器和发布器统一使用公开仓库 `Zixiaobowen/oc-chan`。发布作业单独授予 `contents: write` 并使用 Actions 自带令牌；现存源码标签通过 `--verify-tag` 发布，不覆盖已有 Release 或草稿。

调查与修改范围：前述冲突文件、`docs/development.md`、`.github/workflows/build.yml`、`package.json`、交付/安装/发布脚本、`src/main/plugins/update-source.ts`、安装就绪协议及对应行为测试。此前完整修复记录见 [2026-11-08-push-update-repair.md](2026-11-08-push-update-repair.md)。

## 实际验证

使用已存在的 Node 24.22.2，命令环境将 `/Users/zixiaobowen/.npm/_npx/387698761821791d/node_modules/node/bin` 加到 PATH 前端；没有修改全局 Node 或启用 Git hook。

```sh
npm ci --offline --no-audit --no-fund
node --import tsx --test --test-reporter=spec --test-concurrency=2 scripts/local-delivery.test.mjs scripts/delivery-source.test.mjs scripts/check-package.test.mjs scripts/install-local.test.mjs scripts/prepare-release.test.mjs scripts/publish-release.test.mjs scripts/ci-tests.test.mjs src/main/app-updates.test.ts src/main/installation-check.test.ts
npm run delivery:local -- --out release/update-main-verified-20261109
npm run install:local -- --check-delivery release/update-main-verified-20261109
npm exec --offline -- install-electron
npm run smoke:renderer -- --out release/update-main-renderer-20261109
```

- 定向测试：222/222通过，0失败，未跑全仓测试。
- 真实schema 2交付：类型检查、Vite、原生模块、arm64 DMG/ZIP构建、依赖审查、包预算、ZIP 611成员和DMG只读挂载内容核验全部通过；交付耗时48.86秒，来源为干净的合并提交，digest=`86a17645d1750925c99daf51254f3a6b8babb6fa1b21d87e911a2b150611815c`。
- 安装器真实 `--check-delivery`：verified=true、ad-hoc签名通过、installed=false。没有替换 `/Applications/OC Chan.app`。
- 真实Electron无头smoke：203.74秒，main/preload/React/IPC、系统采集、32条合成Agent、真实设置持久化与独立profile重启；complete=true、errors=[]、36张截图，临时工作目录已清理。不是可见macOS窗口或已安装应用验收。
- 合并后真实手动更新检查：发布页匿名HTTP 200；开发模式实际请求本仓库的 `latest-mac.yml`，因现有公开版本缺少该附件，明确进入error并显示HTTP 404。未自动下载或安装，没有将该错误伪装为“已是最新”。
- 工作流权限与测试选择运行检查：普通作业contents:read、发布contents:write；交付入口保留安装/包门禁，系统插件选择新的 `src/plugins/system-monitor/` 测试路径。

证据：

- `release/update-main-verified-20261109/delivery.json`、`build.log`、`package-manifest-arm64.json`、`dependency-review-arm64.json`。
- `release/update-main-renderer-20261109/result.json`及evidence目录。
- `release/update-main-integration-verification.json`。

## 边界与失败记录

- 首次交付因新worktree没有 `release/` 父目录而在realpath前置检查失败；按工具既有契约创建父目录后成功，未修改产品逻辑绕过错误。
- 合并和推送不等于签名发布。Developer ID、公证凭据、签名新版及更新元数据仍未交付；本轮没有发布版本、创建标签、启用hook或安装正式应用。
- `oc-chan` 工作区的插件市场并行任务未改动。旧main工作区 `oc-chan-main-integration-20261106` 保留原分支位置与两份未提交文档，其内容SHA-256与操作前一致；未为同步本地main而stash、reset或覆盖文档。GitHub main已经包含本次合并。
- 保留源分支和所有现有worktree，没有删除、强推或清理用户资料。
- 2026-11-08获批40项Actions历史产物清理已完成，不重复执行。

## 下一步

1. 按合并SHA核对上述GitHub CI最终结果；如失败，先读该次日志并定位，再运行受影响检查。
2. 继续插件市场工作时，整合最新 `origin/main`，保留其尚未提交的并行改动，不以旧主线覆盖本次发布与交付修复。
3. 用户需要签名更新时，再配置Developer ID与公证凭据，以新版本号按发布授权创建标签并验证元数据。
4. 后续同步旧main工作区前先处理其未提交文档归属；不要自动清理、覆盖或归档。

## 恢复提示

> 继续OC Chan更新机制任务。先读本交接。修复提交269595c已经通过双亲合并8c5a2ed进入GitHub main并push，基线3118aea。集成worktree是oc-chan-update-main-20261109，分支integrate/update-main-20261109。222项定向测试、真实schema2交付与安装前核验、Electron无头smoke通过；签名发布和已安装应用升级没有完成。公开源统一到Zixiaobowen/oc-chan，但现有latest-mac.yml仍缺失并明确报HTTP404。CI 42630401983需读实际最终状态，不重跑已适用的本地验证。原oc-chan有插件市场并行改动，旧main worktree有两份未提交文档，全部保留；不得reset/stash/clean省事。40项旧产物已清理，不要重复删除。后续只按用户新授权处理签名发布或安装。

## HTML回执验收

沿用html文档技能更新原回执，展示主线合并结果与分阶段证据。通过 `tern browser` 将HTML绑定当前owner `8169027796997`，再 `tern dock 50934017163277 right --json`；`tern inspect --json`确认当前pane在左、回执块在右。页面title、合并标题、证据及390/1100宽度无横向溢出通过，已观察真实回执截图，主题切换后恢复跟随系统。Eval browser显式接管仍报no_window，已上报；通过同一Tern原生页完成state/eval/capture，未另开Chrome。结束释放接管并保留右栏。此验收只证明HTML回执，不是已安装应用或原生窗口验收。
