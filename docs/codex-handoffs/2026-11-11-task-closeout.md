# OC Chan 任务收尾流程

## 工作区、分支与目标

- 仓库：`/Users/zvf003/ZStack/oc-chan`；实际修改工作区：`/Users/zvf003/ZStack/oc-chan-main-menu-fix-20261110`。
- 实现分支：`chore/task-closeout-20261111`，从含侧栏提交 `4c8f8ed` 的 `origin/main` 创建，交付前已快进整合 `1f5ac84` 的侧栏安装交接；新增基线仅改无关文档，既有定向验证仍适用。
- 用户已授权将本次改动推送到 main，并实际测试新收尾流程。本次新建临时交付 worktree `/Users/zvf003/ZStack/oc-chan-task-closeout-20261111`，分支 `integrate/task-closeout-20261111`，用于承载完整提交及推送 GitHub；约定推送核验后从保留的 `main-menu-fix` 工作区执行预检和 apply，移除此临时目录、保留分支。它不承担长期证据保存，收尾回执保存在共用 Git 目录中。
- 原始主仓含用户改动，其他任务的 sidebar/rust 工作区不属于本次修改或清理范围。此前五个候选的获批清理属于前一任务，回执在 `2026-11-10-main-local-install.md`。

## 已完成

- 新增 `npm run closeout:task`，从保留工作区对一个显式目标执行预检；只有 `--apply` 才使用普通 `git worktree remove`。
- 复用 `push-main.mjs` 导出的 `verifiedGithubMain()` 校验本项目 origin、实时读取远端 main 并 fetch 精确 SHA；目标 HEAD 必须被包含，不能用旧 tracking ref 代替现场事实。
- 交接必须在 `docs/codex-handoffs/`，入口工作区的已提交交接及实际文件须与远端 main 的常规 blob 一致。
- 暂存、未暂存、未跟踪内容全部阻止删除；文档不豁免。报告给出状态、路径和重命名来源。assume-unchanged/skip-worktree 标志同样阻止，不能隐藏未交付源码。
- ignored 单独枚举，只有逐项精确匹配的 `--discard` 才表示已审阅可丢弃。必要证据需事先在目标外保全并核验；不按目录名自动批准，不自动复制、移动或归档原始材料。
- 拒绝主仓、入口/当前 cwd、main/master、父子嵌套、外仓、锁定/失效/裸登记、符号链接路径及在用目标。macOS lsof 检查可观察的全部打开文件；不 kill 进程，不 force/reset/stash/clean，不删除分支。
- 删除前重新核对远端、交接、工作树身份、HEAD、全部状态、索引标记、ignored 清单和进程占用；删除后独立确认目录与 Git 登记。失败保留有界 Git stderr 及实际目录/登记状态，不把部分失败写成完整保留。
- apply 在 Git common dir 的私有 `task-closeouts/` 创建唯一 JSON 回执，记录计划、阶段、阻塞与实际删除结果；目标移除后回执仍可读。默认报告不写该回执，但会 fetch Git 元数据。
- 工程规则和提交技能将本任务自行新建并明确登记为临时的 worktree 纳入完整交付。新临时目录统一使用任务/集成分支，通过 `HEAD:main` 推送；main/master 留在保留工作区。已有目录与其他任务不得追溯自动纳入。
- 更新 CI 测试映射及中英文 README、开发和分发文档；保留现有临时应用清理职责，与源码 worktree 收尾分开记录。

## 修改文件

- `scripts/closeout-task.mjs`、`scripts/closeout-task.test.mjs`
- `scripts/push-main.mjs`、`scripts/ci-tests.mjs`、`package.json`
- `AGENTS.md`、`.agents/skills/commit-push/SKILL.md`
- `README.md`、`README.en.md`、`docs/development.md`、`docs/distribution.md`
- 本交接文件

## 实际验证

- `node --test scripts/closeout-task.test.mjs scripts/push-main.test.mjs scripts/ci-tests.test.mjs`：53 项，52 passed、0 failed、1 skipped。跳过项为仅适用于非 macOS 的 apply 拒绝场景；本机实际执行 macOS lsof、进程 cwd/打开文件保护与 worktree 删除路径。
- 新测试使用临时 Git 仓库、本地 bare remote 和仓库局部 URL rewrite，执行真实 Git fetch/push/worktree 操作；没有向真实 GitHub 推送测试数据。覆盖单目标正常删除、旁支与其他工作树保留、dirty/ignored/交接/远端/身份保护、索引隐藏标志、严格 boolean apply、结构化改动列表、submodule 导致真实删除拒绝及持久回执。
- 已核对 npm 入口、README 双语本地引用、任务收尾章节和新脚本的定向 CI 选择：仅选择 closeout 测试，无 Rust 组或 renderer smoke。
- 静态复核发现的两项问题已修正：临时工作树不得承载受保护的 main/master；进程查询只能声明当前用户可观察范围，不能承诺发现所有权限不可见的占用。
- 未跑全仓测试、应用构建或界面验收；本次不修改应用运行逻辑。LSP 查询返回本项目无已配置语言服务器。

## 限制与后续

- Git 删除和检查之间仍存在 TOCTOU，无法阻止不合作的外部并发写入；操作前须确认目标会话与任务退出，期间不得启动新工作。
- lsof 的成功结果只覆盖当前用户可观察的进程；检测到查询失败则拒绝。实际删除只支持 macOS。
- 交接存在且已推送不自动证明其中引用的原始证据已妥善保存；操作者必须核验目标外副本，不能将全部 ignored 清单机械转换为 discard。
- 本次提交/推送及真实收尾已获用户授权，执行结果在后续回执中记录；当前 `main-menu-fix` 工作区及其历史安装材料继续保留，不把它误当本任务新建临时目录删除。未授权安装、手动发布、删除分支或清理其他工作树。

后续具体动作：

1. 仅提交上述任务文件，将完整提交快进至本次临时交付工作树；推送前运行 closeout 预检，确认未合入内容被拒绝且目录保留。
2. 从临时工作树正常推送 `HEAD:main` 并回读 GitHub SHA；随后从保留工作树执行 closeout 预检及 apply，核对目录和登记移除、分支保留、receiptPath 可读。
3. 将实际远端与收尾结果补入本交接并推送文档回执；保留原始主仓、sidebar/rust、main-menu-fix 和所有既有安装材料，不扩大清理范围。

恢复提示：在 `/Users/zvf003/ZStack/oc-chan-main-menu-fix-20261110` 的 `chore/task-closeout-20261111` 继续。实现与三份定向测试已通过；用户已授权本次提交到 GitHub main，并以 `oc-chan-task-closeout-20261111` 验证真实收尾。先读取本文件最后的实际执行记录，不重复已通过且仍适用的检查；只有这份新建交付工作树属于本轮 apply 范围。
