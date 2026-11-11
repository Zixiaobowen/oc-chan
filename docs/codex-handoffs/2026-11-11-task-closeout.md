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

## 用户授权的历史身份校正

- 用户明确声明本项目提交均由自己完成，要求修正 bowen.sun 记录，并指定 `Zixiaobowen <2549863672@qq.com>`；该授权仅适用于本次身份历史重写。
- 仓库仍为 `Zixiaobowen/oc-chan`，保留工作区 `/Users/zvf003/ZStack/oc-chan-main-menu-fix-20261110`，分支 `chore/task-closeout-20261111`。共用仓库本地身份配置已生效；项目 `.agents/skills/commit-push/SKILL.md` 已同步 QQ 邮箱，未改全局身份。
- 重写前先整合并行任务的最新 main，再以 `[skip ci]` 提交本任务邮箱规则。隔离镜像位于 `/Users/zvf003/tmp/oc-chan-identity-20261111-wn8lor2a/rewritten.git`，未在用户工作区运行 filter-repo、reset、clean 或 checkout。
- 使用 `uv tool run --from git-filter-repo==2.47.0 git-filter-repo` 和精确 mailmap，只统一公司邮箱、原 noreply 地址及 QQ 邮箱对应的个人姓名。保留提交说明、编码、日期、空提交与合并拓扑，不添加 replace refs。
- 共验证 98 个本地可达提交：67 条作者记录、63 条提交者记录修正，98 个 SHA 改变。每条新旧提交的 tree、message、时间及映射后的父提交顺序均一致。4 个 GitHub 合并提交保留 `GitHub <noreply@github.com>` 提交者；重写后不能沿用旧对象的 4 个签名，旧签名保留于备份对象。
- `git bundle verify before.bundle`、隔离镜像 `git fsck --connectivity-only --no-reflogs --no-dangling`、逐提交原始对象校验均通过；未运行应用测试、构建或安装，因为应用文件树未改变。
- 以 `git push --atomic` 配合每个远端引用的精确 `--force-with-lease=<ref>:<old-sha>`，一次更新 main 与 5 个发布标签。远端 main 从 `bedb252c69e561dbd7b854bd711bf98d45b6334e` 映射到 `24f07b529458c96f7cbbfd56e4c80313c3735490`；`git ls-remote` 已逐项确认 6 个目标引用。标签名称及安装包附件不变，名称内旧短 SHA 是原发布标识。
- GitHub API 已确认该重写主线上的 97 个提交，作者姓名、邮箱及账号归属分别全部为 `Zixiaobowen`、`2549863672@qq.com`、`Zixiaobowen`。本条记录之后的回执提交使用同一身份。
- 本地导入新对象后，用带旧值校验的 `git update-ref --stdin` 事务映射 41 个引用。10 个现存工作树的 index SHA256、porcelain 状态及未提交 diff SHA256 均保持一致；1 个原有失效登记保持原状。未删除分支、目录、日志或旧对象，未把其他分支前移到最新 main。
- Build macOS workflow `406618753` 在重写窗口暂停，旧历史 run `42966224739` 已确认取消；完成后 workflow 回读为 `active`。本次未重新运行该构建或发布新版本，不把历史校验当作云端构建通过。
- 已确认 GitHub 仍保留 `refs/pull/1/head` 至 `refs/pull/4/head` 的旧 SHA。这些是 GitHub 管理的只读 PR 引用，不能通过普通 Git 推送修改；旧提交页面、PR 档案及本地 reflog 中可能仍看到旧身份，不宣称旧对象已从托管平台物理删除。
- 仓库内持久映射：[2026-11-11-git-identity-commit-map.tsv](./2026-11-11-git-identity-commit-map.tsv)。隔离目录内另存 `before.bundle`、`before.json`、`verification.json`、`remote-push.txt`、`local-application.json`、`github-verification.json`；原始证据与 Git 备份保留，不纳入普通 worktree 清理。

### 历史校正后的恢复步骤

1. 后续工作以当前 GitHub main 为基线；本机已注册工作树的分支已按映射迁移，先查看自己的实际未提交改动，不做硬重置。
2. 查阅旧交接、安装包或 CI 日志中的 SHA 时，使用上述 TSV 对照新 SHA；其他电脑的旧克隆不可将旧历史直接合并或强推回来。
3. 如需验收后续代码改动，按对应任务运行定向检查；被取消的旧构建未自动重跑，发布需按当前任务授权另行处理。

恢复提示：继续 OC Chan 开发前读取本交接的历史身份校正段及 SHA 映射。Git 身份固定为 Zixiaobowen <2549863672@qq.com>，已修正 main、5 个标签及本地引用；保留所有用户未提交改动与备份。不要重复重写历史、恢复公司邮箱或删除只读 PR 的历史材料。
