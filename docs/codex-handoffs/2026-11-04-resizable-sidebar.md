# 可调整宽度的左侧菜单栏 · 2026-11-04

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：任务开始时为 `master`，本任务未切换分支。
- 用户目标：左侧菜单栏支持拖动，并有 min / max。
- 状态：源码、构建和真实窗口验收完成；用户随后授权覆盖本机应用，新包已安装至 `/Applications/OC Chan.app` 并正常启动。未提交或推送。

## 实现

- 默认宽度 214 CSS px，最小 188px，最大 320px；实际最大值为 `min(320, viewportWidth - 560)`，窄视口给工作区保留至少 560px。
- `SidebarResizeHandle.tsx` 为独立组件，宽度调整只重绘分隔线的辅助技术状态，通过 CSS 变量改变网格；不让整个 App 随指针事件重绘。每帧最多安排一个更新，没有永久动画循环、持久队列或新依赖。
- 使用 pointer capture；10px 命中区，鼠标悬停和聚焦高亮。箭头键每次 8px，Shift + 箭头 32px，Home/End 到边界，双击恢复默认，Esc 取消拖动。指针取消、失焦、窗口隐藏和进入紧凑导航时取消拖动；卸载释放监听和 ResizeObserver，取消在途帧。
- 用户选择只保存在当前 App 页面实例内；切页和窗口临时变窄不丢失，恢复宽窗后重新应用。重载或重启恢复默认。没有新增持久化设置契约。
- 保留 760px 以下的原生 popover 导航。分隔线隐藏时将其焦点交给导航按钮；当前页、搜索、画布视口和滚动位置不因调宽重置。
- CSS 同步限制实际网格宽度及分隔线位置，不依赖 ResizeObserver 的回调时机。初次临界测试在 761px 读取到回调前旧宽 320px，已通过 CSS clamp 修复；最终测得侧栏 200.999px、工作区 560px、手柄中心与侧栏边缘偏差小于 0.001px，随后辅助技术最大值为 201。

## 文件范围与并行改动

- 新增：`src/renderer/src/SidebarResizeHandle.tsx`。
- 修改：`src/renderer/src/App.tsx`、`src/renderer/src/styles.css`。
- 文档：`README.md`、`DESIGN.md`、本交接。
- 已调查：`package.json`、`src/main/index.ts`、`src/renderer/src/settings.tsx`、此前 select 交接。
- 开始时已有用户／并行改动：`package.json`、`.github/`。README 在本任务期间也被其它任务扩充；编辑器将本任务新增段落映射到未变的“更新方式”段落后，已读回确认位置。保留这些改动，未做全量暂存、清理或 Git 历史操作。

## 实际检查

- `npm run build` 通过：TypeScript、原生 helper、Electron Vite 主进程／preload／renderer 构建。最终 CSS 约束修正后再次构建通过。
- 没有运行全仓测试或新增永久测试；本次验证为针对真实 UI 的交互 smoke。
- 使用 `node_modules/.bin/electron out/main/index.js --user-data-dir=/tmp/oc-sidebar-review-20261104 --remote-debugging-port=9367 --inspect=9237` 启动独立 macOS 原生窗口。实际 profile 为 `/private/tmp/oc-sidebar-review-20261104`，未修改用户个人设置。
- 实际尺寸：内容区 1280×860、880×640；原生全屏 2560×1440；959/961、1119/1121 断点两侧；连续原生窗口宽度变化 880→1280。200% 缩放时 880×640 内容区对应 CSS 视口 440×320、deviceScaleFactor=4。
- 全部六页在 880×640、侧栏 320px 下检查，无页面根节点或主内容横向溢出。英文、深色、15px 字号和侧栏 188px 可操作；长主机名省略并保留 title，导航文字可换行。
- 动态上限：800 CSS px → max 240；最终 761 CSS px → max 201；760px 进入紧凑导航，分隔线焦点迁移到导航按钮。200% 下展开导航、滚动并点击设置成功，恢复 100% 后恢复原宽度。
- min/max 拖动、左右键、Shift 步长、Home/End、Esc、双击恢复、途中反向、隐藏取消／显示恢复均通过。空 Agent 搜索结果下侧栏保持正常；真实采集错误状态出现时导航仍可用。
- 50 次边界往返拖动，每次断言实际值为 188 或 320，松手后均清除拖动态。约 5.0 秒完成，单次五步输入的端到端 P95 为 90ms；这不是单帧输入延迟。
- 50 次拖动前后 Agent 搜索值、React Flow viewport transform、主内容 scrollTop 完全相同。DOM 事件监听器 311→311；节点 1598→1620，显式 GC 后回到 1598，document 为 1。没有把这段短测量当作长期内存上界证明。
- `prefers-reduced-motion: reduce` 的运行时切换已验证，键盘调宽照常生效。新增分隔线没有动画或过渡。
- `ui.errors()` 最终为空。LSP 现场返回未配置语言服务器，使用 TypeScript 构建作类型检查。
- Impeccable layout 初扫无命中；末次机械扫描 13 条 advisory 均为原有样式的圆角值不在文档枚举中，新增手柄没有圆角，不据此改动无关组件。

## 性能与证据边界

硬件：Apple M4 Max，128 GiB，主显示器约 59.94Hz、缩放 2。测量同一应用、同一主显示器、概览页，32 次原生窗口宽度变化、约 4 秒。现场其它任务持续运行，Agent 数量从基线 30 变化到最终 26。

| 指标 | 修改前 | 最终构建 |
| --- | ---: | ---: |
| rAF 帧数 | 240 | 241 |
| 帧间隔 P95 | 17.6ms | 18.4ms |
| 最大帧间隔 | 17.7ms | 18.6ms |
| 超过 34ms 的帧 | 0 | 0 |
| Electron 进程 CPU 汇总采样均值 | 1.30% | 0.93% |
| Electron 五进程 RSS 采样峰值 | 651184 KiB | 701600 KiB |

这些是短时现场采样，不宣称性能提升。reload 后 RSS 会含尚未回收的旧渲染资源；首版交互及 GC 后五进程 RSS 回到 655536 KiB。最终采样前再次 reload，未做冷启动隔离对照；RSS 不涵盖采集器的所有短命外部命令。尚未进行长时间 OOM、插件反复启停或并发突增压力测试，本次没有改动这些采集资源路径。

证据目录：`.impeccable/review/sidebar-2026-11-04/`

- `validation.json`：真实场景、修改前／最终指标及临界修复证据；字段 `scenariosBeforeFinalCssClamp` 保留初次 761px 失败采样，不误称为最终结果。
- `final.png`：最终构建、1280×860 中文浅色概览。
- `drag.mov`：macOS `screencapture -v -l26077 -V12` 生成的 12.015 秒真实窗口录屏。
- `drag-frames.png`：用系统 AVFoundation 抽取六个时刻进行视觉检查，观察到边界随拖动改变且画布状态保持。没有完整逐帧掉帧分析。

浏览器录像接口因 PATH 缺失 ffmpeg 失败，改用系统录屏并成功保存；未安装额外依赖。最初 rAF 采样因原生窗口未呈现而超时，经 System Events 按真实 Electron PID 呈现后采样成功。一次 System Events 使用了包装进程 PID，返回 -1719，随后通过主进程 inspector 获取真实 PID 修正。以上工具失败不属于产品异常。

未验证：macOS 原生 Split View 双应用配对、VoiceOver 实际朗读、120Hz／其它显示器、真实触控屏、长时间资源压力；默认 1280px 内容宽度等于当前主显示器半宽，但不把它称为原生 Split View 验收。已补充本机安装包与安装后应用验收，见下节。

## 意外中断恢复

- 用户报告电脑意外卡死，并要求沿用原授权恢复。本任务没有派发子代理，无待接回的实现结果。
- 中断发生在验收完成、交接写入之后，退出独立应用的 inspector 请求超时。恢复后 `proc://oc-sidebar-review` 显示进程已退出，退出码 137；该退出码本身不能确定电脑卡死或 OOM 的原因。
- 恢复后 `lsof` 确认 9367 / 9237 无监听，`browser.tabs()` 返回空数组，没有遗留的本任务浏览器接管句柄。不再启动已完成验收的进程。
- 组件快照仍为 `C49A`，样式快照仍为 `B648`，最终 renderer 仍引用 `index-D0HNo72G.js` 和 `index-CSeAvgSB.css`；验证 JSON 和构建产物保留。已通过的构建与交互检查未重复执行。
- 恢复时其它任务的 package.json / .github 变更已不在未提交列表，出现 `2026-11-04-github-actions-build-artifacts.md`；保留现场状态，不操作其它任务的提交、文件或后台服务。

## 本机覆盖安装

- 用户明确要求“覆盖ochang”，本轮授权覆盖 `/Applications/OC Chan.app`，不包含提交、推送或对外发布。
- 使用已经通过构建的产物运行 `node_modules/.bin/electron-builder --mac dir --publish never --config.electronDist=node_modules/electron/dist`，arm64 打包成功。仅通过 CLI 使用本机 Electron，不修改其它任务维护的 package.json。按当前配置未进行 Developer ID 签名。
- 正常退出旧应用并确认无运行进程后，使用 `/usr/bin/ditto` 覆盖安装。发布目录与已安装 `app.asar` 的 SHA-256 均为 `9d330039f87e36a9727f26dcbdd5bc176ecb226e75d5f294233ff9137099120b`。
- 安装前、安装后及最终正常启动后，个人 `settings.json` 的 SHA-256 均为 `b47284ace35af36e8517f6252e9f4d3d2767caf36a564e2cf0f4a48234e8a64c`，原有偏好未改变。
- 实际验收页面 URL 来自 `/Applications/OC Chan.app/Contents/Resources/app.asar/out/renderer/index.html`。默认 214、拖动最大 320／最小 188、方向键到 196 的断言通过；浏览器直接双击及等待最终值确认恢复 214。页面无根节点横向溢出，浏览器异常记录为空。证据：`installed-validation.json` 和 `installed-final.png`，位于原证据目录。
- 安装验收首轮因原生窗口隐藏而超时，激活后继续。原始 `ElementHandle.click({clickCount:2})` 的恢复断言失败，改用浏览器直接 dblclick 操作得到 214；未改产品代码或隐去失败。直接从终端启动时有继承 NODE_OPTIONS 的 Electron 警告，最终改用 LaunchServices 正常启动。
- 释放浏览器接管，正常退出验收进程（退出码 0），再通过 `osascript` activate 普通启动。最终主进程 PID 5182，命令仅为 `/Applications/OC Chan.app/Contents/MacOS/OC Chan`，不带调试参数；9368 无监听。

## 限制与后续动作

- 默认中文交流；用户希望直接完成修改。min/max 未指定具体数值，采用与现有 188/214px 设计一致的 188–320px。
- 不修改已有设置存储、采集逻辑、插件或用户配置；无关并行变更必须保留。
- 后续动作：按用户下一条要求调整范围；若要求跨重启记住宽度，再接入现有设置契约；若提出新的视觉或交互问题，基于已安装应用定向验证。当前功能与本机覆盖安装已完成。
- 提交或推送须遵从用户对应授权，仅纳入本任务改动块。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan`。左侧导航已支持 188–320px 拖动调宽，默认 214px，窄视口保留工作区 560px；分隔线具备 pointer capture、取消、键盘和紧凑导航焦点迁移。构建、独立窗口及用户授权后的已安装应用验证通过，新包已覆盖 `/Applications/OC Chan.app`，普通启动 PID 5182，设置文件保持不变。宽度仅保留在当前页面实例，重启回默认。未提交或推送。先读此交接及用户新要求，保留其它任务改动，不重复全仓测试。
