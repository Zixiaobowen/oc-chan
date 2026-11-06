# 3D 工程办公楼交接 · 2026-11-06

## 仓库、分支与目标

- 工作树：`/Users/zvf003/tmp/oc-chan-topology-3d-20261106`。
- 分支：`feat/topology-3d-20261106`，从当时本地 `master` 的 `33068beb782384dda1cd675c3fcfa4f57e6e1746` 派生。
- 开始时主工作树有其它任务的未提交改动，因此先使用独立工作树；后续主工作树成为干净的main，已快进合入本功能，没有覆盖其它任务改动。
- 用户要求：从 master 切工作树，调研实施协作拓扑 3D；随后明确为办公室楼，每层一个工程、每个 Agent 一个员工，选中层使其他楼层淡化。最新要求是“楼像楼、人像人”，参考《城市：天际线》的微缩造型。
功能、评审修复、main整合、GitHub推送和本机安装均已完成；最终产品源码为d764bb1，验收入口修复为50af919，云端run42196761927全部通过。两者差异仅验收脚本；已安装应用与最终产品源码一致。较早阶段“未提交／未安装”及失败记录仅描述当时状态，以末尾回执为准。

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
- 已安装应用通过真实渲染器、IPC、采集和历史读取就绪验收；没有对正式应用进行3D原生窗口交互、连续缩放录屏、显示器刷新率／掉帧、Dock／托盘或macOS原生全屏验收。3D交互证据来自真实无头Electron。
- 未做最终版本的启动时延前后对比或过夜资源验证；不宣称已全面证明无 OOM 或 SOTA 动效。
- 楼层很多时全景会缩小，楼层选择与聚焦用于定位。文字标签数量受限，全部员工仍可经菜单访问。
安装使用现有pre-push hook，从实际待推送提交导出独立源码并构建／ad-hoc签名／安装；未使用旧本地包。未创建正式Release、公证或删除分支／工作树。

## 证据与清理

- 验收数据：`/Users/zvf003/tmp/oc-chan-office-20261106-evidence.json`。
- 选中楼层截图：`/Users/zvf003/tmp/oc-chan-office-selected-20261106.png`，画面明确标注合成验收数据。
- 上一阶段本地包：`release/mac-arm64/OC Chan.app`，不包含本轮新模型；本轮最新生产构建在 `out/`。
- 通过 launcher PID 3979 的 SIGTERM 退出本任务实例，143 是主动退出结果。PID 3979/3986/4011/4183/4184/4194 均无残留，`.dev-instances` 已为空。浏览器接管已释放，未操作其他开发实例。
- 最新模型数据：`/Users/zvf003/tmp/oc-chan-office-models-20261106-evidence.json`，包含原始资源采样与模型边界。
- 最新截图：`/Users/zvf003/tmp/oc-chan-office-building-20261106.png`、`/Users/zvf003/tmp/oc-chan-office-cutaway-20261106.png`、`/Users/zvf003/tmp/oc-chan-office-employee-20261106.png`，均明确标注合成验收数据。
- 本轮通过 `npm run dev` 启动 `office-models-dev` 无头实例；已释放浏览器接管并向 launcher PID 29676 发送 SIGTERM，监督进程报告 143，为主动退出。29676/29677/29679/29682/29683/29684 均无残留，工作树 `.dev-instances` 已为空。未停止其他任务实例。

## 本轮主分支整合与评审

- 保留 main 的采集插件、Codex、导航、开发启动器和安装流程；3D 接入 App 的 `memory.office` 与 `topologyView`，页面往返和2D/3D切换保留镜头、工位与选层。2D继续采用主分支每页200节点的规则，3D按自身明确预算显示完整筛选图。
- 评审确认并实际复现三个问题：交替筛选A/B后工位同占 `(0,40,0)`、点击穿透不透明屋顶、正视角头部射线无法与水平拖动平面相交。已分别通过全部有效缓存参与占位、比较不透明楼体命中距离、近平视使用垂直拖动平面修复。真实鼠标横拖并跨过视线水平线后，员工 x=30.867、y=280仍在原层、z=0，镜头控制恢复，WebGL error=0。
- 新增真实Electron `--scenario topology`；首次发现关闭详情后标签隐藏导致焦点丢失，改为绘制及标签布局完成后归还焦点，隐藏已聚焦标签前转交画布。最终 `/Users/zvf003/tmp/oc-chan-office-integrated-smoke-1106c/result.json` PASS：概览定位、详情焦点、页面往返、模式切换、员工选择、空筛选恢复、主题保存及新进程重启；两个实例进程／配置均已清理。员工原生菜单的无头键盘驱动不可靠，测试用标准select change事件选值，其它点击／输入／Esc使用CDP；不冒充原生下拉菜单验收。
- `npm run typecheck` 与48项定向测试通过：agent-topology、agent-topology-3d-layout、view-state、navigation及ci-tests。未运行全仓测试。CI映射已纳入3D源码与布局测试。
- 修复前后同一Electron进程、同一1200员工／2400关系／200层、各200次更新与选层：同步draw+GL finish中位数均1.8ms、P95均2.6ms；首次场景更新及绘制40.8→32.0ms；整个Electron进程树峰值RSS 856.80→866.05MiB，平均CPU 33.25%→29.29%。每段约4.7秒、15/16次采样；两者均1200缓存／48标签／11几何，释放后几何0，WebGL error=0。此短时、固定顺序、未强制GC的比较不证明长期内存恒定、启动性能改善或屏幕帧率；证据 `/Users/zvf003/tmp/oc-chan-office-integration-evidence-1106.json`。
- Three.js及类型锁为0.187.0，8个新增锁节点全是dev，原锁节点未变化；政策更新至实际锁SHA。`npm run audit:dependencies` 已verified，6个既有受影响包按现有已审公告策略分类，未新增豁免。证据 `/Users/zvf003/tmp/oc-chan-office-dependency-review-1106.json`。
- 为保持冻结3MiB ASAR预算，生产renderer启用Vite压缩。`npm run build:app`通过；scene chunk从1,367.35kB降至600.82kB，入口从1,478.09kB降至733.11kB。Vite保留>500kB的提示；场景已独立按需加载，不提高告警阈值或放宽包体预算。最终包体以安装门禁实测为准。
- 真实采集页面当前18位员工，一个canvas、无3D错误、1280×860内容区无横向溢出；截图 `/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15c34e0b5e0665bd.webp`。

## 首次安装回执与云端增量修复

- 2026-11-06首次main推送4e305698722a13ee92b57c1fb40e6e01017676cd成功，`git ls-remote`回读一致。hook从该SHA的git archive构建、验证来源／内容／arm64／签名／磁盘／权限后替换 `/Applications/OC Chan.app`，保留个人数据；应用版本0.1.0、PID75989、status=ready，renderer及IPC为true，agents/schedules/system/events全部ready，Hermes历史25条。
- 首次已安装ASAR为1,892,972字节，低于冻结3MiB上限；实际依赖清单包含three@0.187.0，无其开发类型／物理引擎等传递开发包。
- 原开发实例已向launcher58668发送SIGTERM，退出码143为主动退出。PID58647/58668/58674/58675/58676/58678/58681均已消失，`.dev-instances`为空，浏览器接管已释放；正式应用PID75989仍运行。
- GitHub run42189577406的受影响行为测试通过，但完整renderer smoke在U-07二维焦点检查失败；构建产物步骤未运行，不能称云端成功。根因：存在旧视口时初次挂载的显式选中被视为恢复状态，未定位到目标；详情关闭后节点仍在屏外。
- 修复：将显式revealId/onRevealed导航契约同时接入二维、三维；二维保存待定位目标，待尺寸／布局完成后适应目标，不让旧视口覆盖主动定位。普通页面返回没有显式请求，仍保留视口。原U-07场景移动到topology定向smoke，完整流程复用同一场景，不复制断言。
- 修复后 `npm run typecheck` 和 `/Users/zvf003/tmp/oc-chan-office-integrated-smoke-1106d/result.json` PASS，覆盖2D详情关闭、等待两帧焦点保持和Enter再次打开。由于完整流程曾失败，继续运行完整renderer smoke核对顺序影响；未扩跑无关单元测试。
- 完整smoke `/Users/zvf003/tmp/oc-chan-office-complete-smoke-1106e/result.json` 在整组交互180秒上限中断；此前3D、二维焦点、事件、通知保存与中文版响应式场景均通过。英文版响应式刚开始5.4秒即因外层关闭协议而中断，没有证明该输入框自身失效；两个受测实例中本轮只启动首个，进程/profile和夹具均已清理。
- 预算依据：旧main的 `/tmp/oc-chan-main-merge-smoke-20261106/result.json` 已耗时176.658秒，本轮新增3D交互约17.4秒。将整组交互上限改为300秒，总上限仍420秒；单步超时、资源和证据预算不变。`/Users/zvf003/tmp/oc-chan-office-complete-smoke-1106f/result.json` 完整通过：交互197.292秒、总205.567秒、8个外层阶段、36张截图，errors=[]；包含通知中英文／200%文字、设置实际保存与独立重启。两个实例的进程和profile、合成工作目录均已清理。未再运行已通过且未失效的单元测试。

## 修复版本交付回执

- 产品修复提交 `d764bb1ecb2661ef22284c250ee6c50fbbcb1804` 已从功能分支快进合入main并推送；GitHub远端main的SHA回读一致。实际GitHub身份已用gh核对，提交身份仍为bowen.sun <bowen.sun@zstack.io>。
- pre-push从该提交独立git archive构建，类型检查、Vite、arm64目录包、原生模块与ad-hoc签名、来源及内容预检通过。已替换 `/Applications/OC Chan.app`，个人数据保留；新应用0.1.0、PID98455、status=ready，renderer=true、ipc=true，agents/schedules/system/events全部ready，Hermes历史25条。ASAR实测1,893,120字节，低于3MiB冻结上限。
- GitHub run42192558656受影响测试、3D和2D导航场景通过，后续事件页在 `real wheel scroll moves event workspace` 失败。完整截图和诊断已下载到 `/Users/zvf003/tmp/oc-chan-office-ci-42192558656/oc-chan-renderer-smoke-26`；该次DMG/ZIP构建尚未执行。
- 原事件smoke点击带datalist的来源输入框后直接在另一坐标发送wheel，未关闭候选、移入滚动区域或等待命中区域提交。云端截图确认有50条已加载记录且停在页顶；本机旧序列成功，未声称已复现或证实云端底层丢弃原因。验收序列现补上Escape、命中区域检查、mouseMoved和两帧等待，仍要求真实wheel滚动增加、输入焦点不变、后台更新保持可见行及其位置；不通过直接设置scrollTop代替滚轮。
- 独立真实Electron诊断 `/Users/zvf003/tmp/oc-chan-wheel-q2umCd/wheel-evidence.json`：5000条合成事件，修正输入顺序5次均滚动240px、焦点保持event-source-filter、收到trusted wheel且defaultPrevented=false。诊断实例正常退出0，进程和profile已消失，全局资源／计时器归零，合成fixture已清理。产品源码未变化；本机安装仍为d764bb1，不因验收脚本修改重复替换应用。
- 修正输入顺序后的完整smoke `/Users/zvf003/tmp/oc-chan-office-complete-smoke-1106g/result.json` 通过：总214.287秒、36截图、errors=[]；首轮和重启实例的进程/profile以及合成工作目录均已清理。滚动240px后追加真实fixture执行事件，同一smoke-f05-04949行的top保持103.796875px，焦点保持event-source-filter；浏览器滚动锚定使scrollTop从240变269.5，阅读位置保持不动。
- 验收脚本提交9d6cf53已快进合入main并推送；只对此次命令关闭会重新安装应用的pre-push hook，没有修改持久hooks配置。其云端run42194682785仍在同一滚轮断言失败，排除了只补输入顺序即可修复的假设。
- 功能分支诊断提交3593069、run42195507949取得直接证据：CSS坐标(1240,457.5)对应trusted wheel、deltaY=240、defaultPrevented=false，页面可滚动11800px且document.hidden=false，但scrollTop仍0；同坐标的浏览器原生滚动手势返回 `Position out of bounds`。问题落在CSS模拟尺寸与实际输入区域不一致，不能归因为产品吞掉滚轮事件。诊断只用于取证，后续已全部移除。
- 修复提交50af919：smoke在CSS模拟前显式设置唯一无头、不可聚焦Electron窗口的内容尺寸1280×860并回读确认；启动证据记录原生before/after尺寸。窗口仍隐藏，尺寸范围受限，不修改正式应用窗口规则。本地 `/Users/zvf003/tmp/oc-chan-office-viewport-smoke-1106h/result.json` 通过启动、拓扑与独立重启，两轮原生尺寸均为1280×860，进程/profile/夹具已清理；三个受改脚本的node --check通过。
- 50af919的两次workflow_dispatch分别返回HTTP500、502；首次只读确认未建立新运行。随后通过main正常推送触发云端复验，产品源码和本机安装继续保持d764bb1对应内容。
- 最终GitHub [run42196761927](https://github.com/zixiaobowen/oc-chan/actions/runs/42196761927) 在50af91985e3af479938656da9be25a545f603c41通过，macOS arm64 job耗时3分26秒：受影响行为测试、完整renderer smoke、DMG/ZIP构建、依赖许可证与公告、包体内容及冻结预算、SHA256生成／验证、产物上传全部success。
- 云端产物已由GitHub API回读：`oc-chan-renderer-smoke-29`（id13493740255，4,655,830字节）与 `oc-chan-macos-arm64-29`（id13492691429，236,421,340字节），均未过期。这里只核对云端构建及上传结果，没有把该云端包再次安装到本机，也没有创建Release或公证。
- 下载的成功云端证据 `/Users/zvf003/tmp/oc-chan-office-ci-42196761927/oc-chan-renderer-smoke-29` 确认原生内容区原为1024×674，首轮和重启均调整至1280×860；这与此前CSS内坐标超出真实输入范围的诊断吻合。完整结果complete=true、errors=[]、36截图，两个实例及工作目录清理成功。真实wheel滚动240px，后台新记录后焦点不变、同一行top只变化0.5px，满足原有≤1px阅读位置断言。


## 下一步与恢复

1. 后续反馈以已安装产品d764bb1和云端通过的50af919为基线，只针对新增差异验证，不重跑已有适用证据。
2. 如用户另行要求可见窗口验收，使用获准的dev:window检查原生缩放／全屏／快速交互／减少动态效果并录屏；当前仍只声明真实无头Electron交互和已安装就绪。
3. 如继续长期资源验收，沿现有性能入口另行安排代表性长时负载；当前短时压力不能证明过夜稳定或所有硬件无OOM。
4. 保留功能分支、独立工作树与全部原始证据。最终仅文档回执提交使用单次跳过安装hook与 `[skip ci]`，不重复安装或构建同一产品源码，不改持久配置。

恢复提示：本任务已完成。3D办公楼（每工程一层、每Agent一员工、选层淡化、可辨识楼体／人物）及二维导航修复已合入main、推送并安装。产品源码d764bb1；验收脚本50af919；GitHub run42196761927全部通过且DMG/ZIP已上传。前述失败已保留并关闭，临时诊断已移除，诊断／smoke实例和fixture已清理。可见原生窗口、物理帧率与长期内存未验范围如上，不重复安装或开启可见窗口。
