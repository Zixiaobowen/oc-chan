# 设置中的系统授权入口

- Repo：/Users/zvf003/ZStack/oc-chan；branch：feat/kubai-icons。
- 用户目标：在OC Chan设置体现相关权限入口，点击唤起系统授权页。
- 完成：新增辅助功能状态、打开macOS辅助功能设置、重新检查和回焦/恢复可见自动刷新；现有通知设置增加打开系统通知设置。打开页面不等于授予权限；系统状态不持久化。
- 主进程使用 isTrustedAccessibilityClient(false) 被动查询，只接受 accessibility/notifications 固定枚举和固定系统URL；IPC mainOnly、严格参数校验，headless在副作用前拒绝打开。查询/打开失败就近展示，单在途及卸载清理。
- 文件：src/shared/settings.ts、src/preload/index.ts、src/main/index.ts、src/main/ipc-boundary.ts及测试、src/renderer/src/AccessibilitySetting.tsx（新）、SettingsView.tsx、NotificationSettings.tsx、README.md。保留用户并行图标/UI及package修改。

## 验证

- `node --import tsx --test src/main/ipc-boundary.test.ts`：最终8/8通过。覆盖非法URL/枚举、窗口来源、托盘拒绝及headless副作用隔离。
- `npm run typecheck`：通过。
- Impeccable detect 对3个改动UI组件返回 []。
- `npm run dev` 独立无头真实Electron：设置入口、辅助功能状态、重新检查、通知入口、中英文验证；1280×860与880×640 CSS内容区，200%文字（--font-scale=2，帮助文字实测24px）无横向溢出。刷新完成aria-busy=false，焦点保留Check again。
- 真实preload/IPC返回headless/unknown；两种合法打开目标均在headless被拒绝，传入任意https URL被参数校验拒绝；最终renderer errors为空。
- 第一开发实例在并行文件写入阶段留下Vite import错误（引用早于新文件创建），最终文件齐备后正常退出并重启独立实例，最终界面通过。
- 本轮没有测量前后启动/CPU/内存差异，不宣称性能改善；未运行全仓测试。无头不能证明系统设置原生页面真正唤起、授权成功或Tern窗口恢复；没有可见窗口、全屏/分屏/连续缩放的原生验收。
- 未构建发行包、未安装、未提交或推送，也未更改系统权限。

## 下一步

1. 用户需要本机生效时，在明确安装授权下构建安装，保留并行工作与个人设置。
2. 从已安装应用设置点击两个入口，验证系统设置目标页面；必要系统认证由用户完成。
3. 返回设置确认授权状态刷新，并从协作拓扑实际跳转Tern验证窗口/pane和TCC回执。

## 恢复提示

系统授权入口实现和定向无头验收已完成，尚未安装。不要把无头禁用截图误解为正式应用不可用，也不要把主进程权限状态等同helper导航成功。当前分支存在用户并行图标修改，禁止全量暂存或重置；详见本交接文件。
