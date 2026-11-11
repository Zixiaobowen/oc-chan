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
- 本次实现已正常推送 GitHub main，并完成获批临时交付工作树的真实收尾，结果见下文。`main-menu-fix` 工作区及其历史安装材料继续保留；未安装、手动发布、删除分支或清理其他工作树。

本轮执行顺序（均已执行，结果见下方）：

1. 仅提交上述任务文件，将完整提交快进至本次临时交付工作树；推送前运行 closeout 预检，确认未合入内容被拒绝且目录保留。
2. 从临时工作树正常推送 `HEAD:main` 并回读 GitHub SHA；随后从保留工作树执行 closeout 预检及 apply，核对目录和登记移除、分支保留、receiptPath 可读。
3. 将实际远端与收尾结果补入本交接并推送文档回执；保留原始主仓、sidebar/rust、main-menu-fix 和所有既有安装材料，不扩大清理范围。

恢复提示：本次收尾实现和真实交付闭环已完成，继续时先读下方回执。保留工作区为 `/Users/zvf003/ZStack/oc-chan-main-menu-fix-20261110`，实现分支 `chore/task-closeout-20261111`；本轮临时交付工作树已移除，不要重新创建它或重跑删除。其他任务目录不属于本轮范围。

## GitHub 交付与真实收尾回执

- 功能提交：`005d49dd03d2a90ad88a91d2131701b407ed7c5f`，`feat: close out delivered task worktrees`，仅包含本任务 12 个文件。
- 交付期间远端并行新增 `e6a26d880621bf37d300390f27336a32f36b3804` 的侧栏修正；在临时交付分支正常 merge，无冲突，保留双方 README 和开发文档。收尾脚本、测试、GitHub helper、CI 映射、package、规则与本交接内容均未被并行整合改变，因此未重复仍适用的 52 项定向验证。
- 实际推送：`e6a26d8..dac5580 HEAD -> main`。GitHub API 回读完整 SHA `dac5580e2a7c81863dd16a1a9769319d9dfc0b11`，与临时交付 HEAD 一致；提交链接：https://github.com/Zixiaobowen/oc-chan/commit/dac5580e2a7c81863dd16a1a9769319d9dfc0b11 。全程正常推送，未强推。
- 真实预检和执行均从保留工作区调用 `npm run --silent closeout:task -- --worktree /Users/zvf003/ZStack/oc-chan-task-closeout-20261111 --handoff docs/codex-handoffs/2026-11-11-task-closeout.md`，最后一次增加 `--apply`。
- 推送前预检：exit 1，`blockers=[unmerged]`；目标 HEAD 为 `005d49d`，现场远端为 `e6a26d8`，`removed=false`，实际目录保留。
- 推送后预检：exit 0，目标和远端均为 `dac5580`；交接 blob `6801ed246b1c7f68d07e3df9661f643bdf9a2570`，dirty/ignored/protectedIndex/inUse/blockers 均为空；`stage=checked`、`removed=false`，证明默认报告不删除。
- 实际 apply：exit 0，`stage=removed`、`removed=true`、`directoryPresent=false`、`registered=false`。未传 discard；此新建交付工作树没有需要另行处置的 ignored 材料。
- 主代理回读本地持久回执并检查目录确实不存在；分支 `integrate/task-closeout-20261111` 仍指向 `dac5580e2a7c81863dd16a1a9769319d9dfc0b11`。保留工作区、原始主仓和其他任务目录未执行 apply。
- 持久回执：`/Users/zvf003/ZStack/oc-chan/.git/task-closeouts/09f04ee1-a432-432f-ab74-faac4fc254dd.json`。回执绑定的是执行当时的交接 blob；本节属于随后补交的执行记录。
- 查询时 GitHub Build macOS run `42953691493` 为 pending：https://github.com/Zixiaobowen/oc-chan/actions/runs/42953691493 。本地定向验证、推送和真实收尾成功不代表云端构建或预览发布已经完成。
- 中英文 README 已同步新命令并复核；本次补交仅记录实际执行结果，不改变功能或命令，无需再次修改 README。本轮未运行全仓测试、应用构建或安装。

## Git 身份修正

- 用户随后明确指定本项目 Git 身份应为 `Zixiaobowen`。核查发现远端与 GitHub 登录账号正确，但本地一直继承全局 `bowen.sun <bowen.sun@zstack.io>`，项目提交技能也写死了该旧身份。
- 用户进一步明确邮箱为 `2549863672@qq.com`。共用仓库本地配置与项目提交技能已统一为 `Zixiaobowen <2549863672@qq.com>`，覆盖助手此前选择的 GitHub noreply 地址，适用于 oc-chan 及其 worktree；不修改全局配置或其他仓库。
- `git var GIT_AUTHOR_IDENT` 与 `git var GIT_COMMITTER_IDENT` 均已返回上述身份。用户随后明确授权修正本项目历史中的 bowen.sun 记录；历史身份校正单独保留提交映射和文件树验证证据，不将这次授权泛化为今后的任意强推权限。
- 本次仅修正提交元数据配置与项目文档；中英文 README 已复核，无需更新，不重复应用测试或安装。
