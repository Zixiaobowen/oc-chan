# 活跃筛选保留子代理 · 2026-11-04

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：实现阶段为 `master`；用户要求 commit 并 push 到 `main` 后，已创建并切换到 `main`。本机覆盖安装结果见下节。
- 用户目标：修复“筛选到活跃时无法查看子代理”；延续此前“协作拓扑”改名与筛选重排。
- 状态：源码、构建、回归测试、真实 macOS 窗口 smoke 及用户授权的本机覆盖安装已完成。

## 根因与变更

`projectAgentTopology` 原先仅在 `activity === 'all'` 时保留匹配项的后代。因此主 Agent 活跃、子代理空闲或状态未知时，活跃筛选直接移除了子代理，无法打开其详情。

- `src/renderer/src/agent-topology.ts`：活跃筛选复用现有有去重保护的后代遍历，保留命中项的父链和完整子树。未命中节点为关联上下文，不改变真实状态或匹配计数。不活跃筛选继续只补齐父链；不会把祖先的其他未匹配分支拉进来。
- `src/renderer/src/agent-topology.test.ts`：新增活跃主 Agent 保留空闲、未知及多级后代的回归；覆盖类型筛选、折叠状态、无关分支排除、匹配计数及无重叠。更新角色与搜索组合用例的消费者预期。
- `src/renderer/src/AgentsView.tsx`：中英文帮助文案说明活跃筛选保留子树，关联子代理不计入匹配数。
- `README.md`、`DESIGN.md`：更新现行筛选规则；前一份 topology-filter-reflow handoff 增加本记录链接。
- 保留此前及并行任务对 `App.tsx`、`AgentTopology.tsx`、侧栏、样式、文档等文件的修改；未暂存或重置无关内容。

## 实际检查

- `node_modules/.bin/tsx --test src/renderer/src/agent-topology.test.ts`：14/14 通过。未运行全仓测试。
- `npm run build`：TypeScript、原生 helper、Electron Vite 构建全部通过。
- `impeccable detect --json src/renderer/src/AgentsView.tsx`：返回 `[]`。
- 独立 Electron 实例：`--user-data-dir=/tmp/oc-active-subtrees-20261104 --remote-debugging-port=9371 --inspect=9241`；窗口 PID 66115，服务树根 PID 66111。
- 原生 1280×860 内容区：冻结真实快照后，活跃筛选显示 5 个匹配、2 条父子关系、2 个关联节点。两个子代理均为真实采集的“状态未知”节点；逐一点击均成功打开详情并关闭。
- “主 Agent + 活跃”组合仍显示两个子代理作为关联上下文。连续 12 次全部/活跃切换后，子代理、父子连线和计数正确，画布重新排列。
- 880×640 内容区及其 200% 页面缩放（CSS 视口 440×320）均无整页横向溢出，关联计数保持。
- 浏览器错误列表为空。测试实例通过 `app.quit()` 退出，服务回执 exit code 0。释放浏览器接管并清除资源守卫定时器。
- 证据：`.impeccable/review/active-subtrees-2026-11-04/validation.json` 和 `active-subtrees.png`。

## 性能与内存证据边界

原生实例设置 1.25GiB RSS、180 秒守卫。实际采样约 164 秒，整棵受测进程树 RSS 峰值 860.875MiB，未触发预算；这不代表长期内存或原生 footprint 验收。12 次真实筛选操作耗时约 31.75–35.33ms，包含自动化调用和两次 requestAnimationFrame，不能当作 INP 或动画帧时间。

另取同一份 20 Agent（2 个子代理）的真实快照，在同一 Node 进程分别运行 HEAD 与当前源码的投影加布局，每组预热 20 次、测量 300 次。该快照晚于原生冻结快照，因此活跃匹配为 6 个。

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 匹配 / 关联 / 连线 | 6 / 0 / 0 | 6 / 2 / 2 |
| 投影加布局 P50 | 0.0066ms | 0.1891ms |
| 投影加布局 P95 | 0.0188ms | 0.3102ms |
| 300 次累计 CPU | 8.153ms | 95.727ms |

修复后恢复了两个子节点及其连线布局，计算成本相应增加，当前样本 P95 仍低于 1ms；不能据此宣称性能提升或大图性能结论。本轮没有原生界面同一快照的修复前 CPU/内存对照，也没有长期压力、原生全屏、英文深色或键盘操作复验；相关旧验证范围见前一份 handoff。

## 本机覆盖安装

- 用户指令：“覆盖我本地安装的occhan”。安装位置为 `/Applications/OC Chan.app`，原有应用主进程 PID 5182 正常退出后覆盖。
- 使用前一轮已经通过构建和原生窗口验收的 `out/` 打包；现场发现定时任务相关源码更新晚于该构建，这些并行更新未纳入本次安装。没有重复运行已通过的构建或测试。
- `node_modules/.bin/electron-builder --mac dir --publish never --config.electronDist=node_modules/electron/dist` 成功，产物为 `release/mac-arm64/OC Chan.app`，版本仍为 `0.1.0`，Electron 45.2.1 / arm64。按现有配置跳过 Developer ID 签名。
- `/usr/bin/ditto` 覆盖安装成功。打包与已安装 `app.asar` SHA-256 均为 `a22a935468d778f6574d9b10f75a532f0eb9256ff7e38cb9e8061d2a7dd1e566`。包内 renderer 引用已验收的 `index-Cz4MNPzB.js` 与 `index-CSeAvgSB.css`。
- 用户配置位于 `/Users/zvf003/Library/Application Support/OC Chan/settings.json`；安装前、覆盖后及普通启动后 SHA-256 均为 `b47284ace35af36e8517f6252e9f4d3d2767caf36a564e2cf0f4a48234e8a64c`，未修改个人设置。
- 实际验收进程 PID 95866，执行文件为 `/Applications/OC Chan.app/Contents/MacOS/OC Chan`，页面来自已安装 `app.asar`。冻结快照时活跃筛选显示 6 个匹配、5 条父子关系、5 个关联子代理；逐一点击五个子代理均成功打开详情。页面无横向溢出，浏览器异常列表为空。
- 初始冻结快照有一次会话文件截断的更新提示；后续 snapshot 中 Agent error 已为 null，恢复实时显示后提示自动清除。尝试点击“重试”时按钮已消失，工具返回未匹配元素；未将这次点击称为成功。最终三个数据分区 error 均为 null，无 alert 或重试按钮，真实数据变化后显示 6 个匹配、4 条关系、4 个关联节点。
- 安装验收采样约 101 秒，进程树 RSS 峰值 813.3125MiB，未触发 1.25GiB / 180 秒守卫；不代表长期内存验收。
- 释放浏览器接管，验收进程正常退出（exit code 0），移除资源守卫，再通过 LaunchServices 普通启动。最终主进程 PID 1413，命令仅为 `/Applications/OC Chan.app/Contents/MacOS/OC Chan`，不带调试参数；9371、9241 均无监听。
- 普通启动后的初次 AX 查询未列出窗口；临时启用 `AXManualAccessibility` 后确认窗口数 1、标题 `OC Chan · 本机运行监控`、frontmost=true。随后恢复该辅助验收标志。CoreGraphics 备选查询工具失败，未以其结果作验收证据。
- 安装证据：`.impeccable/review/active-subtrees-2026-11-04/installed-validation.json`、`installed-final.png`。安装阶段没有对外发布。

## Git 交付范围

- 用户要求“提交commit push到main”，随后要求继续。远端原先只有 `master`，本地创建 `main` 作为本次提交与推送目标；仓库默认分支仍为 `master`。
- 并行任务已将 `33068be fix(schedules): resolve Hermes runtime status` 提交并推送到远端 `master`，当前 `main` 以此为基线，保留该提交。
- 本次提交仅包含拓扑改名、筛选重排、活跃子树保留、对应测试及两份拓扑交接记录。`App.tsx`、README、DESIGN 按改动块暂存；侧栏拖动、样式及对应交接保留在工作区。
- 选定暂存内容导出到独立目录 `/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/oc-chan-main-0o4nomeu`，`npm run build` 通过，含 TypeScript、原生 helper 与 Electron Vite 构建；没有覆盖当前工作区的 `out/` 或本机应用。之前通过的 14 项拓扑测试及原生验收仍适用，没有重复运行或扩大到全仓测试。
- `.github/workflows/build.yml` 仍仅监听 `master` 的 push / pull_request，本次推送 `main` 不会自动触发该构建工作流；未修改仓库默认分支或 CI 触发规则。
- 本记录与拓扑源码一起提交；具体提交号与远端位置以 Git 提交记录及 `origin/main` 为准，不将已安装应用版本等同于新的 Git 分支内容。

## 限制与后续动作

- 用户此前遭遇其他 GPUWorks 测试树触发系统内存警报；本轮只启动一个受资源守卫约束的 OC Chan 实例，未触碰其他进程或修改采集器。
- 用户要求保留并行未提交改动，不做全量暂存、重置或清理。
- 已安装应用已覆盖并正常打开，用户配置保持不变。该安装对应拓扑修复阶段已验收的 `out/`，未包含后来提交的 Hermes 定时任务修复。Git 提交范围见上节。

后续按用户新指示执行：

1. 如需纳入晚于本次构建的定时任务修改，先完成其对应验证，再重新构建安装；不能把本次覆盖说成已包含这些源码。
2. 后续提交继续仅纳入用户授权的改动块，保留侧栏及其他并行工作；`main` 的 CI 和默认分支调整另按用户要求处理。
3. 新问题先区分匹配节点与关联上下文，沿当前投影和真实快照定位；已通过且仍适用的检查不重复运行。

恢复提示：继续 `/Users/zvf003/ZStack/oc-chan`，当前分支 `main`，保留侧栏等未提交修改。活跃筛选无法查看子代理已修复：命中项保留父链与完整子树，空闲/未知子代理作为关联上下文可点开，匹配计数不增加；不活跃筛选仍仅补齐父链。14 项定向测试、真实窗口及安装后验收通过；选定提交内容的隔离构建也通过。用户已授权提交并推送 main，具体提交位置查 Git。已安装 app.asar 为 a22a9354…，设置未变；安装不含后来提交的 Hermes 修复。远端默认分支及 CI 触发仍为 master。
