# OMP 节点简短工作摘要交接

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`feat/agent-live-flow`
- 目标：每个 OMP 节点可识别大致工作，用户强调简略即可。

## 实现与来源

读取当前已确认持有 session/lease 的 OMP 会话首行 `type=title,v=1` 标题槽，作为 `AgentInfo.summary`。现场确认该槽比 session header 的初始 title 更新；不使用旧 header 标题，不读取消息正文生成摘要。移除开头终端私有区图标，拒绝空白、通用 omp、控制字符及超长／非字符串值。

节点优先显示摘要、最多两行，保留 OMP 徽标；概览同步显示，悬停与详情查看完整文本，支持按摘要搜索。没有当前标题时保留原 Agent 名称，详情显示未提供会话标题。子代理未生成标题时仍显示原任务名。标题改名不参与拓扑结构键，不重置位置。

## 文件

- `src/main/collectors/agents.ts`、`agents.test.ts`：读取和传递当前标题、验证标题更新／清空与隐私边界。
- `src/shared/types.ts`：可选 `summary` 字段。
- `src/renderer/src/AgentTopology.tsx`、`agent-topology.css`：两行工作标题与可访问名称。
- `src/renderer/src/AgentsView.tsx`：概览、搜索、详情。
- `src/renderer/src/agent-topology.ts`、`agent-topology.test.ts`：摘要搜索、182px 节点尺寸、摘要变化不改布局。
- `README.md`：已补充来源和显示边界。

## 实际验证

- `node --import tsx --test src/main/collectors/agents.test.ts src/renderer/src/agent-topology.test.ts`：37/37 通过。
- `npm run build`：typecheck 和 main/preload/renderer 构建通过。
- 真实 `discoverAgents()` smoke：当时 13 个主 OMP 中 12 个有工作摘要，1 个没有已关联可读会话；子代理没有标题时保留任务名。
- 原生 Electron：概览摘要、中文工作内容搜索、节点完整 title、详情摘要通过；880×640 长中英文摘要无页面水平溢出，renderer errors 为空。
- `electron-builder --mac --dir --publish never`：arm64 应用包成功；实际 ASAR 页面再次检索“工作摘要”，准确匹配当前会话。
- 截图：`.impeccable/review/agent-work-summary.png`。
- 未运行全仓测试，未 commit/push、安装到 Applications、签名、公证、发布或部署。

## 应用状态与限制

临时独立 profile／入口和调试验收实例已清理。旧 OC Chan 监控实例已正常退出，更新包以 `occhan-summary-delivery` 服务运行，启动 PID 48937，无调试端口；PID 仅为交付时快照。

应用包：`release/mac-arm64/OC Chan.app`。源码保留并行会话的事件订阅和粒子连线。摘要只是会话主题，不是实时执行步骤；未知活动子代理数量的限制保持。

## 后续

1. 若继续改摘要来源，先核对本机当前标题槽格式，不读取过时初始标题代替当前标题。
2. 若需为无标题子代理生成自然语言摘要，先确定可靠结构化任务元数据来源；不要硬编码翻译任务名或扫描聊天正文猜测。
3. 后续 UI 改动只跑相关测试并验收实际应用；不要混用前一交接中的旧产物记录。

恢复提示：在上述 repo/branch 继续。用户要简略工作标识，已用 OMP 当前标题槽实现，37 项定向测试和打包原生验收通过。保护并行改动与所有 OMP 会话，不扩大到模型总结或活动计数推断。
