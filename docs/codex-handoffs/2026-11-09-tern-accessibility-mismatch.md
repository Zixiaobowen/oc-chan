# Tern 导航辅助功能签名不匹配

- Repo：/Users/zvf003/ZStack/oc-chan；分支：feat/kubai-icons。
- 目标：处理协作拓扑右键跳转 Tern 的 OC_TERN_ACCESSIBILITY。
- 已定位：2026-11-09 11:10:15、11:10:21、11:13:23 的系统 TCC 日志明确报告 `Failed to match existing code requirement for subject local.oc-chan.desktop and service kTCCServiceAccessibility`，并输出 2cc11dd82a0b0b85d58d5eddadadd3690850195a 与 c3889e2485de6457374593bad6f518e3a36882f2 两个 cdhash。请求 helper 归属 /Applications/OC Chan.app，责任进程 PID33658。
- `codesign -dv --verbose=4 '/Applications/OC Chan.app'`：Signature=adhoc，CDHash=c3889e2485de6457374593bad6f518e3a36882f2，Identifier=local.oc-chan.desktop。
- 只读 sqlite3 查询系统 TCC.db 被 authorization denied 拒绝；改用 `/usr/bin/log show --last 30m --style compact` 的 TCC 定向 predicate 获得以上证据。未更改或重置权限数据库。
- 相关实现：src/main/tern-navigation.ts 先 CLI focus 再 helper present；src/main/tern-present.swift 的 AXIsProcessTrusted 检查及精确窗口菜单/AXMain 操作确实要求辅助功能。删除检查不能修复系统授权。
- 已调查：上述源码及相关测试（scout），resources/tern-navigation/plugin/window.luau、package.json、11月8日导航交接及11月9日本机安装交接。旧主机/历史授权不是本次授权证据。
- 未修改产品代码、未构建、未安装、未运行测试。保留当前所有并行图标与UI修改。仅新增本交接。
- 阻塞：需要用户在系统设置为当前安装应用重新授权，并按 macOS 要求完成认证。尚未完成真实导航恢复验收。

## 下一步

1. 在系统设置的隐私与安全性 → 辅助功能中重新启用 OC Chan；若旧条目无法更新，移除该权限列表条目，再添加 /Applications/OC Chan.app 并启用（不是删除应用）。
2. 用户完成系统认证后，从已安装应用实际右键跳转，核对应用错误消失、目标 pane/session 与精确原生窗口均正确。
3. 读取本次新 helper 的 TCC 决策，不能用终端运行 helper 的授权代替安装应用授权。
4. 若要解决后续更新的身份稳定性，单独处理稳定代码签名；不要以吞掉权限错误或仅激活整个 Tern 应用代替精确导航。

## 恢复提示

继续处理 OC Chan Tern 跳转。此次根因已有当前系统日志证实：辅助功能保存的代码要求与应用签名不匹配。当前包 ad-hoc，CDHash c3889e2485de6457374593bad6f518e3a36882f2。不要重跑构建或用历史权限成功作证；等待用户重新授权后验证安装应用右键、TCC决策、pane及原生窗口。保留并行UI工作。
