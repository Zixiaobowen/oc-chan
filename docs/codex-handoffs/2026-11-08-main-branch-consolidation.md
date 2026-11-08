# 2026-11-08 主分支统一到 main

## 目标与工作区

- 原仓库：`/Users/zixiaobowen/myProjects/oc-chan`，保留其 `feat/app-updates` 分支和未提交改动。
- 本次集成工作树：`/Users/zixiaobowen/myProjects/oc-chan-main-integration-20261106`，分支 `main`。
- 用户明确要求将 `master` 合并到 `main`，随后删除 `master`；包含普通推送和将 GitHub 默认分支切换为 `main`。不创建版本标签、Release或重新安装应用。
- 合并前 main：`ea507625be77a39fa7f6f3fa60961421bf243900`；origin/master：`fed665ef75f0a1ab8f0742c9535cb471957fcade`。
- 两个工作树原有未提交文档均保留，尤其本集成工作树的 `docs/codex-handoffs/2026-11-06-app-updates-main.md`；它不属于本次提交。

## Git交付回执

- 双亲合并提交：`a8b809ed819ba16fa57687d17546ecc2a76e06f1`，已普通推送到 `origin/main`。两个合并前分支的提交均通过祖先检查。
- GitHub API确认默认分支为 `main`，仓库继续保持私有。远端分支列表已没有 `master`。
- 已删除本地 `master` 与远端 `origin/master`，`origin/HEAD` 指向 `origin/main`；其他分支和两个工作树保留。
- 删除远端时限定 master 必须仍指向已合并的 `fed665e`，防止误删期间新到的提交；没有重写 main 历史。
- 推送单次跳过本机安装hook，没有修改持久配置或替换已安装应用。提交后集成工作树只余原有未提交安装交接。
- 合并提交对应云端运行：[42440322285](https://github.com/Zixiaobowen/oc-chan/actions/runs/42440322285) 已完成，状态为 `failure`。适用行为测试和完整Electron smoke均通过；上传smoke证据仍因 `Artifact storage quota has been hit` 失败，后续DMG/ZIP构建、包审计和上传均跳过，Release作业也未执行。最终交接只改文档，以 `[skip ci]` 提交，不重复构建同一应用源码。

## 合并决定与文件

- 采用双亲合并，保留两条分支的提交历史。两边曾分别集成同一批基础监控工作，逐项比较后，`src/**`、依赖锁、打包配置及主线拓扑验收均保留 main，净改动为零。
- 保留 main 的更新插件、签名发布、Codex 会话、3D 办公拓扑、原生液态玻璃、蓝白品牌、无头窗口/退出/焦点修复和双 bundle 许可证清单。
- `.github/workflows/build.yml` 的 push/PR 入口仅保留 main，继续支持版本标签与手动运行；保留 `${{ github.workspace }}/release/mac-arm64/OC Chan.app` 绝对路径。
- `scripts/smoke/events-scenarios.mjs` 接入 master 已验证的真实记录 DOM `scrollIntoView` 前置操作，保持记录身份、像素位置、输入焦点和真实 IPC 断言，并在结果字段说明未验收原生滚轮。
- `scripts/smoke/notification-scenarios.mjs` 合并关闭前序详情、清除遗留任务筛选及 launchd 行可见的前置检查，保留主线的筛选清空断言。
- README同步 main 入口、事件阅读位置验收范围和云端回执口径。保留 master 最新执行记录与 `2026-11-06-backlog-master-integration.md`，更新清单首页的历史/当前分支说明；未完成卡片不因合并自动完成。

## 实际验证

- `npm run typecheck`：通过；执行时默认 Node.js 为 v22.23.4。
- `node --test scripts/ci-tests.test.mjs`：9/9通过，无跳过；未运行全仓单元测试。
- 用实际 `js-yaml` 解析工作流：push/PR 均为 `[main]`，标签 `v*`、手动触发与绝对应用路径均通过断言。
- `git diff --cached --check`：通过；初次暂存净改动仅7个预期文件，没有夹带已有未提交安装交接。
- 真实 Electron 验收使用 Node.js v24.22.2：`npm exec --yes --package=node@24 -- node scripts/smoke-renderer.mjs --out /tmp/oc-chan-main-merge-smoke-20261108`。`result.json` 为 `complete=true`、`errors=[]`，8个运行阶段全部通过；应用验收耗时202.10秒，含 npm 运行时准备的命令总耗时256.88秒。覆盖事件阅读位置、通知订阅、2D/3D拓扑、故障恢复、设置持久化和真实重启；已查看事件和订阅阶段的真实截图。首轮及重启均退出0，monitor停止、定时器/队列/资源预留归零，进程、profile和合成输入目录全部清理。

## 外部限制与交付边界

- 此前 main 提交 ea50762 的云端运行 [42438157759](https://github.com/Zixiaobowen/oc-chan/actions/runs/42438157759) 行为测试和完整 Electron smoke 均成功；失败步骤是上传 smoke 证据，明确报 `Artifact storage quota has been hit`。后续打包步骤被跳过，不能称为整条 CI 通过。
- 不删除既有 Actions 产物、不修改账号计费、不忽略上传错误；存储配额属于外部阻塞，不能由代码合并消除。
- 本次只改变分支、CI 触发与验收脚本，未新增应用功能、重新打包安装、验收可见 macOS 窗口或发布签名更新；不能把源码合并称为安装升级或正式发布完成。

## 接续动作

1. 需要恢复云端产物交付时，先按实际保留需求取得Actions产物删除或计费调整授权，处理存储配额；不得批量删除历史证据或忽略上传失败。
2. 配额恢复后再运行对应云端门禁，取得DMG/ZIP、包审计和上传回执；不要将本次通过的行为测试和smoke称为整条CI成功。
3. 日常开发使用main集成工作树；原工作树仍有独立分支和用户未提交文件，不为切换入口而强行重置或删除。

## 恢复提示

OC Chan 主分支统一已完成：双亲合并a8b809e已推送main，GitHub默认分支main，本地及远端master已删除，origin/HEAD已更新。集成工作树是 `/Users/zixiaobowen/myProjects/oc-chan-main-integration-20261106`；原工作树及两处已有未提交文档均保留。类型检查、9项CI选择器测试、工作流解析和真实Electron的8阶段smoke全部通过，证据在 `/tmp/oc-chan-main-merge-smoke-20261108`，无需重跑。新CI运行42440322285的行为测试和Electron smoke也通过，但证据上传因Actions存储配额满失败，未继续打包，不能宣称CI整体通过。需要恢复产物交付时先解决外部配额，不能绕过门禁或无授权清理产物。本次没有新版本发布或重新安装应用。
