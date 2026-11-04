# OMP 节点右键跳转 Tern 交接

- Repo：`/Users/zvf003/ZStack/oc-chan`
- Branch：`fix/tern-native-navigation`（本次为原生窗口集成新建，最终读取 `.git/HEAD` 核对）
- 目标：修复用户报告的“节点右键跳转实际没成功”，完整选中会话并显示正确的原生 Tern 窗口。

## 根因与最终实现

Tern 0.9.9 的 `focus <pane> --window <key>` 只改变窗口内部选中的标签页。应用级 Apple Event activate 也不能指定两个同名、不同原生全屏窗口中的哪一个。此前仅检查 `focused/tabShown/sessionShown` 和前台应用名，不能证明显示了目标原生窗口；旧交接中的这一完成结论已被用户反馈否定。

现在使用 Tern 官方插件 API 建立确定的窗口身份：随应用提供 `oc-chan-navigation` 插件，原生窗口标题分别形如 `[Tern ""] Default`、`[Tern "3"] Default`。格式化器使用真正的 `cx:window_key()`，一次性 timer 取得窗口上下文，插件 reload 后也能重建；不改标签页、会话文件或聊天内容，没有持续轮询。

主进程继续按 agent ID 解析精确的 window/pane/session，沿已确认的父链处理子代理；点击时重新 inspect 并拒绝已关闭、移动或换会话的 pane。确认 CLI focus 返回的 block 后，检查／首次安装内置插件，发送 Tern 激活 Apple Event，再运行内置 Swift 程序。

原生程序用 `NSRunningApplication` 查找唯一 GUI 应用，避免把同可执行文件的 daemon PID 当成 GUI。等待 Tern 真正到前台，再按唯一窗口标识选择原生窗口菜单项；匹配数必须为 1，绝不按标题顺序、窗口尺寸或几何位置猜测。只有目标窗口出现在 AXWindows、AXMain 为 true 且前台 PID 正确，连续保持至少 300ms 后才返回成功。原生过程及外部命令有超时；权限、插件、原生菜单或前台确认失败均显示实际原因，不静默退回旧路径。

菜单、Shift+F10、Esc 回焦、点击外部保留焦点等既有交互保留。macOS 辅助功能权限不足时会提示允许 OC Chan；本机最终打包实例已实际调用成功。

## 本次改动与调查文件

- `src/main/tern-navigation.ts`：精确会话校验、插件就绪检查、激活与原生显示、结果验证、可读错误。
- `src/main/tern-navigation.test.ts`：保留父链与过期会话边界；增加“CLI 已选中但原生显示失败／返回其他窗口”不能成功的回归。
- `src/main/tern-present.swift`：原生 GUI 身份、辅助功能、唯一菜单项及稳定焦点确认；只用公开 AppKit／AX API。
- `resources/tern-navigation/plugin/plugin.toml`、`window.luau`：原生窗口标识插件。
- `scripts/build-native.mjs`、`package.json`、`.gitignore`：本机构建 Swift helper，打包必需资源，忽略生成二进制。
- `src/main/index.ts`：向导航模块传入开发／打包资源目录。保留并行加入的托盘、设置及安全校验代码。
- `README.md`、`PRODUCT.md`、本交接：更新真实行为、构建条件、权限及验证边界。
- 调查了 Tern 官方 Window API、chrome formatter、timer、CLI 和 macOS 窗口 API；未采用私有 SkyLight 事件、进程注入或按窗口顺序猜测。临时 AX/窗口菜单诊断 Swift 文件已删除。

## 本次实际验证

- `node --import tsx --test src/main/tern-navigation.test.ts`：最终代码 **5/5 通过**。没有运行全仓库测试；本次未修改采集器。
- `npm run package`：最终 TypeScript、Swift、Electron Vite 和 arm64 `.app` 打包通过。未启用 Developer ID 签名或公证。
- `tern plugin install ... --json`：本机安装成功；`tern plugin list --json` 确认 `oc-chan-navigation` 1.0.0 为 ready。
- 最终 `.app` 的真实主窗口，原生 Puppeteer 右键节点并点击菜单首项，分别完成以下两条路径。独立 macOS 观察器确认前台应用为 Tern、目标 CGWindowID 可见、对应 AXMain 持续为 true；再用 Tern inspect 确认 sessionShown、tabShown、focused 均为 true。
  - pane `493921239088` → window key `""` → CGWindowID `720`，标题 `[Tern ""] Default`；观察器在 1144ms 得到稳定成功。
  - pane `785979015178` → window key `"3"` → CGWindowID `1229`，标题 `[Tern "3"] Default`；观察器在 804ms 得到稳定成功。
- 两个原生窗口均为本机已有全屏窗口；没有退出全屏、移动窗口、关闭 Tern 或结束 OMP。以上耗时是两次现场观测，不是性能基准或提升声明。
- 最终主窗口 renderer errors 为 0，导航 alert 为空，已查看真实应用截图。键盘菜单入口在本轮中间包也已执行成功；最终包明确重验的是两次鼠标右键完整路径。
- `stat`：helper 85,696 bytes，manifest 185 bytes，Luau 288 bytes；新增分发资源合计 86,169 bytes。`otool -L` 仅列系统 Framework、系统库与 Swift 系统运行库；未增加 npm 运行时依赖。
- 调试实例与接管已关闭。正常实例由 `occhan-tern-native-delivery` 服务启动，PID `73540`，命令行没有远程调试参数；CGWindowID `6051` 的 1280×860 主窗口可见，前台应用为 OC Chan。

## 验收工具注意事项

并行任务加入了设置、主题、语言与托盘窗口，已保留。验收工具首次打开最终包时接管的是 `?view=tray` 页面。必须枚举实际 Electron CDP 页面，再通过 HTTP discovery endpoint 和真实 target ID 接管主窗口，不能在托盘 tab 上驱动另一隐藏页面的输入控件。

本次主窗口接管使用 `browser.open(app={cdp_url:"http://127.0.0.1:<实际端口>",target:<实际主窗口ID>,relay:false,tern:false})`，不传 `ws://` browser endpoint。发现 target 可用 CDP `Target.getTargetInfo`；当前 browser.targets 对 spawned Electron 不支持发现，已报告工具问题。直接 tab.evaluate 可读取 contextBridge API；从 raw browser.pages() 获得的 page.evaluate 在本环境看不到这些 API，需主窗口 tab 或明确 Runtime.evaluate。

## 边界、限制与交付

- 本次只证明当前 macOS 27.2.0 / Tern 0.9.9 / arm64 环境与上述两个窗口。未验证其他 macOS/Tern 版本、其他权限状态、长期内存／并发压力，也没有可比的完整原生导航成功基线；不宣称性能提升或完成 OOM 压力验收。
- 子代理沿父链定位由定向测试覆盖，本次最终鼠标验收使用真实主会话节点；没有创建假子代理。
- Tern 插件安装在 `~/Library/Application Support/Tern/plugins/oc-chan-navigation`，随应用包保留源码资源。停用插件会明确报错，不会偷偷重新启用。
- 产物：`release/mac-arm64/OC Chan.app`。本线程未安装到 Applications，未发布，未执行 Git 提交或推送。
- 仓库中有并行开发的设置／托盘／主题等改动及新工程规则；不要回滚、覆盖或归功于本次导航修复。本线程不修改模型、OMP 配置、聊天、日志或会话。

## 后续动作与恢复提示

1. 继续开发前读取现行工程规则和最新源码，保留并行改动；正常实例、PID 与页面 target 均需现场重新定位。
2. 如用户要求扩展平台或 Tern 升级，先验证公开窗口标识与菜单语义，再运行定向导航测试及实际原生窗口验收。
3. 如用户授权提交，仅处理获准文件和改动块；提交、推送、发布分别按实际授权执行。

恢复提示：继续 `/Users/zvf003/ZStack/oc-chan` 的 `fix/tern-native-navigation`。用户反馈右键跳转失败；根因是 Tern CLI focus 与应用 activate 不能显示指定原生窗口。已用官方窗口标题插件加 Swift AX 菜单选择解决，等待前台及稳定目标窗口焦点后才成功。最终测试 5/5、打包、两个真实全屏窗口的鼠标右键端到端验收均通过，正常无调试实例已启动。完整证据、权限要求、并行改动与未测范围见本文件。
