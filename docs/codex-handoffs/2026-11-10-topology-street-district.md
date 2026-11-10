# 3D 协作拓扑街区

- Repo：`/Users/zvf003/ZStack/oc-chan-street-20261110`
- Branch：`feat/topology-street-main-20261110`，基线 `9d0521f85f6b1358be07eb1697160fb84bf92675`
- 目标：井字路网和地块，项目建筑沿街排列，保持项目／任务楼层／员工的真实关系与既有操作。
- 状态：实现和定向验收完成；用户随后明确授权提交到 GitHub main。推送结果须以远端回读为准，不包含发布、安装或工作树清理。

## 实现与文件

- `src/renderer/src/agent-topology-3d-layout.ts`：街道退距、螺旋地块、统一建筑包络定位。
- `src/renderer/src/agent-office-district.ts`：两个有界实例化网格绘制土地、道路、人行道、接触阴影、树冠与路灯；不引入依赖、模拟或常驻动画。
- `src/renderer/src/agent-topology-scene.ts`：会话内保留项目地块编号，隐藏但仍存活项目保留映射；入口按道路两侧朝向旋转，员工与办公室坐标不旋转。全景优先项目标牌，选中任务才显示楼层标牌，俯视镜头包含路网。地景沿用统一 GPU 释放。主动“重新布局”清除工位及地块缓存，当前可见项目紧凑重排。
- `src/renderer/src/agent-topology-3d-layout.test.ts`：新增地块稳定、1200地块唯一性、道路与建筑不交叠、扩大包络和实例容量检查；删除已不适用的整体居中断言。
- `AGENTS.md`、`DESIGN.md`、`docs/features.md` 同步街区约束与行为。

## 实际验证

- `npm run typecheck`：通过；最后增加显式地块 reset 后再次通过。
- `node --import tsx --test src/renderer/src/agent-topology-3d-layout.test.ts src/renderer/src/agent-topology.test.ts src/renderer/src/view-state.test.ts`：初次42/43，唯一失败为旧整体居中断言。删除该实现细节断言后，仅重跑布局文件，16/16通过；其余27项此前通过且未受后续修改影响。没有运行全仓测试。
- 主线基线真实 Tauri/WKWebView topology smoke：通过，`/tmp/oc-chan-street-native-baseline-20261110/result.json`。
- 改后真实 topology smoke：通过，`/tmp/oc-chan-street-native-after-20261110/result.json`。覆盖定位、任务分组、页面/2D/3D切换、筛选恢复、主题、重启；退出回执确认实例与夹具进程清理。该次发生在最后两行 reset 修改前。
- 最后 reset 修改经固定负载真实原生点击验收通过：`/tmp/oc-street-measure-final-20261110/result.json`，`complete:true`、errors为空、进程正常退出；退出时documents/requests和全部当前资源预留为0。
- Impeccable detector 对三个产品实现文件返回 `[]`；不把它视为3D美术质量证明。
- 独立只读代码评审未发现有证据的实质缺陷。同一评审独立读取最终2×2街区四张浅/深色、窄窗、200%截图，结论为截图覆盖范围内通过，无已证实阻断项或必须修正项；不扩展为画外控件或可见原生窗口验收。
- 提交阶段无冲突 rebase 到 `1a77778`（包含右键菜单修复及最新提交工作流）。针对受影响拓扑及原生驱动重新执行 `npm run smoke:renderer -- --scenario topology --out /tmp/oc-chan-street-main-integration-20261110`，通过，`complete:true`、errors为空。没有重复运行未受影响的单元测试。

## 固定负载及视觉证据

前后都是4项目、每项目8员工，真实会话文件通过生产采集解析，在界面搜索 `street-fixture` 后严格核对32个员工身份。5秒预热、15秒静置、10次员工定位。浅/深色1280×860、880×640及CSS 200%截图；截图输出像素与CSS视口分别记录，200%不是OS显示缩放或WK pageZoom。

- 基线：`/tmp/oc-street-measure-before-v3-20261110/result.json`
- 最终：`/tmp/oc-street-measure-final-20261110/result.json`
- 最终截图：同目录 `light-1280x860.png`、`light-880x640.png`、`light-200percent.png`、`dark-panorama-1280x860.png`。
- 浅色全景真实呈现“重新布局”后的2×2建筑街区；窄窗控件换行。200%文字可读，但截图不包含全部画外控件，不声称全部操作可达性验收完成。

| 短测指标 | 基线 | 最终街区 |
|---|---:|---:|
| Host + 关联WK进程采样RSS峰值 | 373.06 MiB | 379.14 MiB |
| 同范围单核CPU平均值 | 7.03% | 7.37% |
| 10次员工定位往返P95 | 28.25 ms | 28.25 ms |
| 15秒内成功返回的WebGL draw调用 | 105 | 136 |

地景每次绘制增加两个实例化调用；采样刷新次数随时间窗口边界变化，draw调用数不是GPU完成时间或屏幕FPS。关联进程每次15个资源样本，无已报告关联角色缺失，但可能共享；系统枚举、不完整CPU首区间、采样前及短生命周期进程仍有覆盖缺口。定位耗时包含driver/IPC开销。

原生smoke首次就绪阶段为4166ms→4236ms，重启就绪为3245ms→3825ms；单次且非专门启动基准。前后图形负载均为32员工，但后台真实额外Agent数量变化，临时脚本准备阶段的焦点处理和显式reset也不同。以上仅为本机短测事实，不据此宣称性能提升、全应用独占成本或长期无OOM。

## 验收工具问题与保留证据

主线已有 `OC_CHAN_PERFORMANCE=1` 构建探针在 App.tsx/TrayView.tsx 报 `Performance snapshot hook drift`。本任务未修改该框架，改用 smoke 入口、归属核验的进程采样器和有界 WebGL 方法计数器。失败证据保留 `/tmp/oc-street-measure-before-20261110`。

临时脚本先后修正导航选择器和输入焦点确认，失败证据分别在 `/tmp/oc-street-measure-before-v2-20261110`、`/tmp/oc-street-measure-after-20261110`。最终脚本在完成后保存为最终证据目录内 `acceptance-harness.mjs`，不进入产品源码。此前通过但呈现保留地块长街的结果在 `/tmp/oc-street-measure-after-v2-20261110`。

## 限制、授权与保护

- 项目稳定的是地块编号；统一建筑包络随工位占用增长时，道路间距及世界坐标会相应扩展。1200映射预算满时可见对象优先，隐藏项目可能回收。
- 未验收可见原生窗口、物理显示帧率、长时驻留和全应用极端内存压力；不宣称 SOTA 动效或性能提升。未完成200%画外全部控件可达性验收。
- `/Applications/OC Chan.app` 未替换。GitHub main 提交与推送已获本轮授权，安装和发布不在授权范围。
- 原始 `/Users/zvf003/ZStack/oc-chan` 含用户未提交改动，内容未动，分支已恢复 `refactor/plugin-system-monitor`。实际开发在独立worktree。
- 基线worktree `/Users/zvf003/ZStack/oc-chan-street-baseline-20261110` 保留。只清理工具自己创建并确认退出的开发实例，不删除worktree、分支、个人设置或他人日志。
- 所有本任务启动的旧Electron及新Tauri smoke均有实例/进程清理回执；最后固定负载验收也确认实例目录、driver目录及fixture进程结束。

## 下一步

1. 在本worktree查看最终截图及实现；若继续迭代视觉，保留真实项目/任务关系和资源预算。
2. 用户授权提交时只提交本次文件，不动旧worktree的发布改动。
3. 用户要求安装时从本worktree生成并验收安装材料；不要使用旧目录或旧已安装版本冒充本次结果。
4. 单独处理主线performance probe漂移或原生可见窗口验收时，保持其独立范围与证据。

## 恢复提示

继续 `/Users/zvf003/ZStack/oc-chan-street-20261110` 的3D街区工作，先读本handoff。用户已授权实现井字街道土地、沿街建筑和微缩视觉，已实现并通过类型、相关43项行为测试及真实Tauri/WKWebView定向验收。最终4项目32员工2×2截图与短测在 `/tmp/oc-street-measure-final-20261110`。用户随后授权提交到GitHub main，现场核对远端状态，不把本记录当作推送成功凭证。不要在旧 `/Users/zvf003/ZStack/oc-chan` 目录开发或覆盖其未提交改动；不自动发布、安装或清理工作树。
