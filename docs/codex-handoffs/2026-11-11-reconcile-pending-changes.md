# 未提交改动与 main 对照交接

## 仓库、目标与授权

- 原工作区：`/Users/zvf003/ZStack/opensource/oc-chan`，分支 `refactor/plugin-system-monitor`。旧会话路径 `/Users/zvf003/ZStack/oc-chan` 已迁移。
- 本任务工作区：`/Users/zvf003/ZStack/oc-chan-reconcile-pending-20261111`，分支 `chore/reconcile-pending-20261111`，基于 fetch 后的 `origin/main`：`a6887ccb2ba9e53f46a10ea357fbcd2378c1717a`。
- 用户要求检查 main 是否已有未提交改动，没有则提交。本次只做本地提交，不推送、不发布、不安装、不清理原工作区或其他任务 worktree。本任务工作区保留供后续整合。

## 覆盖结论

- Agent 右键菜单 manual popover、外部关闭及对应拓扑回归已进入 main：`d7bc8ca`；保留当前 Tauri/AppKit 输入实现，不恢复 Electron/CDP。
- 侧栏折叠、顶栏导航、快捷键、拖动收起、设置保存与错误提示已进入 main：`2223a11`。main 已改进 64px 阈值、保存失败回滚和快速反向操作，旧 View Transition 实现不再迁入。
- 发布仓库、令牌权限、包版本读取、旧 Electron publish 配置移除已覆盖。旧 Electron 打包、GitHub API 解析由 Rust/Tauri 与 schema 2 更新协议替代。稳定版签名公证和预览版 ad-hoc 分流属于当前策略，不能用旧“所有 tag 均 ad-hoc”覆盖。
- 原工作区 AGENTS.md 有并行 Rust 开发流程维护改动，对应 `oc-chan-workflow-20261111`，不纳入本次；旧 `.agents/skills/commit-push/SKILL.md` 已被 main 新版替代。

## 补入的缺失功能

本地提交 `0884507`：

- `scripts/publish-release.mjs`：同一文件句柄有界流式计算 SHA256；草稿和公开后的远端回读都严格比较每个附件 digest。缺失或同大小不同内容明确失败，保留现行 Latest、预览/稳定渠道及错误诊断。
- `scripts/prepare-release.mjs`：读取限 16 MiB 的 schema 2 包清单，交叉核验 arm64、版本、ZIP/DMG 集合、文件名、大小及摘要，在创建输出目录前拒绝不一致。
- 对应两个脚本测试补充摘要、清单及两渠道拒绝场景。
- `UpdateSettings.tsx`：补入从 GitHub Releases 手动下载安装的中英文说明及“发行说明与下载”按钮名称。
- `docs/distribution.md` 和中英文 README 同步说明。两版 README 已审阅；语言切换与本地链接检查通过，Logo 居中结构保留。

## 补存的历史材料

- `docs/audits/implicit-state-machines-20261109-omp/` 的完整 24 文件及两份独有交接 `2026-11-09-github-release-updates.md`、`2026-11-10-local-app-update.md` 原样补存。
- main 现有 `2026-11-10-agent-context-menu.md` 仅追加遗漏的最终 GitHub 回执，保留原有整合过程。
- 这些文件是旧 Electron 工作区的历史证据，不证明当前 Rust 主线仍有同样问题，也不是当前测试/安装/CI 状态。旧绝对路径、行号、PID及临时截图位置仅对应当时现场；本次没有确认历史临时附件仍存在。
- 审计记录为 48 个状态对象、13 个高建模优先级对象、4 个隔离探针，报告明确生产 bug 复现为零，不能称作 13 个高危 bug。`probe.mts`、`verify-audit.mjs` 仅保存历史源码，不加入现行测试或 CI，也未执行。
- 历史 SHA 因 Git 身份修正发生变化，对照同目录 `2026-11-11-git-identity-commit-map.tsv`；例如菜单 `5722d23` 对应 `d7bc8ca`。
- 初版 `docs/audits/2026-11-09-implicit-state-machines/` 的 8 个过程文件与完整审计 ID 不同，留在原工作区，不并列为权威清单。其他任务的 `2026-11-11-opensource-relocation.md` 原样保留、不提交。

## 实际验证与失败记录

- `node --test scripts/prepare-release.test.mjs scripts/publish-release.test.mjs`：153 通过，0 失败、跳过或取消。
- `npm run typecheck`：通过。
- `npm ci --no-audit --no-fund`：成功，按 main 锁文件安装 80 包；npm 提示 esbuild/fsevents 的安装脚本未列入 allowScripts，未修改安全设置。
- 真实独立无头 Tauri/WKWebView：开发构建及 ad-hoc 签名成功；原生点击进入设置，中文与英文 DOM 均验证手动下载提示和按钮名称，截图确认英文页面可读。未触发真实远端发布、下载或外部浏览器。
- 实例 `instance-RIh8aw` 通过驱动 quit，启动器退出码 0；文件系统确认实例目录已删除。未替换正式应用。
- 验收证据保存在本任务工作区 `release/reconcile-evidence/{update-zh.png,update-en.png,wording.json}`，不提交到源码。
- 首次 dev 因 APFS 工作树副本的 `.dev-instances` 权限为 0755 被拒；只将本任务目录改为 0700。第二次因复制的旧分支 node_modules 缺少 `@tauri-apps/api/core` 构建失败，实例自动清理；按锁文件 npm ci 后成功。驱动连接空闲后曾超时，重新建立认证连接完成读取，无错误吞并。
- 构建有既有 Rust dead_code/deprecated、Vite native config/chunk 警告，未修改无关实现。
- 26 个原样历史文件逐文件 SHA256 与源相同，14 个 JSON 可解析；未重新运行旧审计探针。
- 未运行全仓测试、正式包安装、可见窗口/原生外部跳转、完整更新状态矩阵、云端 CI 或真实 GitHub 发布。单测中的远端响应为隔离夹具，不能代替真实发布回执。

## 下一步

1. 如获推送授权，重新 fetch 最新 main，整合本地两次提交，保留并行开发流程修改。
2. 只针对整合产生的新差异追加验证，正常推送并取得 GitHub main 回读，不强推。
3. 历史审计只作为旧基线参考；需要排查 Rust 实现时重新确认源码，不直接套用旧报告。
4. 本任务当前仅本地提交，保留工作树和验收证据；任何后续删除或安装都按对应授权处理。

恢复提示：main 已有菜单与侧栏，不要重复提交旧 Electron 实现。缺失的发布摘要、schema2 包清单校验和下载提示已在隔离分支提交 `0884507`，153 项测试及真实无头中英文文案验收通过。另一提交保存历史证据和本交接。尚未推送、发布或安装；原工作区全部未提交改动及并行流程工作保留。
