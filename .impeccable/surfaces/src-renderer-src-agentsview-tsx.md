---
version: 1
slug: "src-renderer-src-agentsview-tsx"
primary_target: "src/renderer/src/AgentsView.tsx"
related_targets: ["src/renderer/src/AgentTopology.tsx","src/renderer/src/agent-topology.ts","src/renderer/src/agent-topology.css"]
---

# Agent 拓扑画布

Scope: `src/renderer/src/AgentsView.tsx` 及其拓扑组件。Mode: Operate。使用者在本机桌面观察真实 Agent 父子关系，已有绿色系统字体界面继续沿用；不重做全局视觉系统。

## Direction contract

THESIS: 将 Agent 清单改为可操作的关系画布，让父子边而非表格行承担关系表达；概览的简短列表仍服务快速浏览。

OWN-WORLD: 沿用 DESIGN.md 的底色、绿色选择态、琥珀未知状态、细边框和 Lucide 图标。节点固定尺寸，状态同时写明文字。

STORY: 先看到有父子边的分支与独立主 Agent，再搜索项目或筛选角色；保留匹配项的祖先及后代作为关系上下文。只画真实 parentId，父节点缺失时标明限制。

FIRST VIEWPORT: 筛选和搜索在上，采样与数量紧接其下，主体为缩放平移画布；父节点在左、子节点在右，独立分支紧凑排列。画布下角提供缩放、适应视图和重新布局；点击节点在右侧查看详情，窄窗口中详情位于画布下方。

FORM: 用户明确指定交互式canvas拓扑，为现有页面的局部扩展，直接采用关系画布，不进行概念抽签。特色交互是分支收起/展开；自动采样不重置手动位置与视口。无新视觉世界或生成素材。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

验收：真实原生窗口1280×860与880×640，父子边、搜索上下文、收起展开、缩放平移、拖动保持、节点详情/关闭回焦、空/错误状态、未知父关系和刷新行为。DESIGN.md及tokens作为继承依据保持不变；产品说明和交接记录新交互。
