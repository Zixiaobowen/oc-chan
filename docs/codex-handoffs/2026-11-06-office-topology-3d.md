# 3D 工程办公楼交接 · 2026-11-06

## 仓库、分支与目标

- 工作树：`/Users/zvf003/tmp/oc-chan-topology-3d-20261106`。
- 分支：`feat/topology-3d-20261106`，从当时本地 `master` 的 `33068beb782384dda1cd675c3fcfa4f57e6e1746` 派生。
- 原工作树 `/Users/zvf003/ZStack/oc-chan` 有其他任务的大量未提交改动，本任务未修改它。
- 用户要求：从 master 切工作树，调研实施协作拓扑 3D；随后明确为办公室楼，每层一个工程、每个 Agent 一个员工，选中层使其他楼层淡化。最新要求是“楼像楼、人像人”，参考《城市：天际线》的微缩造型。
- 最新模型实现、定向测试、真实无头 Electron 验收与生产构建已完成。上一阶段本地 `.app` 包早于本次模型改动，本次未重新打包。未提交、推送、合并、安装或发布。

## 最终实现

- `AgentsView.tsx` 默认 3D，保留用户可主动选择的 2D。两种视图共用现有 `TopologyGraph` 和真实 `parentId`、搜索、角色／活跃状态筛选、折叠及详情。
- `agent-topology-3d-layout.ts` 用完整原始 cwd 分楼层，不猜项目根、不合并同名不同路径；无 cwd／空白 cwd 归末尾 unknown 层。楼层与工位排序稳定，边和环不改变工程归属。
- `agent-topology-scene.ts` 使用 Three.js 0.187.0、OrbitControls，实例化完整员工、桌椅、状态环、楼板、结构框架和窗格立面；入口与屋顶各一个实例。`agent-office-employee.ts` 与 `agent-office-building.ts` 构造共享顶点色几何，无新增依赖、外部模型或纹理。无常驻力学模拟、阻尼或持续动画。身份与状态来自现有采集；失效快照不显示当前活跃证据。
- 楼层菜单、标牌和楼板均可选层。其他楼层、员工、内部连线淡化；选中层的外立面和屋顶同时淡化，形成可观察内部的剖面；接触选中层的跨层连线保持清晰。选层不移动镜头，聚焦是独立操作；显示全部恢复清晰度。
- 员工菜单可访问所有当前节点；屏幕标签避让并限量，全景小尺寸员工收起文字，悬停、选中或放大后显示；楼层标牌移到建筑左侧。支持员工详情、键盘平移／旋转／缩放、OMP 原有上下文菜单入口。未执行会抢用户焦点的真实 Tern 跳转。
- 员工拖动限制在所属楼层。采样、筛选和 2D/3D 切换保留页面实例的镜头、选层和工位；归属变化时进入新楼层。过滤后选中层不见时保留选择并显示说明。
- 超限在分配前明确拒绝：1200 员工、2400 关系、4000000 渲染像素；位置和归属缓存最多 1200 项；32 员工标签 + 16 楼层标签。不会静默截断或自动切到 2D。
- 卸载释放几何、材质、实例数据、WebGL、DOM、观察器和监听器；图形上下文丢失有明确重试入口。
- 200% 文字放大的说明覆盖页脚问题已在本轮修复：视图区和外容器随内容增高，控件可换行。

## 修改范围

新增：

- `src/renderer/src/AgentTopology3D.tsx`
- `src/renderer/src/agent-topology-scene.ts`
- `src/renderer/src/agent-topology-3d-layout.ts`
- `src/renderer/src/agent-office-employee.ts`
- `src/renderer/src/agent-office-building.ts`
- `src/renderer/src/agent-topology-3d-layout.test.ts`
- `src/renderer/src/agent-topology-3d.css`
- `scripts/develop.mjs`

修改：`src/renderer/src/AgentsView.tsx`、`src/main/index.ts`、`electron.vite.config.ts`、`.gitignore`、`package.json`、`package-lock.json`、`README.md`、`PRODUCT.md`、`DESIGN.md`、`AGENTS.md`。

开发启动器与主进程的无头入口为满足当前仓库验收约定引入，使用独立实例数据／构建目录与端口。集成回正在并行开发的主工作树时，需按其最新版本处理这些文件，不能覆盖其他任务已有实现。临时 `topology-smoke.tsx`、`topology-smoke-entry.ts` 已移除。

## 上一阶段验证（基础办公楼）

- `npm run typecheck`：通过。
- `node --import tsx --test src/renderer/src/agent-topology.test.ts src/renderer/src/agent-topology-3d-layout.test.ts`：22/22 通过。
- 后续将布局测试中固定文案／坐标拷贝断言改成归属、非重叠、边界和预算行为断言，重新运行 `agent-topology-3d-layout.test.ts`：9/9 通过。未扩大到全库测试。
- `npm run build`：类型检查、Swift 导航程序、Electron 主进程／preload／renderer 全部通过。
- `npm ls three @types/three --all`：两者均为 0.187.0，放在 devDependencies，仅构建后的代码进入发布包。
- `electron-builder --mac dir --publish never`：arm64 本地 `.app` 打包通过，跳过签名（项目配置 identity=null）。未安装、启动该打包应用或发布。
- 实际查看 `release/mac-arm64/OC Chan.app/Contents/Resources/app.asar`：包含独立 scene chunk；顶层仅 node_modules/out/package.json，node_modules 未包含 Three.js 开发源包。新增 scene chunk 1,340.88 kB，gzip 270,370 bytes；app.asar 约 36 MB。没有用此值宣称整个安装包的精确增量。

无可见窗口的真实 Electron 验收，实际采集和合成数据分开：

- 真实 IPC 页面显示 17 个 Agent，工程菜单共 7 个选项（含全部）。
- 合成 3 层、36 员工：选层后 12 清晰／24 淡化，涉及该层的 12 条关系清晰／其他 22 条淡化；相机不变。完整 cwd 分层、unknown 层、跨层关系、楼层菜单／标牌／楼板、员工定位和详情均运行过。
- 员工实际鼠标拖动改变 x/z、y 保持对应层；刷新后位置和镜头保留，2D/3D 切换后工位仍保留。
- 过滤掉 unknown 层后选择仍为 unknown，出现明确提示；清除筛选／恢复全部可继续操作。
- 强制 WebGL context loss，显示错误，重试后恢复一个有效 canvas。自动化旧场景引用曾导致提前读数；最终实际 context 已恢复。
- 空数据出现“当前未发现运行中的 Agent”；合成采集失败显示“更新失败”，保留 24 员工，scene.evidenceCurrent=false。
- 深色／英文通过隔离实例真实 settings IPC 切换并恢复。减少动态效果模拟启用；静止场景新增帧数 0；场景隐藏后新增帧数 0，恢复后可绘制。
- CSS 内容区域：880×640、960×900、1119×800、1121×800、1280×860、1728×1117；未出现窗口横向溢出。880×640 下 200% 字号检查通过，说明不再覆盖页脚，操作可滚动到达。

## 上一阶段资源与性能证据

环境：同一台 Apple Silicon 工作站、macOS 27.2、Electron 45.2.1 开发实例，1280×860 CSS 内容区域。RSS 为 Electron 主进程及所有后代的瞬时合计，CPU 为 `ps` 各进程百分比之和（可超过 100%）。采样约每 400ms 一次；生产环境表现不能由此直接推导。

| 场景 | 持续时间 | 进程树峰值 RSS | 平均 CPU | 同步提交／绘制中位数 | P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2D，120 员工，30 次刷新 | 3.419s | 682.59 MiB | 20.04% | 9.1ms | 10.1ms |
| 3D，120 员工，30 次刷新 | 3.004s | 672.75 MiB | 9.99% | 4.9ms | 5.5ms |
| 3D，1200 员工／2400 边，150 次更新与选层 | 18.903s | 663.48 MiB | 8.10% | 2.8ms | 3.7ms |
| 120 员工，30 次 2D/3D 卸载重建 | 6.037s | 708.55 MiB | 88.85% | 未测 | 未测 |

这些计时为同步 React 提交／DOM 几何访问及 3D 显式 draw，不含屏幕呈现；2D/3D 绘制机制不同，不宣称稳定帧率或普遍性能提升。无头 CDP 内 requestAnimationFrame 计时出现停滞，已通过工具问题入口报告，因此未使用该结果。

- 1200 员工／2400 边场景没有 OOM，8 个已用几何、8 次 draw、48 个预分配标签、1200 缓存项。
- 1200 个不同 cwd（1200 层）运行过，标签和缓存仍受上限限制。
- 第 2401 条边明确抛出 RangeError；1201 员工显示数量／上限并卸载 canvas，恢复预算内数据可重新加载。
- 30 次切换均观察到旧场景 disposed、旧 renderer 几何计数归零、标签移除；最终单个场景、48 标签、120 个缓存项。
- 短时压力验证不能代替过夜运行、显存精确测量或整个应用在所有并发负载下的预算证明。

## 最新模型改造与验收

- 造型：连续柱梁、双窗格立面、双门入口、雨棚、台阶、花池、屋顶女儿墙、电梯机房与空调设备；员工具有头面、短发、肩袖、双臂双手、分开的裤腿与鞋。工位包含桌椅、显示器、键盘和鼠标。自然材质颜色保持稳定，状态通过脚下圆环及标签表达。
- 实测单人 868 三角形、工位 444 三角形；人物局部范围 x=-24.2..25.2、y=-40..65、z=-13..9.28，工位 y 最低 -40，与楼板锚点一致。当前尺寸的框架 132、立面 372、屋顶 324、入口 268 三角形；窗格每方向最多 16 组。尺寸变化时释放旧几何并替换共享几何。
- `npm run build` 通过，包括 `tsc --noEmit`、原生导航程序及 Electron 主进程／preload／renderer。scene chunk 为 1,366.57 kB。没有新增依赖；本次未运行全库测试、重新打包、安装或发布。
- `node --import tsx --test src/renderer/src/agent-topology-3d-layout.test.ts`：9/9 通过。
- 真实无头 Electron、1280×860 CSS 内容区：合成 3 层／18 员工，选层为 6 清晰／12 淡化、镜头不动，立面 opacity=0.08、屋顶=0.05；恢复全楼、聚焦楼层、定位员工、真实鼠标点击人物和详情通过。拖动改变 x/z 且 y 保持 280（所在楼层 y=240）；刷新保留位置与镜头。近景距离 340，人物面部、四肢和桌椅已实际截图检查。
- 真实设置 IPC 切换深色并恢复；880×640 内容区无窗口横向溢出。200% 字号使用临时 CSS 放大，实测 `--font-scale:2`、楼层文字 24px，控件在宽度内且可滚动到达；临时样式已移除。真实采集页面显示 19 个 Agent／6 层并使用新人物模型；移除夹具后重新加载，单个 canvas，无 alert。
- 120 员工、30 次相同同步更新／显式绘制：旧模型中位数 0.5 ms、P95 1.2 ms；新模型中位数 0.4 ms、P95 1.1 ms。三角形 40,720 → 196,860，draw 8 → 13，已用几何 8 → 11。计时不包含屏幕呈现，堆读数未控制 GC；不据此宣称帧率或内存改善。
- 1,200 人／2,400 关系／200 层，连续 200 次更新与选层，持续 21.359s，约每 400ms 采样整个 Electron 进程树，共 48 次：峰值 RSS 600.875 MiB、平均 CPU 8.6125%，同步更新加 draw/GL finish 中位数 2.9 ms、P95 3.6 ms；无 OOM，WebGL error=0。几何缓冲合计 194,104 bytes（不含实例矩阵、WebGL 驱动或其他应用内存），位置缓存 1,200、标签 48。
- 单层 1,200 人与 1,200 个楼层分别运行，后者 2,714,460 三角形；已用几何仍为 11，位置缓存与标签仍受上限限制，WebGL error=0。
- 20 次实际绘制后切换 2D/3D：每轮绘制时几何为 11，卸载后为 0；旧场景 disposed、旧 canvas 移除。最终一个 canvas／48 标签。每四轮记录的 RSS 为 657.2、698.2、724.4、724.0、733.8 MiB；这验证了显式 GPU 资源释放，不能据此证明无限次切换或长期运行内存恒定。
- 本轮未取得严格配对的 CPU／启动耗时前后对照，未验收可见原生窗口、真实屏幕帧率或长期运行。上述短时压力结果不替代这些验收。
- 验收夹具曾因热重载重复挂载，已修正并在单实例下重做交互；raw Puppeteer `page.evaluate` 与 `tab.evaluate` 的执行世界不一致已报告工具问题，释放检查改用同一 API。此处均为验收工具问题。临时 `office-model-smoke.tsx` 已删除。


## 已知限制与未验证项

- 按完整 cwd 区分工程，仓库子目录和尾斜线不同的字符串也可能成为不同楼层；没有推断项目根或新增归属采集。
- 没有可见原生窗口交互验收、连续原生窗口拖动录屏、真实显示器刷新率／掉帧记录，也未验收 Dock／托盘／macOS 原生全屏和正式安装应用。遵守用户环境的默认无头验收约定，不自行打开窗口抢焦点。
- 未做最终版本的启动时延前后对比或过夜资源验证；不宣称已全面证明无 OOM 或 SOTA 动效。
- 楼层很多时全景会缩小，楼层选择与聚焦用于定位。文字标签数量受限，全部员工仍可经菜单访问。
- 本地打包未签名、公证、安装或发布；本任务没有 commit／push 授权。

## 证据与清理

- 验收数据：`/Users/zvf003/tmp/oc-chan-office-20261106-evidence.json`。
- 选中楼层截图：`/Users/zvf003/tmp/oc-chan-office-selected-20261106.png`，画面明确标注合成验收数据。
- 上一阶段本地包：`release/mac-arm64/OC Chan.app`，不包含本轮新模型；本轮最新生产构建在 `out/`。
- 通过 launcher PID 3979 的 SIGTERM 退出本任务实例，143 是主动退出结果。PID 3979/3986/4011/4183/4184/4194 均无残留，`.dev-instances` 已为空。浏览器接管已释放，未操作其他开发实例。
- 最新模型数据：`/Users/zvf003/tmp/oc-chan-office-models-20261106-evidence.json`，包含原始资源采样与模型边界。
- 最新截图：`/Users/zvf003/tmp/oc-chan-office-building-20261106.png`、`/Users/zvf003/tmp/oc-chan-office-cutaway-20261106.png`、`/Users/zvf003/tmp/oc-chan-office-employee-20261106.png`，均明确标注合成验收数据。
- 本轮通过 `npm run dev` 启动 `office-models-dev` 无头实例；已释放浏览器接管并向 launcher PID 29676 发送 SIGTERM，监督进程报告 143，为主动退出。29676/29677/29679/29682/29683/29684 均无残留，工作树 `.dev-instances` 已为空。未停止其他任务实例。

## 下一步（另获对应授权时）

1. 从此工作树继续；先读本交接，不在原脏工作树覆盖或重放整个目录。
2. 用户要求原生窗口验收时运行 `npm run dev:window`，补充真实窗口缩放／聚焦／全屏及可见操作录屏。
3. 用户授权提交后，只暂存本任务文件并本地提交；推送、合并、安装和发布需要各自授权。
4. 合并前核对当前 master 上开发启动器、主进程入口和样式的并行修改，按最终版本解决冲突；只重跑受冲突影响的检查。

恢复提示：

> 继续 `/Users/zvf003/tmp/oc-chan-topology-3d-20261106` 的 `feat/topology-3d-20261106`。先读 `docs/codex-handoffs/2026-11-06-office-topology-3d.md`。用户要求的 3D 工程办公楼、选层淡化及《城市：天际线》风格的可辨识楼体／人物已完成，最新模型已通过定向测试、真实无头 Electron 和生产构建；旧 `.app` 包早于本轮模型改动。尚未 commit/push/install。保持 cwd 证据边界、资源预算和用户原工作树不动。根据用户新指令继续，不重复已通过且仍适用的验证。
