# 隐式状态机审计交接

Repo：`/Users/zvf003/ZStack/oc-chan`

Branch：`refactor/plugin-system-monitor`

HEAD：`565093f60fc7add73c085ebc0cd5dc5ff4db59c3`

OMP session：`2026-11-09T07-27-48-558Z_01a1bf34-c34e-7600-bc23-71f44049c38e`。未创建子代理。

目标：对当前工作区隐式状态机做只读全范围审计，交付结构化清单；此交接供开发负责人另开OMP进行独立只读复核。不能把报告当改代码、合并、安装、部署或代发消息的许可。

## 已完成

- 文件边界枚举240项、21目录模块，纳入当前未提交/未跟踪源码；逐文件SHA与处置理由在coverage.json/csv。
- 98项状态/控制流或样式耦合已审；142项不适用（测试、开发验收harness、类型、纯投影/校验/装配等）；未审0。此分类不是逐行质量审查或无遗漏证明。
- 48个语义去重对象：41隐式、7混合；高13/中23/低12为建模与复核优先级，不是缺陷数。
- 增量批次7/22/19项，JSON与CSV均保留；inventory有所有者、读写者、状态、转换、初始化/终止/恢复、跨对象依赖、测试证据、风险与建议。
- 139处代码行摘录与源码SHA可程序核验。相关源码测试标题/断言已索引，未运行现有套件。
- 隔离探针验证ISM-004、ISM-020、ISM-029、ISM-002。没有生产bug复现，没有系统/网络副作用。

## 实际命令与结果

- `git status --short --branch && git rev-parse HEAD`：基线见baseline.json，工作区原本不干净；用户改动保留。
- `node --import tsx docs/audits/implicit-state-machines-20261109-omp/probe.mts`：最终exit 0，4项通过。首轮审计脚本错误匹配原始save异常文本，随后改为匹配DiagnosticError的stage/cause。仅改探针，业务源码未动。
- `node docs/audits/implicit-state-machines-20261109-omp/verify-audit.mjs`：核对当前文件集合/哈希、增量聚合、唯一ID、引用行、测试路径；最新实测结果以verification.json为准。

未运行build、lint、formatter、既有全套或定向测试、Electron、外部Tern聚焦、OS权限、通知发送、更新下载/安装或发布。

## 优先反证对象

1. **ISM-017**：`src/main/events/collector.ts:173` commit完成，到onCommitted之间取消/崩溃；`src/main/events/store.ts:277` added只含实际插入新行。后续不重放是否正是产品“仅新事件”的接受语义？不要未经确认判为bug。
2. **ISM-036**：`AgentTopology3D.tsx:69` 的owned只有new成功才赋值；`agent-topology-scene.ts:105` 构造时分配renderer/DOM/监听，再注册observer和resize。需要注入后半段异常，证明是否留下DOM/监听/GPU，而不是仅看到字段分配就断言GPU泄露。
3. **ISM-004**：`registry.ts:459` 超时只abort/报告；`stopEntry:499`保留实际在途所有权。probe证明这一行为，现有registry测试也覆盖；这是契约限制，不自动等于缺陷。
4. **ISM-018**：JS cancellation不代表OS授权结束。复核native `Retire`必须等!osPending与finalized，及Cancel/Finish/FinalizeCallback顺序。
5. **ISM-022**：query会按保留策略清理并可能提升revision；旧commit必须CAS失败。已有测试源码标题明确覆盖，独立读实际断言。
6. **ISM-048**：最后gh edit后直接返回Published，没有独立最终readback。只读复核，不实际发布。

## 限制和未完成项

- 独立复核尚未执行，应由负责人另开会话；本代理遵守禁止递归委派。
- 静态扫描不能数学证明无遗漏；目录全枚举不等于所有路径动态执行。
- 性能、真实GPU、N-API/OS callback、系统权限、长期运行与安装切换没有本次实测。
- 测试证据索引是存在性与相关性线索，不是已有测试通过记录，也不证明测试完全覆盖所有守卫。
- 工作区包含并行任务改动，复核前须核对hash；不得reset、全量暂存或清理。
- 本交接按授权写在任务专属artifact目录；未写业务仓库其他文档路径。

## 下一步

1. 先读report.md中的边界与具体风险，再读inventory.json，不依赖旧项目台账。
2. 在独立会话运行verify-audit.mjs核对是否漂移；漂移时只对变更文件及依赖重新定位。
3. 选择上面至少3个高优先级对象，从原代码独立重建转换，不照抄主报告结论。
4. 抽查不适用项及跨模块合并边界，尤其原生资源、renderer小型异步请求、脚本副作用工作流。
5. 将每项复核结论记为支持/修正/驳回，附真实行号、可达路径与运行证据；没有复现不得写已复现bug。
6. 向Hermes回传复核报告与路径；Hermes负责原会话投递，OMP不代发。

## 可粘贴恢复提示

> 对 `/Users/zvf003/ZStack/oc-chan/docs/audits/implicit-state-machines-20261109-omp/` 做独立只读复核。原任务是审计当前应用所有隐式状态机，含主进程、preload、renderer、native、采集/通知/历史/权限/更新与交付运行时。先核对baseline及coverage哈希，阅读report与inventory，但从原代码独立验证高风险结论。重点ISM-017、036、004、018、022；抽查不适用文件避免遗漏及重复计数。所有业务源码只读，不安装依赖、不运行有真实设备/网络副作用的流程、不递归委派、不提交/推送/合并/部署、不代发任何消息。产物写新任务专属耐久目录。区分事实、静态条件风险、运行探针与真实复现bug；报告验证、路径、当前session ID和未完成项。
