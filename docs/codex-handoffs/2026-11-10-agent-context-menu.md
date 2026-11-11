# Agent 右键菜单闪退修复

- Repo: /Users/zvf003/ZStack/oc-chan
- Branch: refactor/plugin-system-monitor
- 目标：协作拓扑右键 Agent 后，“跳转到 Tern 标签页”菜单保持打开且可以点击。

## 已完成

- `src/renderer/src/AgentContextMenu.tsx`：共用菜单从 auto popover 改为 manual，保留顶层显示和定位；捕获后续外部 pointerdown 关闭，内部事件不关闭，卸载移除监听。保留 Escape/Tab 及原有跳转行为。移除依赖原生 toggle(closed) 的状态清空。
- 根因证据：原实现于 contextmenu 内打开 auto popover，并在浏览器关闭时立即卸载。开启手势后续释放触发自动关闭是源码推断，未记录旧版浏览器事件轨迹；本次通过手动管理关闭消除该路径。
- `scripts/smoke/topology-scenarios.mjs`：新增 2D/3D 标签完整 CDP 右键按下/释放、移入、点击菜单项、外部关闭、Escape 回焦、Shift+F10、Tab 验收。点击通过真实 IPC 返回 headless 禁止原生激活错误，不模拟跳转成功。
- `docs/development.md`：增加菜单生命周期及验收范围说明。

## 验证

- `npm run typecheck`：通过。
- `node --import tsx --test --test-name-pattern='headless' src/main/ipc-boundary.test.ts`：1 项通过。
- Impeccable detect 仅检查 AgentContextMenu.tsx：返回 []。
- `npm run smoke:renderer -- --scenario topology`：最终通过。结果 `/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/oc-chan-smoke-evidence-UhEuGe/result.json`：complete=true，errors=[]；首次和重启实例均 processesGone=true、profileRemoved=true，workDirectoryRemoved=true。
- 前四次 smoke 因新增用例前置条件失败：关闭详情后标签隐藏、Tab 后 Escape 不在详情范围、2D 目标在画布视口外。测试改为通过概览定位、显式关闭详情、右键前使用实际“适应视图”按钮；未为这些测试调整生产场景逻辑。
- 已查看中间运行的 2D/3D 菜单打开截图，菜单可见且菜单项有焦点。

## 范围、风险与限制

- 用户已有发布相关未提交改动必须保留，尤其 docs/development.md 原有改动。无全量暂存、提交、推送或安装。
- 未替换 `/Applications/OC Chan.app`，未验收原生 Tern 激活、3D 模型 raycast 入口或硬件右键设备；两种视图已验收共享菜单的真实 CDP 输入。
- 无全仓测试或性能提升声明。
- Impeccable 报告已有 DESIGN.md 与 .impeccable/design.json 不同步，本次未扩大范围处理。

## 后续动作

1. 如需在已安装应用使用，按仓库本地交付流程构建并安装，注意工作区包含并行发布改动。
2. 经明确原生窗口交互要求后，检查实体/触控板右键及真实 Tern 窗口激活。
3. 如要求提交，仅暂存本次菜单、smoke、文档新增段与本交接，保留其他改动。

恢复提示：继续处理 OC Chan Agent 右键菜单修复。读取本交接；源码和真实无头 Electron 拓扑定向验收已完成，不要重复通过的检查。尚未提交或安装，工作区有用户发布改动，保持其原样。

## 本地 main 提交

用户随后要求“提交到main”。在独立工作树 `/Users/zvf003/ZStack/oc-chan-main-menu-fix-20261110` 的本地 `main` 上仅应用两个菜单实现/测试文件、development.md 的菜单说明新增段及本交接；原工作区和其他未提交改动保留。main 的菜单及测试基线与已验收分支一致，本次未改行为或重复运行检查。此前“未提交”描述为修复完成时状态；本节记录后续本地提交操作，不包含推送、安装或发布。

## GitHub 推送整合与项目技能

用户明确要求继续推送 GitHub，并新增项目级 `commit-push` skill。此前本地 main 的 `6e21c20` 基于旧主线；fetch 后发现远端已迁移 Rust/Tauri/WKWebView，现于独立工作树将本次提交 rebase 到远端 `24a1ded`。保留新拓扑任务楼层和全部远端文档，菜单组件修复不变，回归切换为真实 AppKit 输入。

- acceptance 专用 `scripts/smoke/main-probe.mjs` 与 `src-tauri/acceptance/wk-driver.mm` 新增明确 left/right 按钮和 F10（macOS keyCode 109）；现有独立 WK probe 同步显式 left 参数。无 CDP 兼容层。
- 当前 `npm run typecheck` 和三个改动验收脚本的 `node --check` 通过。
- 当前原生 topology smoke 通过：`env PATH="/Users/zvf003/.cargo/bin:$PATH" npm run smoke:renderer -- --scenario topology`。首次不带 PATH 的运行因 `spawn cargo ENOENT` 失败；本机 Rust 1.99 位于已有 `.cargo/bin`，仅给该命令补充 PATH。
- 原生证据：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/oc-chan-smoke-evidence-FRx9lc/result.json`，`complete=true`、`errors=[]`，包含真实原生构建、2D/3D 完整右键、点击跳转后的 `OC_TERN_UNAVAILABLE`、外部点击、Escape/Shift+F10/Tab、退出和同实例重启。以上旧 Electron 记录仅为历史，不作为新宿主通过依据。
- `.agents/skills/commit-push/SKILL.md` 已创建并由 `omp skill list --json` 识别为 `agents:project`；当前原工作区也放置相同技能，可通过 `skill://commit-push` 加载。明确本项目“提交到 main”完成 GitHub 推送与回读，仅“commit 就好／本地提交”停止于本地。
- 本次用户授权包括 GitHub 推送和 skill，不包含安装、发布及跨工作树应用清理；`push-main.mjs` 会捆绑跨工作树清理，因此仅执行显式 Git push 与 GitHub 回读，保留其他任务工作树。

恢复提示：本节优先于上文阶段性状态。原生验证和项目 skill 已完成，下一步完成 rebase、将 skill 独立提交、正常推送 `HEAD:main` 并用 GitHub API 核对提交。不要重复通过的验证；原始工作区产品改动保留，未安装或发布。

## 补存的最终 GitHub 回执（2026-11-10 历史状态）

原工作区后续回执记录：菜单修复 `5722d23` 与技能提交 `1a777785f70b68dbdc916e3c29752518f5f235bd` 已推送到 GitHub main，API 回读与当时 HEAD 一致；未安装或发布。此前“下一步推送”为阶段状态。

当时原生 topology 验收证据为 `/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/oc-chan-smoke-evidence-FRx9lc/result.json`，记录 `complete=true`、`errors=[]`。本次仅补存记录，没有重新运行或确认临时附件仍存在。

Actions 运行 `42775275844` 在当时回执中为 `in_progress`，不是当前 CI 状态；后续结果见 `2026-11-10-github-release-automation.md`。历史 SHA 在身份修正后已变化，对照同目录 `2026-11-11-git-identity-commit-map.tsv`：菜单提交对应 `d7bc8cada5852cb8732d759f1285732f36cf3aa3`，技能提交对应 `873fdfacd50a75c2346c7a6ca40f2914872c0e81`。
