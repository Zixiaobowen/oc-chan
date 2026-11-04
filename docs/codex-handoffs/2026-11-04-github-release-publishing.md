# GitHub Release 自动发布配置交接

- Repo：`/Users/zixiaobowen/myProjects/oc-chan`
- Remote：`https://github.com/Zixiaobowen/oc-chan.git`（私有）
- Branch：`master`
- 当前目标：补齐版本标签触发的 GitHub Release 发布，将现有双架构安装包上传为 Release 附件。

## 已完成

- 配置提交 `1f0aa61624bdbdbe4890402a2f590ecb92c92cdf`（`ci: publish macOS installers on version tags`）已推送 `origin/master`。
- `.github/workflows/build.yml` 增加 `release` 作业，只有 `push` 事件且 ref 为 `refs/tags/v*` 时发布，依赖整个双架构构建矩阵成功。
- 标签必须等于 `v` 加 `package.json` 的版本；检查在安装依赖、构建之前执行。
- 发布作业用固定 SHA 的官方 `actions/download-artifact` v8.0.2 下载当前运行的两份产物，显式取出两架构 DMG / ZIP，合并校验清单并运行 SHA-256 校验。缺包或损坏会失败，不会进入发布步骤。
- 使用 `gh release create --verify-tag --generate-notes` 上传四个安装包和一份合并校验清单。GitHub CLI 在附件上传后才公开 Release；同名 Release 不覆盖。预发布版本标记 `--prerelease`，版本的 build metadata 不参与预发布判断。
- 仅发布作业授予 `contents: write`，无需额外 Secret；普通构建保留只读权限。标签运行不自动取消进行中的同标签运行。
- README 更新发布触发、首次 `v0.1.0` 发布命令、后续版本更新、私有仓库下载权限和失败处理说明。
- 没有创建版本标签或 Release；本次授权目标为配置发布流程。

## 调查与修改文件

- 修改：`.github/workflows/build.yml`、`README.md`、本交接。
- 调查：`package.json`、此前的 `2026-11-04-github-actions-build-artifacts.md` 交接、GitHub 官方 download-artifact action 输入、GitHub CLI release create 文档。
- 未修改应用代码、版本号、依赖或锁文件；`npm run dist` 保留 `--publish never`，只由独立的发布作业对外发布。

## 实际验证

- actionlint 1.7.12：通过。临时下载的 macOS arm64 工具包已按发布校验清单验证 SHA-256；未安装到全局。未启用本机未安装的 ShellCheck / pyflakes。
- 工作流中所有 `run` 脚本：`bash -n` 通过。
- 从工作流解析并实际执行附件整理脚本，使用临时测试文件和真实 SHA-256 清单：完整双架构的四个附件及合并清单验证通过；修改一个 DMG 的字节、缺失 x64 架构、缺失 ZIP 均返回失败，阻断后续步骤。测试文件不是可安装应用，不作为安装包功能验收。
- 实际执行版本校验：当前版本对应的 `v0.1.0` 通过，`v0.9.9` 被拒绝。
- 临时验证工具与样本已清理。没有运行全仓测试，本次只修改 CI 和文档。
- 云端工作流：[41857167500](https://github.com/Zixiaobowen/oc-chan/actions/runs/41857167500)，配置提交推送已成功触发，但本次未能执行构建。两架构作业约 15 分钟后取消，`runner_id=0`、步骤列表为空；GitHub 错误注释均为 `The job was not acquired by Runner of type hosted even after multiple attempts`，ARM64 另有容量不足提示。Release 作业跳过。没有编译或发布脚本失败日志，不能宣称云端构建通过。
- 同期 GitHub 全局状态接口报告 Actions operational、无活跃 incident；这不抵消该次作业的 runner 分配失败证据。未改 runner 类型、增加兜底或反复重跑；云端验收需在 runner 可用后补齐。
- 未执行真正的标签发布，Release 创建与附件上传的端到端结果需在首次正式发布时验证；不能以本地脚本检查或分支构建代替发布成功回执。

## 限制与禁改区域

- 保持现有 macOS arm64 / x64 范围，不增加其它平台、自动更新、签名或公证。
- 用户要求配置流程，不把此次请求扩大为直接发布 `v0.1.0`。首次发布需有对应授权。
- 保留用户和并行任务的改动，不全量暂存、不强推、不改写已有版本标签或 Release 附件。
- 如上传失败留下 Release 草稿，先检查失败日志和草稿状态；不能用覆盖或删除隐藏问题。
- 仓库私有，Release 及 Actions 附件下载仍需仓库访问权限；未配置 Developer ID 签名和 Apple 公证。

## 下一步

1. GitHub 托管 runner 可用后重跑 run `41857167500`，确认双架构构建和上传通过；本次未分配 runner，不需为此修改发布逻辑。
2. 获得具体版本的发布指令后，核对目标提交及 `package.json` 版本；当前仍为 `0.1.0`。
3. 若发布新版本，使用 npm 更新版本与锁文件并提交；在目标提交创建对应 `v*` 标签并推送。
4. 等待双架构构建和 `Publish GitHub Release` 成功，核对四个安装包、合并校验清单以及预发布标记。
5. 下载对应架构安装包并按清单校验；实际安装与窗口验收单独记录，不以发布成功替代。

## 恢复提示

> 在 `/Users/zixiaobowen/myProjects/oc-chan` 继续。GitHub Release 自动发布配置已作为 `1f0aa61624bdbdbe4890402a2f590ecb92c92cdf` 推送 master；触发条件为推送匹配 package.json 版本的 v* 标签，双架构完成后才发布。配置与 README 已更新，本地 actionlint、Bash 语法、附件成功/损坏/缺包及版本不匹配检查均通过。云端构建 run 41857167500 的实际结果见上文。尚未创建标签或 Release，不得宣称已有可下载 Release，也不要未经新指令直接发布。不要重复已通过检查，不改应用代码、依赖和原有运行实例。
