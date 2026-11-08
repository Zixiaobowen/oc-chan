# 2026-11-08 OC Chan 视觉标识接入与 GitHub 同步

- Repo：`/Users/zixiaobowen/myProjects/oc-chan`。
- 执行工作区：`/Users/zixiaobowen/myProjects/oc-chan-main-integration-20261106`，分支 `main`，起点 `2a525d2747ccd47a24fc927ad239c94aeef5aebc`。
- 用户目标：把 OC Chan 的视觉标识更新并推送 GitHub；沿用本会话此前明确的本机更新及无用应用副本清理授权，同步已安装应用。
- 开始时主线工作区只有上轮 `2026-11-06-app-updates-main.md` 的安装记录未提交；原工作区仍在 `feat/app-updates`，另有并行发布交接改动。本次均保留，不纳入视觉提交。

## 实现

既有蓝白 OC 品牌资产已经在主线，但原侧栏仍为 Activity 图形、打包仍引用旧 ICNS、README 没有展示标识。此次直接复用已有设计，不重新绘制或引入依赖。

- `src/renderer/src/App.tsx`：侧栏通过 Vite 导入 `resources/brand/oc-chan-icon.svg`；图像作为装饰，保留相邻产品名供辅助技术读取。
- `src/renderer/src/styles.css`：保留 35×35 CSS px 占位，移除旧图形的背景、圆角及 grid 容器样式。
- `package.json`：macOS 打包图标改为 `resources/brand/oc-chan.icns`；删除已不再使用的 `resources/icon.icns`，不保留旧路径。
- `README.md`：顶部展示同一 SVG，并说明侧栏、安装包及菜单栏的标识来源。
- `DESIGN.md`：同步实际接入状态。菜单栏 OC Template Image 已在此前实现，本次未重新生成。

## 验证

- `npm run package`：TypeScript、Vite、原生模块和 arm64 目录包通过。renderer 保留既有 chunk 超过 500 kB 的提示，没有屏蔽警告。
- `npm run check:package -- --app '<集成工作区>/release/mac-arm64/OC Chan.app' --arch arm64 --output release/brand-package-manifest-arm64.json`：包内容、许可证和冻结体积预算通过。app=271895765、ASAR=2090582、Swift helper=134480 字节。相对上轮记录，app 增加 1099129 字节，ASAR 增加 2362 字节；未改预算。首次误传相对 `--app` 路径被参数校验拒绝，改为绝对路径后仅重跑该检查。
- 包内 `Contents/Resources/icon.icns` 与品牌源的 SHA-256 相同：`9e10b26e5743d35945d756abf34ca906ce6aa5f7cdae0c92541eee41b7dd4329`。从真实安装包解码 PNG，确认蓝底白色 OC 图形；证据 `/tmp/oc-chan-brand-packaged-icon-20261108.png`。
- 真实隔离无头 Electron 经 CDP 验收：1280×860 CSS px 浅色及深色、880×640 CSS px 深色均加载新图标，保持 35×35，无根横向溢出；设置入口可操作，浏览器错误列表为空。
- 640×430 CSS px、`--font-scale: 2` 的文字压力场景：点击展开紧凑导航后，图标加载、尺寸保持且无根横向溢出。第一次截图时导航已闭合，产生不可见错误；确认 popover 状态并显式展开后截图成功。该场景不能证明原生透明玻璃背景、真实全屏/分屏或显示缩放效果。
- 没有新增单位测试，也未运行全仓测试；本次仅修改静态标识、引用和等尺寸显示，采用类型检查、实际打包和真实渲染验证。

## 本机安装

运行 `npm run install:local`，安装器按其事务流程重新构建并通过来源、内容、架构、签名、磁盘和权限检查，替换 `/Applications/OC Chan.app`。

实际就绪回执：版本 `0.1.0`、可执行路径 `/Applications/OC Chan.app/Contents/MacOS/OC Chan`、PID `95614`；renderer、IPC、agents/schedules/system/events 采集均 ready，Hermes 历史返回 25 条。版本号未人为提升。安装后的 ICNS SHA-256 与上述品牌源一致。

个人 `settings.json` 安装前后 SHA-256 均为 `b00b61a42ffea0d54f5ed921c0dfec4dc6d430670ba9b7ee87761842bb3de934`，没有替换用户设置。仍为本地 ad-hoc 包；没有 Developer ID 签名发布或自动升级成功回执。

## 短时资源观察

同机、1280×860 无头 Electron、真实本机数据，分别在页面重载后取 6 次、间隔 500 ms 的进程树样本。页面 DOMContentLoaded 46.3→50.8 ms，单次 snapshot IPC 2.4→2.1 ms；进程树采样峰值 RSS 665.34→654.72 MiB，ps CPU 合计样本均值 44.83%→31.32%。可见 Agent 数从 6 变为 5，采样短且有系统负载波动，不能据此推断性能改善或持续退化，也不是整应用启动或长期资源验收。完整样本：`/tmp/oc-chan-brand-visual-sync-20261108.json`。

## 清理与 GitHub 边界

- 已释放本次 CDP 接管，停止 `ocBrandVisualSync`；启动器日志确认进程组退出并清理隔离实例目录。
- 本次构建产生的 `release/mac-arm64/OC Chan.app` 已删除，只保留 `/Applications` 中的正式安装应用。尝试注销临时包时 LaunchServices 返回 -10814；随后查看实际注册数据库，仅正式安装路径有记录，临时包并未注册，因此直接删除临时文件并重新注册正式路径。没有重置系统数据库或清理其他应用。
- GitHub API 实时确认仓库仍为私有、默认分支是 `master`。本次推送目标为近期开发使用的 `main`，查看视觉更新应使用 `https://github.com/Zixiaobowen/oc-chan/tree/main`；没有顺带修改默认分支或保护设置。
- 本文件随视觉提交保存；提交标识、推送及云端状态以最终交付的实际 GitHub 回执为准。没有打标签或发布 Release。

## 后续动作

1. 通过 main 分支直达链接检查本次提交对应的 README、资产及 Actions 回执，不将私有仓库默认 master 首页当成本次结果。
2. 若用户决定统一仓库默认入口，再单独修改 GitHub default branch 并核对相关保护规则、PR 基线和自动化。
3. 后续若要发布可自动升级版本，继续完成 Apple 开发者账号、Developer ID 签名、公证与真实升级验证；本机 ad-hoc 安装不能代替。

恢复提示：OC Chan 蓝白标识已从现有 resources/brand 接入侧栏、macOS 打包及 README，旧 resources/icon.icns 已删除。main 工作区在 oc-chan-main-integration-20261106，原 oc-chan 仍在 feat/app-updates。包体积门禁、真实无头渲染和本机安装验收通过；已安装版本号仍为 0.1.0，但包含本次视觉改动。临时 .app 已清理，个人设置保留。GitHub 默认分支仍为 master，本次推送及预览针对 main；保留两个工作区内其他任务的未提交交接，不全量暂存或删除源码副本。
