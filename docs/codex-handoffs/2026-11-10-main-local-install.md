# main 本机安装交接

- 仓库：/Users/zvf003/ZStack/oc-chan-main-menu-fix-20261110；分支 main；来源提交 175664a。
- 目标：使用最新 main 更新本机 OC Chan。已快进 main 并完成构建安装。
- 原目录 /Users/zvf003/ZStack/oc-chan 保持 refactor/plugin-system-monitor；其中未提交改动原样保留，未强行切换或暂存。
- 调查文件：package.json、scripts/install-local.mjs。未修改应用源码。
- 命令：git fetch origin main；在 main 工作目录执行 git merge --ff-only origin/main；env PATH="/Users/zvf003/.cargo/bin:$PATH" npm run install:local。
- 初次安装因 Cargo 不在 PATH 失败，未开始替换应用；一次替换完整 PATH 的尝试因找不到 rtk 失败。保留原 PATH 并追加 Cargo 路径后成功。
- 安装结果：/Applications/OC Chan.app；安装器确认真实 React、IPC、采集和历史就绪，PID 17606。来源构建 app 已由安装器清理，源码和安装证据保留。
- 该次安装未执行完整测试套件、人工原生窗口交互或性能验收，也未提交、推送或远端发布；后续文档补交见下文。
- 限制：不得覆盖原工作目录未提交改动或清理其他任务工作树。

## 后续动作

1. 继续开发时使用上述 main 工作目录。
2. 如需将原目录切换为 main，先与用户确认其中未提交工作的归属及保留方式；当前安装不依赖该操作。
3. 出现启动问题时读取 main 工作目录 release/tauri/installations 内本次安装回执。

恢复提示：本机 OC Chan 已从 main 175664a 构建安装且安装器就绪验证通过；原 oc-chan 目录仍有用户未提交改动，不要覆盖。此次未提交或推送。

## 2026-11-11：安装证据补交 main

- 用户授权将 `main-menu-fix` 的剩余工作提交并推送 GitHub `main`。功能源码 `175664a89e002be1185b27a5c678061545bb291a` 已在远端历史中；此前唯一未跟踪文件是本交接。本次将本地 `main` 从该提交快进到 `e613d0242c31409e06b9507f25746cab59b1d404`，只补交历史安装记录，不改应用代码、不重装应用。
- 现场核对了以下本地原始回执；它们证明的是 2026-11-10 的安装结果，不是本次重新运行的应用验收。原始回执和构建产物仍留在本工作树，不把签名授权文件、运行日志或二进制提交到源码仓库。
- 已审阅当前中英文 README；本次仅补交历史证据，不改变功能、安装流程、支持边界或文档入口，因此两版均无需更新。

### 原始回执中的结果

- 安装时间：`2026-11-10T16:37:35.121+08:00`；目标 `/Applications/OC Chan.app`；版本 `0.1.0`；`installed=true`。
- buildId：`c0d0a4bf-b832-4620-8bfa-7e5e248ba177`；安装来源摘要（`source.digest`）为 `5249f3bf7abd9635b6f984a232779f53fed82b75668322c11cf3ffae62dcf9c7`。
- 就绪检查时间：`2026-11-10T16:37:32.936+08:00`；`renderer_committed=true`、`ipc_round_trip=true`，入口为 `main:index.html:react-commit`。
- agents、events、schedules 均为 enabled/installed/ready；system 未安装。Hermes 历史为 available，回执记录 25 条。
- 包检查：arm64，29,257,322 字节，`ad-hoc verified; online updates disabled`。分发记录 `published=false`、`artifacts={}`，不能将此次本机安装写成发布。

原始文件路径相对本工作树，SHA-256 于 2026-11-11 现场计算：

```text
e113b42864ba772546c851b12bb25cd25ff9aa9f4aeeca0dfa361a538fb00456  release/tauri/installations/installation-xcgw8Q/installation.json
878764eb2794d096c1cc395164436c65a6569973382fc77179411d429111bf64  release/tauri/installations/installation-xcgw8Q/installed.json
4bcb7c31c6d5ba9496c02c9392498b875823f2602de4a745368be1f3f31062c2  release/tauri/installations/installation-xcgw8Q/oc-local-install-27fb774a-c7fd-4f04-b5de-206211d47f33/receipt.json
15bc0e612e0f63affa32d95ec1dd05d2e71d264579829024b387c1f78a63ed23  release/tauri/c0d0a4bf-b832-4620-8bfa-7e5e248ba177/package-report.json
22b1a1a50c8075c696de9c9bd24094651d80ac3bfc1d5403608fd6050a910841  release/tauri/c0d0a4bf-b832-4620-8bfa-7e5e248ba177/distribution.json
```

### 同次授权的 worktree 清理

以下五个目录已逐项通过 `git worktree remove` 移除，并核对目录不存在、注册记录消失；未删除分支：

- `oc-chan-plugin-navigation-20261110`
- `oc-chan-street-20261110`
- `oc-chan-street-baseline-20261110`
- `oc-chan-plugin-navigation-baseline-20261110`
- `oc-chan-update-20261110`

清理前确认五个 HEAD 均被远端 `main` 包含，当前可见的打开文件中无这些目录路径。插件导航 baseline 唯一修改为 `scripts/performance/vite-plugin.mjs`，工作文件与远端 main 的 blob 均为 `cad4f5a3dc95337a3422adee6b6325c44608dc7d`，仅该目录使用 `--force`；其余四个使用普通移除。

保留 `oc-chan` 主目录及共用 `.git`、本 `main-menu-fix` 工作树和全部原始安装回执；保留含未提交工作的 `oc-chan-sidebar-main-20261111` 与 `oc-chan-rust-merge-20261110`。没有清理范围外的临时目录、会话或其他注册工作树。

恢复提示补充：本次目标是五个获批 worktree 清理及本交接进入 GitHub main。安装结果属于历史证据；不要重复安装。后续若继续收尾，先核对远端是否包含本交接提交，再分别处理 sidebar 与 native-update 的未提交工作；没有新授权不扩大删除范围。
