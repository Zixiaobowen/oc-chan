# OC Chan 桌面监控交接

后续 Agent 拓扑扩展与当前交付状态见 [Agent 拓扑画布交接](2026-11-02-agent-topology-canvas.md)。本文件保留基础监控阶段的历史验证，以下 PID 与服务记录不代表当前状态。

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`feat/local-desktop-monitor`，新建 Git 仓库；本次未 commit / push。
- 目标：本机 Agent / 子代理数量、定时任务清单和系统运行监控，以 desktop 形态交付。

## 已完成

从空目录实现 macOS Electron + React + TypeScript 应用。概览、Agent、定时任务、系统监控、来源五个页面；搜索、主/子代理筛选、任务类型与范围筛选、行详情、手动刷新、暂停显示。真实采集，不用演示数据，不执行或修改任务。

- Agent 3 秒：ps executable/已知CLI入口识别，排除 OMP 内部 worker 和 OMP/Codex/Claude/OpenCode 服务命令，wrapper 去重，PID 活性校验。lsof + 当前打开会话头部与专用 artifacts 目录关联驻留子代理；普通 fork 保留 main，独立子进程保留祖先与资源，同进程子代理不重复分摊。Tern inspect 为关联主代理提供 working/idle。
- 定时任务 30 秒：五个标准 launchd 目录、gui/user/system 域状态及禁用覆盖、当前用户 crontab、OMP/Hermes 元数据。周期/日历与常驻/启动分列。OMP按Label去重。
- 系统 2 秒：CPU增量、vm_stat和sysctl内存/交换、数据卷statfs、默认网卡吞吐、CPU最高进程。历史60点内存保存。
- 安全：sandbox/contextIsolation、无nodeIntegration、来源校验IPC、禁止导航/新窗口，仅有限只读桥接。
- 原生图标 `resources/icon.icns`；README、PRODUCT、DESIGN 和设计侧车已记录范围。
- 最终应用包已生成并在原生窗口打开：`release/mac-arm64/OC Chan.app`。当前进程 PID 97246，由持久服务 `oc-chan-delivery` 托管，无调试端口；CoreGraphics 确认有 1 个屏幕可见窗口。
- 独立 reviewer 最终 disposition 为 `ship`，只覆盖本轮可实现范围。精确活动子代理统计仍是未满足前提，不能称原始需求全部完成。

## 文件

- `src/shared/types.ts`：共享接口，`activeSubagentCount: number | null` 明确表达不可知。
- `src/main/index.ts`、`monitor.ts`：窗口、安全接口、单实例与采样调度。
- `src/main/collectors/{agents,schedules,system}.ts` 及对应测试。
- `src/renderer/src/`：React页面、组件、tokens与响应式样式。
- `scripts/smoke.ts`：真实本机只读验收。
- `.impeccable/review/`：真实Electron页面截图，已gitignore。`bundle-desktop.png`、`bundle-agents-detail.png`、`bundle-schedules-detail.png`、`bundle-narrow-detail.png`；最后资源显示修正对应 `bundle-final-subagents.png`。此前desktop/system/sources截图仍适用于未变更页面。

## 已运行验证

- `npm run build`：最终类型检查与main/preload/renderer构建通过。
- `node --import tsx --test src/main/collectors/agents.test.ts src/main/collectors/schedules.test.ts`：最终33项通过（16 Agent、17 schedule）。此后仅改AgentTable资源字段显示，采集器代码未变，未重复运行。
- `node --import tsx --test src/main/collectors/schedules.test.ts src/main/collectors/system.test.ts`：早期13项通过，其中system 2项仍适用于最终代码；schedule后续变更已由上述定向命令覆盖，未运行全仓测试。
- `npm run smoke`：通过。修复后一次采样为18主Agent、3驻留子代理、活动子代理null、34周期/日历任务（含停用项）、M4 Max 16核/128GB。原生bundle后续截图中驻留数降为2；计数是时点快照。
- 真实Electron窗口通过CDP操作：搜索无结果、按OMP过滤、Agent详情、用户任务筛选、Hugging Face任务详情、暂停后趋势保持及恢复、来源页面、键盘焦点。
- 1280×860与880×640：无水平页面溢出，侧栏底部恰在视口底部，长列表在main内部滚动且来源页底部可达。renderer errors为空。
- `impeccable detect --json src/renderer/src`：返回 `[]`。
- `node_modules/.bin/electron-builder --mac dir --publish never`：最终打包成功，复用本地Electron 45.2.1；未签名、公证、安装或发布。
- 实际bundle通过CDP验收，URL位于 `OC Chan.app/Contents/Resources/app.asar/out/renderer/index.html`。Agent/任务详情自动滚入视口并获得焦点，关闭返回原行；880×640无水平溢出。最后资源列改动后的真实子代理筛选截图与 `rendererErrors=[]` 已核对。
- 临时SSR smoke：Agent/调度首次loading及首次failure四种状态均没有错误的零计数；独立子代理12.5%/256.0MB、同PID未提供字段—/—、真实零值0.0%/0B均通过。没有新增永久实现镜像测试或留下临时脚本。
- 独立tsx进程内对collector导出做故障注入，真实Monitor经历真实采集成功→配置完整性错误→真实采集恢复；确认失败保留原data对象与collectedAt，恢复清除错误并更新快照。
- DesktopReview已完成最终受限复核，六个有证据的问题关闭，未发现残余必须修复项；reviewer未运行检查，测试和运行回执由主代理完成。
- 所有本次调试实例及CDP句柄已关闭。最终无调试端口应用通过AppKit/CoreGraphics核对bundle绝对路径、PID97246及1个可见窗口。启动时移除工具环境的NODE_OPTIONS，避免Electron packaged-app继承不支持的Node参数。

## 已知限制与风险

**用户要求的精确“正在执行的子代理总数”尚缺上游可读接口。** OMP18.15.0 AgentRegistry是进程内Map；完成但keepAlive的child仍保留lease直到park/dispose。lsof ownership只证明驻留；Tern只提供主pane working，不提供子代理roster。故子代理状态unknown、活动数量null/UI `—`。不可改称已全部完成，也不可用3个驻留充当活动3个。未注入OMP进程、未改全局配置、未启用Collab。

其他范围：OMP自定义session目录/profile、其他用户crontab、容器与任意第三方内部scheduler未覆盖。模型来自头部初始模型，可能已切换。macOS usbctelemetryd plist有未公开Second=0，保留任务和原值并提示语义未确认。未配置Developer ID签名/Apple公证。

修复过的真实问题：launchctl第二列 `(jt)` 不是退出码；空Google配置和jetsam数据plist不是服务；OMP内部worker、各CLI服务命令不计为Agent；普通fork不能因parentSession误判为子代理，独立子进程资源不能被renderer的main条件隐藏；调度配置读取/解析失败不能发布缩水快照；首次未知计数不能报0；长列表详情需滚动和焦点回归；workspace缺min-height:0会让侧栏和长列表越过窗口。

## 用户限制

中文沟通，desktop形态；真实本机只读查询。保留无关用户数据。不动技能、聊天、日志、worktree或全局模型配置。不执行定时任务，不外发消息，不部署/发布。未获Git提交推送或安装到Applications授权，因此未执行。浏览器仅接管本次Electron；没有启动Chrome测试窗口或外部浏览器。

## 下一步

1. 继续界面或采集修改时先收集实际问题；重新打包前停止本任务的 `oc-chan-delivery` 实例，保留其他会话和服务。
2. 若继续精确子代理活动统计，先取得OMP正式可读取的registry/生命周期接口；不能从lease、历史文件或CPU猜测活动。
3. 接入生命周期接口后，验证创建、执行、完成、取消、park与进程退出的真实状态转换，再解除活动数量未知的限制。
4. 分发、Developer ID签名、公证或安装到Applications仅在有对应任务时处理；当前仅交付本地未签名应用，不commit/push/deploy。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan`，先读本交接与README。应用已完成打包、独立复核和真实bundle验收，最终应用窗口由持久服务 `oc-chan-delivery` 保持打开，无调试端口。不要重做架构或重复已通过的检查。精确OMP活动子代理总数仍缺正式可读生命周期接口，驻留数不能当作活动数。确认当前服务/工作区后继续具体新任务；保留用户修改，未明确授权不commit/push/deploy。验证证据和完整交付边界见上文。
