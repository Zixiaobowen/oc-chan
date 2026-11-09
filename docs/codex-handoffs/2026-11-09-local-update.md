# 2026-11-09 本机 OC Chan 更新

## 工作区与目标

- Repo：`/Users/zvf003/ZStack/oc-chan`；branch：`main`。
- 用户要求：更新 OC Chan。按本机应用升级处理，同时将干净的本地主线快进同步到远端。
- 源码：`531cb6b` → `fb5937407be7e6821a90b2d1bd619ae06cdf39e0`，快进24个提交；没有创建提交或向远端推送。
- 已安装路径：`/Applications/OC Chan.app`。上游版本号仍为 `0.1.0`，用提交、来源摘要和 ASAR 摘要区分产品内容。

## 完成与实测

- `git fetch origin`、`git merge --ff-only origin/main`：成功，无冲突。任务开始时工作区干净。
- `npm ci --no-audit --no-fund`：成功，按锁文件安装380个包。存在既有依赖弃用和安装脚本审批提示，未修改审批或全局配置。
- `npm run install:local` 完成类型检查、Vite生产构建、arm64目录包、原生模块编译、ad-hoc签名、内容／架构／体积／磁盘／权限预检；随后因旧应用退出超时停止，尚未替换旧包。
- 排查并结束退出阶段的旧进程后，复用已校验的新包，用现有 `captureDeliverySource`、`verifyInstallBundle`、安装锁、`replaceBundle`、`createInstallationCheck` 和 `verifyInstallationResult` 完成恢复。没有重跑构建或修改安装器；恢复时再次核对来源完全一致、包内容、大小和签名。
- 安装成功：PID `33658`，实际可执行文件 `/Applications/OC Chan.app/Contents/MacOS/OC Chan`，`status=ready`。启动回执与 NSWorkspace 运行进程一致，2秒后仍就绪。
- 真实安装应用回执：`renderer=true`、`ipc=true`；agents、schedules、system、events 全部 `ready`；Hermes历史读取25条。
- 应用逻辑字节数：271,879,029；ASAR：2,090,582字节。现有包体门禁通过。
- 源码输入摘要：`e7285b7b38b25c201ccf4c1e211310dd0248b818ded678654b98c7485318e281`。
- 更新前 ASAR SHA-256：`90af3072fd7e1fda686c09c669c8b1cacc32f1ca5ad9b54133939af60b3322e8`。
- 更新后 ASAR SHA-256：`d6f75cc18300b3f0ca5646055b4dc59ef88eaddf3640f618cd5424e467d5c612`。
- `settings.json` 更新前后 SHA-256 相同：`ab6798065b05c3a8f9263845eb11bc448d4ac94746d73b0cc806929efa8ff076`。
- `events/notifications.json` 更新前后 SHA-256 相同：`d1d8940e0a75b7fdbd4b2627e8fca406458cdca60c21fb17aa4f0900fe98edac`。
- 个人数据目录保留；事件数据库会随实际采集继续更新，未声称数据库字节不变。

## 退出阻塞与恢复证据

- 旧应用 PID `98455` 自2026-11-06运行。安装器使用正常 AppKit terminate 请求后，15秒内未退出，明确失败并保留新包；没有提前移动旧应用。
- 当时只有主进程残留，没有 OC Chan renderer/GPU 子进程。`lsof -nP -a -p 98455 -F ftn` 未显示个人设置或事件数据库打开句柄。
- `/usr/bin/sample 98455 1 10` 显示主线程在 `exit → __cxa_finalize_ranges → uv__threadpool_cleanup → uv_thread_join → _pthread_join` 等待，libuv工作线程停在条件等待。证据只确认退出阶段线程回收阻塞，未证明其底层原因，也没有修改代码或声称永久修复。
- 仅对这个已进入退出阶段的PID执行 `kill -TERM 98455`；随后 `ps -p 98455` 返回无进程。未使用SIGKILL，未终止其他应用或开发实例。
- 已验证的新包从 `/Applications/.oc-chan-install-AkUxLN/OC Chan.app` 完成整包替换，新的真实就绪检查通过后，由原事务函数删除旧包。
- 成功后清理本次安装暂存、安装锁、失败启动请求及新启动请求；旧失败暂存、锁和请求目录已核对不存在。恢复脚本仅用于本次安装，未写入产品源码，交付前已删除。
- 原始采样：`/tmp/oc-chan-update-20261109-98455.sample.txt`。
- 完整安装来源与就绪证据：`/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/oc-chan-update-evidence-OIEqza/installation.json`。

## 验证边界与限制

- 本次运行了真实构建与实际安装应用的界面／IPC／采集／历史就绪检查；没有运行全仓单元测试或重复完整renderer smoke。
- 未验收可见窗口中的3D交互、跨应用Tern导航、Dock／托盘、连续动画、长期内存或新版本退出；历史记录中的另一台主机验收不作为本机验收。
- 使用本地ad-hoc签名；没有进行Developer ID签名、公证、GitHub Release发布、标签创建、提交或推送。
- 本次仅同步已有源码并安装，未新增产品修改。仓库新增文件仅为本交接记录。
- 保留个人设置、事件数据、其他任务的工作树、日志和资源。不为本次更新改变系统权限、全局依赖配置或安装脚本审批。

## 后续动作

1. 后续使用当前已安装应用；诊断时以本次来源提交和ASAR摘要为准，不因版本号仍为0.1.0而重复安装。
2. 若退出阻塞再次出现，针对当次PID收集线程采样和文件句柄证据，区分应用清理与Electron/libuv退出阶段；本次SIGTERM恢复不算永久修复。
3. 后续产品有新增改动时再执行相应定向验收与安装；公开版本发布和系统权限变更须遵守各自授权范围。

## 恢复提示

本次“更新occhan”已完成。工作区main从531cb6b快进24个提交到fb5937407be7e6821a90b2d1bd619ae06cdf39e0；已安装应用0.1.0内容已更新，实际PID33658，界面／IPC／四类采集均ready，Hermes历史25条，个人设置和通知配置摘要不变。第一次安装因旧PID98455进入libuv退出线程回收后阻塞而停止；保留采样后用SIGTERM结束该残留进程，复用已校验新包并走现有事务和就绪检查成功安装。没有产品代码修复、全仓测试、正式发布或远端写入。证据与未验证范围见上，不将其他主机的历史验收或本次恢复等同退出故障已永久修复。
