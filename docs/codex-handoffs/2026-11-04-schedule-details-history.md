# 定时任务右侧详情与执行历史

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：开发工作区 `main`；GitHub 提交分支 `feat/schedule-details-history`，目标 `master`。
- 日期：2026-11-04
- 用户目标：点击定时任务，从右侧展开详情，详情包含执行历史。
- 状态：功能实现、定向检查、真实 Electron 验收和列出的评审修复完成。用户随后授权提交并合并到 GitHub；实际交付状态以该分支 PR 的合并回执为准。本次不安装或发布应用。

## GitHub 交付集成

- 从远程 `master` 的 `33068beb782384dda1cd675c3fcfa4f57e6e1746` 创建独立 worktree：`/Users/zvf003/tmp/oc-chan-schedule-details-history`。只移入本功能；未夹带 `main` 上的主题、拓扑提交及未提交的托盘、侧栏、无头开发和安装 hook 改动。
- 详情定位改为相对工作区的绝对定位，最大宽度为工作区宽度，去除对未提交侧栏变量的依赖；列表滚动不移动面板。
- 在独立 worktree 执行 `npm ci --no-audit --no-fund`、`npm exec tsx -- --test src/main/schedule-history.test.ts src/main/collectors/hermes-history.test.ts`（12/12）、`npm run build`（含类型检查、原生导航构建与 Electron bundle），均通过。
- 真实 Electron smoke 验证历史读取、25 条分页、Esc 与焦点恢复，以及默认 1280×860、880×640、200% 后 440×320 CSS 视口。最终窄窗面板位于 x=0、y=88、宽 440、高 232，无页面横向溢出；列表滚动前后面板位置一致。
- 新集成证据：`/tmp/oc-chan-schedule-pr-1793788073602/smoke.json`、`pr-default.png`、`pr-minimum-200.png`。最后截图通过 CDP 固定主渲染器可见性，避免自动化焦点变化触发正确的隐藏取消行为；历史数据与 IPC 未替换。
- 推送时仅对该命令禁用本机安装 hook；不修改仓库持久配置，不覆盖 `/Applications/OC Chan.app`。共享工作区与独立 worktree 均保留，不自动删除分支或 worktree。

## 已完成

- 任务整行及名称按钮均可打开右侧非模态详情；固定标题／关闭按钮，内容独立滚动，详情随窗口宽度调整。
- 保留任务来源、状态、执行计划、配置路径和最近结果；新增执行历史，25 条一页，按真实时间倒序、相同时间按 ID 稳定排序。
- 历史展示领取、开始、结束时间、耗时、结果、执行 ID 和投递结果；历史 running 与当前进程状态明确区分。
- Hermes 使用真实的 `~/.hermes/cron/executions.db`。OMP、launchd、crontab 明确显示该来源不支持逐次历史；不把最近退出码或单个输出文件伪装成历史。
- provider 与读取调度器分离；单个在途读取、一个可替换待处理请求，取消后等待资源释放再启动下一项。关闭、换任务、页面卸载、隐藏及窗口销毁会取消。
- SQLite 只读、堆预算 8 MiB、子进程输出 128 KiB、3 秒超时、每页 25 条、请求偏移最大 100000；仅读取白名单元数据，不读取任务输出、错误正文或提示词。
- 打开聚焦关闭按钮；Esc 关闭并返回原任务，原任务不可见时回到搜索框。聚焦到面板遮挡的背景目标时收起详情并保留新焦点。
- 翻页／重试保持历史标题焦点。前翻或后翻失败均可回到最近成功页，直接复用缓存，不再次读取出错的数据库。
- 200ms transform 过渡可反向；减少动态效果及隐藏窗口时停止位移。
- README.md 与 DESIGN.md 已更新相关说明，保留并行任务的托盘、主题、开发模式及侧栏改动。

## 相关文件

- `src/shared/types.ts`：历史记录、分页结果与有限 IPC 契约。
- `src/main/schedule-history.ts`：provider 接口与有界读取调度、取消。
- `src/main/collectors/hermes-history.ts`：SQLite 元数据读取、排序、预算及错误。
- `src/main/index.ts`、`src/preload/index.ts`：已知任务校验、历史 IPC 与取消、生命周期接线。
- `src/renderer/src/SchedulesView.tsx`、`ScheduleHistory.tsx`、`schedule-details.css`、`styles.css`：右侧详情、历史分页、焦点与响应式。
- `src/main/schedule-history.test.ts`、`src/main/collectors/hermes-history.test.ts`：取消并发、来源边界、SQL 排序、非法数据和正文隔离回归测试。

## 已执行验证

- 两个 history 测试文件的定向测试：12 项通过。覆盖读取错误不冒充空历史、时间偏移与亚毫秒排序、字段过长和 NUL、无效时间顺序、只读及任务隔离、2000 个替换请求与重复取消。
- `npm run typecheck && npm exec electron-vite build`：最终分页修复后通过。
- 独立 macOS Electron 窗口，使用临时 profile；实际点击、键盘、IPC、真实 Hermes 数据，不修改用户任务或正式应用设置。
- 默认 1280×860、最小 880×640、分屏、全屏、布局断点两侧及逐步连续缩放；尺寸依据应用内容区域。200% Electron 缩放下 880×640 内容区对应 440×320 CSS 视口，DPR 2 截图为 1760×1280。
- 中英文、浅深色、正常／空／不支持／错误状态；长内容注入只作用于测试快照。240 字任务名、699 字路径，200% 下页面与详情横向溢出均为 0，关闭按钮可见。
- 880 到 1280 每 20px 一步，共 21 个尺寸；详情宽度连续变化，最大单步 7.805px。
- 真实翻页、刷新、切换任务、过滤后关闭、隐藏恢复、Esc、Shift+Tab。评审新增三项均修复：双向翻页失败缓存恢复、重试焦点、窄窗遮挡焦点。
- 双向失败恢复均观测到请求计数 `1 → 1`，确认返回缓存页没有重读数据库；重试 pending 和成功后焦点都是 `schedule-history-title`。
- 录制真实主渲染器快速开关／反向动画；349 个 rAF 样本，最大间隔 17.7ms，无超过 33.5ms 的样本。性能 trace 9500 事件、58 DrawFrame、无超过 50ms 的 RunTask，Layout 合计 28.612ms。原生 screencapture 录到错误窗口的两份 MOV 不作为有效证据；有效证据为主窗口 CDP screencast 派生的 GIF 与 contact sheet。
- 合成压力：20000 条历史，单条 8 MiB 私有正文，200 个突发请求只完成最新 1 个，120 次重复读取；8.448 秒、162 次采样，读取器进程树峰值 RSS 153504 KiB，无 OOM，最多一个读取子进程（统计还含 ps）。
- 真实完整应用压力：24 次开关、200 请求突发（1 成功、199 取消）、80 次读取；6.379 秒、125 次采样，完整应用进程树峰值 RSS 917520 KiB，无 OOM。
- 同机 1280×860、DPR2、6 次开关对比：旧详情首帧 17.12–18.22ms，新详情 16.70–17.50ms；渲染任务总时间 55.836→84.731ms，脚本时间 13.525→26.948ms。新路径包含历史读取状态及记录渲染，且最终 bundle 同时包含并行主题／托盘改动，不能将 CPU 差值单独归因或宣称性能提升。对应应用树 RSS 单次采样 784048→714864 KiB，也不能作为长期内存结论。
- HistoryReview：读取端 blocking findings none；DrawerReview：最终 disposition ship，三个原发现全部 resolved。复审范围仅为列出的修复，不代表全仓审计。

## 证据

临时验收目录：`/tmp/oc-chan-schedule-details-1793783933011/`。

- `drawer-final.png`：最终稳定帧，深色真实数据。
- `drawer-default.png`、`drawer-page-two.png`、`drawer-minimum.png`、`drawer-dark-en-200.png`、`drawer-half-screen.png`、`drawer-fullscreen.png`、`drawer-error.png`。
- `drawer-long-content.png`、`long-content.json`、`continuous-resize.json`。
- `review-fixes.json`、`review-reverse-recovery.json` 及对应截图。
- `drawer-motion.gif`、`motion-valid-contact.png`、`motion-frames-active.json`、`drawer-trace.json`。
- `history-pressure-result.json`、`app-pressure.json`、`performance-comparison.json`。
- 压力验证脚本为临时脚本，验证后删除；合成数据库及记录保留在该临时证据目录，不加入产品或仓库。

## 边界与未覆盖项

- 未运行全仓测试；只运行本改动的定向检查。
- 未重新打包、安装或验收 `/Applications` 中的应用；源码运行成功不等于已安装版本更新。
- 未覆盖数小时／数日持续运行、120Hz 硬件、VoiceOver 实机播报或第三方插件反复装卸。短时压力与 60Hz 观测不能替代这些验收，也不宣称 SOTA 或整个应用永不 OOM。
- 历史只接入当前已确认的数据源 Hermes；其它来源明确显示能力边界。
- 测试时并行任务持续修改主题、托盘、开发启动与文档。本任务没有重置、全量暂存或删除无关内容；不要把共享工作区全部变更当成本任务。

## 用户偏好与限制

- 中文交付；真实数据，未知／不支持／失败分别表达。
- 保留并行改动；不留被替代的底部详情或兼容层，不新增运行时依赖。
- 只读任务配置和执行记录，不运行任务、不改变启停状态、不读取或输出私有正文。
- 用户已授权提交、推送并合并到 GitHub；未授权部署、安装或删除用户数据。

## 后续操作（按后续请求执行）

1. 继续开发时先确认使用哪个 worktree 与开发入口；独立交付分支使用 `npm run build` 与 `npm start`，共享工作区的并行开发任务另有入口。打开定时任务及一个 Hermes 任务检查当前代码。
2. 用户要求安装或发布时，先辨明共享工作区各任务的变更，再执行相应打包／安装验收；不要把本次源码检查当作安装包验证。
3. 新增其它来源的历史时，先确认真实逐次记录接口及完整性，在 `ScheduleHistoryProvider` 契约下接入；不得从计划或最近结果合成历史。

## 恢复提示

在 `/Users/zvf003/ZStack/oc-chan` 继续，或检查独立交付 worktree `/Users/zvf003/tmp/oc-chan-schedule-details-history`。先读本交接与 GitHub PR 当前状态，保留共享工作区其它任务改动。用户要求的右侧详情和执行历史已完成；逐次历史目前仅接入 Hermes，分页每页 25 条。后端读取有界、可取消；双向翻页失败缓存恢复、重试焦点、窄窗遮挡焦点已经复核。基于 master 的独立集成已通过 12 项定向测试、完整构建与真实 Electron smoke；详情定位不依赖并行侧栏改动。用户授权提交、推送和合并，不包括安装部署。证据路径见上文，不重复仍适用的检查。
