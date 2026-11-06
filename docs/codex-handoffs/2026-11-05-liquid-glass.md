# 2026-11-05 原生液态玻璃与强度调节

## 当前状态

- 仓库：`/Users/zvf003/ZStack/oc-chan`
- 分支：`feature/oc-chan-liquid-glass-20261105`
- 目标：为应用加入 Apple 原生液态玻璃，并允许用户调节强度。
- 初次实现和无头 Electron 验收完成后，用户追加授权集成到 main、推送 GitHub 并更新本机。现已提交并推送 `45f6b5e63da17aa7fa01793eac7573586e5c53e6`，正式应用已替换并启动；后续交付证据见文末。前面的初次构建记录保留历史时点含义。
- 原导航程序体积超限已解除：用户随后授权合理放宽预算，arm64 `present-window`上限从128KiB调整为160KiB（163840字节）。现有产物实测134480字节，预留29360字节（21.8%）；实际文件尺寸与SHA256核验一致，并通过预算函数复验。该结果仅覆盖已有目录包的体积预算，不代表后续工作区新增功能已通过完整包检查。

## 实现

- 使用 AppKit 公共 `NSGlassEffectView`，Objective-C++/N-API 模块连接 Electron。每个窗口通过关联对象复用一个玻璃视图，0释放视图，窗口销毁时释放；不使用私有API。
- 设置新增0–100整数滑杆，默认65，0关闭。Apple未公开折射率或模糊半径参数；调节的是原生中性色遮罩与CSS实色遮罩，表达不同通透程度。
- 仅侧栏、顶栏和托盘外层露出原生材质，数据内容区保持实色。浅色与深色均适用。
- 拖动预览不写盘，松开保存；键盘停顿250ms后保存。Esc、失焦、隐藏和离页取消未保存预览。预览保留一个在途和一个可替换最新请求，保存等待预览排空。
- 预览失败显示诊断、恢复实色并提供重试；保存失败恢复已保存值，重试后归还滑杆焦点。系统减少透明度或增加对比度时禁用材质并保留强度。
- 唯一新增依赖为构建期 `node-api-headers@1.9.0`，MIT、无传递依赖；安装包不包含头文件或额外node_modules。实际目录包中的原生模块56416字节。
- 无头开发启动器编译玻璃模块；afterPack按目标架构和应用最低系统版本编译。构建需要macOS 26+ SDK，CI runner改为`macos-26`，增加clang与SDK版本输出。运行时无原生能力时明确禁用玻璃。

## 主要文件

- `src/native/liquid-glass.mm`：公共AppKit桥接、严格参数/活窗口句柄校验、视图所有权。
- `src/main/liquid-glass.ts`、`src/main/index.ts`、`src/main/desktop-settings.ts`：能力快照、主窗/托盘材质、预览IPC与取消。
- `src/shared/settings.ts`、`src/main/settings.ts`、`src/preload/index.ts`及设置/IPC测试：强度契约、持久化和来源边界。
- `src/renderer/src/LiquidGlassSetting.tsx`、`settings.tsx`、`SettingsView.tsx`、`liquid-glass.css`、`settings.css`、`styles.css`：滑杆、预览状态、错误反馈和透明表面。
- `scripts/build-glass.mjs`、`scripts/build-native.mjs`、`scripts/develop.mjs`、`scripts/check-package.mjs`及对应测试、`scripts/ci-tests.mjs`及对应测试：构建、包白名单和定向CI选择。
- `package.json`、`package-lock.json`、`.gitignore`、`.github/workflows/build.yml`、`docs/dependency-review-policy.json`：依赖、产物和SDK约束。
- `README.md`、`DESIGN.md`：操作方式、材质分工及验收边界。

## 实际验证

证据目录：`.impeccable/review/liquid-glass-2026-11-05/`。

- `npm run typecheck`通过。最初发现诊断阶段`glass-preview`不在共享枚举，已改用既有`settings-apply`后通过。
- `node --import tsx --test src/main/settings.test.ts src/main/ipc-boundary.test.ts scripts/check-package.test.mjs scripts/ci-tests.test.mjs`：77项通过。未运行完整仓库测试套件。
- 真实`npm run dev -- --inspect`隔离无头实例：原生模块可用；65→100拖动期间磁盘不变，Esc取消不写盘，释放只写一次；Home关闭、键盘取消、写失败回退、重试焦点、预览故障及恢复均通过。
- 慢IPC故障注入：最大在途1，取消请求最后执行，保存值保持100。辅助功能验证通过本任务进程内的nativeTheme属性/事件注入完成，未更改用户的系统设置。
- 已检查1280×860、880×640内容区及200%放大后的440×320 CSS视口；无整页横向溢出，滑杆仍可操作。保存65后重载恢复65；另保存非默认73，独立Node进程调用真实`readSettings`从实际设置文件读取73。
- `node node_modules/electron-vite/bin/electron-vite.js build --outDir /tmp/oc-chan-glass-delivery-ZICHIc/app/out`通过。
- `npx --no-install electron-builder --mac dir --arm64 --publish never --config.directories.app=.dev-instances/glass-package-TJ4frF/app --config.directories.output=/private/tmp/oc-chan-glass-delivery-ZICHIc/release`通过。临时app manifest去除build字段，构建配置仍来自仓库；临时输入已清理。
- `node scripts/check-package.mjs --app '/private/tmp/oc-chan-glass-delivery-ZICHIc/release/mac-arm64/OC Chan.app' --arch arm64 --output .impeccable/review/liquid-glass-2026-11-05/package-manifest-arm64.json`：内容检查完成，预算阶段失败，唯一超限为上述导航程序。全包271583317字节、ASAR1821017字节，均在既有上限内；外部npm运行依赖0。
- `file`确认玻璃模块为arm64 Mach-O bundle；`otool -L`仅列公共系统框架/运行库。
- `node scripts/dependency-review.mjs --bundled-manifest /tmp/oc-chan-glass-delivery-ZICHIc/app/out/renderer/bundled-dependencies.json --output .impeccable/review/liquid-glass-2026-11-05/dependency-review.json`：verified。审查沿用已批准的构建期例外，报告仍有6项moderate受影响包；不代表漏洞为零。
- `js-yaml`解析更新后的工作流通过；未触发GitHub Actions。
- Impeccable静态检查：既有styles.css的12项圆角建议，新玻璃控件无新增命中；未借机改动无关样式。

## 资源测量及限制

硬件Apple M4 Max、128GiB，macOS 27.2.0，Electron45.2.1/Node24.22.1。负载为同一隔离实例的真实只读采集、设置页面、隐藏窗口；以下CPU为Electron报告的进程指标合计，内存为四个Electron进程RSS合计，不含操作系统WindowServer。

| 场景 | 时长/次数 | 峰值RSS | 结束RSS | 平均CPU |
| --- | --- | --- | --- | --- |
| 玻璃0% | 10秒/20样本 | 589.59MiB | 584.55MiB | 0.185% |
| 玻璃100% | 10秒/20样本 | 589.20MiB | 576.78MiB | 0.169% |
| 原生0/100反复切换 | 22.20秒/20000调用 | 571.55MiB | 557.72MiB | 0.880% |

- 原生切换最大单次耗时2.80ms。40次真实预览IPC往返：P50 0.30ms、P95 0.90ms、最大3.30ms。
- 20轮隐藏窗口创建、调节、销毁：窗口数1→峰值2→1，最终总RSS530.70MiB，无可见或可聚焦窗口。
- 有界压力通过，不推断小时级稳定性、整个系统无OOM或可见GPU帧率。关闭/开启比较是同一构建的材质控制实验，不是独立提交之间的完整性能基线；主窗首次记录DOMContentLoaded361.6ms/load362.2ms，没有据此声称启动加速。
- 未验收：可见原生折射/材质、真实托盘交互、原生全屏/分屏和持续手拖缩放、系统辅助功能实际切换、VoiceOver、录屏/合成帧时间、120Hz、长时压力。遵守无头规则，没有自行打开可见开发窗口。

## 产物与清理

- 目录包：`/private/tmp/oc-chan-glass-delivery-ZICHIc/release/mac-arm64/OC Chan.app`。未签名、公证、安装，也未生成本任务DMG/ZIP。
- 本任务`oc-glass-native`服务已退出；Electron主PID1506不存在，`.dev-instances/instance-Nnf7dF`已由启动器清理；浏览器/Inspector连接和测试文件监听器均已关闭。
- `.dev-instances/glass-package-TJ4frF`与临时app构建输入已删除，目录包和JSON证据保留。未停止或清理其他开发实例。
- 打包初次尝试使用/tmp输入，被electron-builder的workspace路径保护拒绝；最终使用仓库内独立暂存成功，没有关闭安全检查。首次长压力调用超过Inspector默认15秒回执期限；仅将后续完整取得的22秒测量计入正式证据。

## 用户授权后的预算调整

- 2026-11-05用户要求合理放宽上限。基于当前134480字节选择160KiB，保留约21.8%余量；仅修改`architectures.arm64.limits.helperBytes`，其余限制和历史实测数据保持原值。依据写入基线`reason`及README。
- 以实际`present-window`核对尺寸与原报告SHA256后，调用当前`scripts/check-package.mjs`导出的`enforceBudget`，已有目录包的体积预算检查通过。另验证163840字节允许、163841字节拒绝。
- 新回执：`.impeccable/review/liquid-glass-2026-11-05/helper-budget-recheck.json`。原`package-manifest-arm64.json`和`verification.json`保留初次预算失败的历史证据，本节及新回执是预算状态的后续结论。
- 本轮仅改配置和文档，未重新构建、运行全仓测试或重跑当前工作区的完整包内容检查；后续代码已加入其他原生资源，应在后续产物上验证其内容契约。


## 用户偏好与禁改范围

默认中文。保留所有与本任务无关的未提交改动；开始时工作区已有大量插件、采集、导航、布局与验收工作。不得全量暂存、重置或清理。无头开发验收，不抢焦点。用户随后已授权 main 合并、推送和本机更新；这些操作已执行。可见开发窗口验收、GitHub Release 发布和其他部署仍不在本次授权内。arm64 导航程序预算为 160KiB，其余预算保持原值。

## 后续具体动作

1. 后续整合其他并行功能时，对对应新产物执行完整包内容治理；本次 main 集成只移植玻璃和必要构建/安装能力，未带入源目录尚未提交的整套包检查工具。
2. 用户明确要求可见窗口验收后，使用 `npm run dev:window` 检查桌面背景材质、真实托盘、全屏/分屏、系统辅助功能及可见帧时间。
3. 合并后续工作时从当前 `main` 提交开始处理差异，保留原目录各任务修改；不要把本次隔离移植误当成所有未提交功能已合入。
4. 如需切换 GitHub 默认分支，单独处理；此次按要求更新 `main`，默认分支仍为 `master`。

## 恢复提示

继续 OC Chan 液态玻璃任务时，先读本文件文末的最终交付记录和 `/Users/zvf003/tmp/oc-chan-liquid-glass-main/docs/codex-handoffs/2026-11-05-liquid-glass-main.md`。功能、160KiB预算、main 提交推送和本机应用更新均已完成。原工作区的并行修改保留，不能全量暂存或重置。安装来源是 main 提交 `45f6b5e63da17aa7fa01793eac7573586e5c53e6`；默认分支仍为 master。已完成验收不要重复；可见开发窗口、Release 发布及其他部署未授权。

参考：2026-11-05核对[GitHub runner镜像与macos-26标签](https://github.com/actions/runner-images#available-images)。原生桥接使用本机macOS SDK的公开AppKit声明。

## main 集成与本机更新回执

- 独立 worktree：`/Users/zvf003/tmp/oc-chan-liquid-glass-main`。先从 `origin/main@8ad1e92051afc2386f4f2bc52b8eb4bfb7ede975` 创建 `integrate/liquid-glass-main-20261105`，只移植本功能与必要的无头启动、原生构建、安装 hook；没有修改或提交原目录其他任务的代码。
- 提交：`45f6b5e63da17aa7fa01793eac7573586e5c53e6`，`feat: add adjustable native Liquid Glass on macOS`，31 个文件。独立 worktree 的本地 main 已快进，`git push origin main` 成功；`git ls-remote origin refs/heads/main` 返回同一 SHA。
- 集成版 `npm run typecheck` 和 `node --import tsx --test src/main/settings.test.ts scripts/install-local.test.mjs` 通过，19/19；没有运行全仓测试。初次功能实现的 77 项检查与这份 older-main 移植的 19 项检查是不同范围，不能合并成一个测试总数。
- 真实无头集成验收再次覆盖拖动/取消不写盘、释放保存、Home 关闭、6 类非法预览参数、实际写盘路径冲突回退、保存重试和焦点、预览故障及恢复、减少透明度注入、深浅色、默认尺寸及 200% 放大、非默认 73 重载持久化。没有打开可见开发窗口。
- 干净 worktree 的 Electron 45 npm 包没有 postinstall，导致首次启动报 `Electron uninstall`；`scripts/develop.mjs` 已显式运行官方安装入口，之后启动成功。RTK 包装缓冲日志使监督服务的 ready 匹配超时，实际运行通过 PID 44637 的 Inspector/CDP 核对。验收退出后 PID 不存在、独立 profile 已删除，连接已释放。
- Git pre-push 从该提交的独立 `git archive` 源码快照安装依赖、执行 `npm run package`。类型检查、生产构建、arm64 原生编译、架构检查、本地 ad-hoc 签名及 `codesign --verify --deep --strict` 均通过。没有使用混合工作区打包。
- 安装回执：`已替换 /Applications/OC Chan.app，旧应用包已删除；个人设置和数据保留`；新版正式应用 PID 68364 启动成功。正式应用不属于无头开发实例；本次用户已授权更新正式安装。
- 当前 main 的原生导航程序为 87136 字节（来自 main 原有导航源码，未带入并行修改），低于 163840 字节上限；玻璃模块为 56416 字节。`lsof -p 68364` 确认正式应用实际加载安装目录中的 `liquid-glass.node`。
- 安装前后正式 `settings.json` SHA-256 均为 `4cce4752f6d04486c746817362744c19556fc46f17a80fd7a1c225159a9d82d4`，字节内容未变；安装锁已释放。安装包 manifest 未包含构建期 `node-api-headers`。
- 本地集成证据：`/Users/zvf003/tmp/oc-chan-liquid-glass-main/.impeccable/review/liquid-glass-main-2026-11-05.json`。5 秒/模式的四进程指标已记录，不推断长时稳定性或可见帧率。
- GitHub Actions `41977752390` 已成功，精确对应上述提交：`https://github.com/Zixiaobowen/oc-chan/actions/runs/41977752390`。arm64 用时 1分32秒，x64 用时 6分16秒；两者的定向事务测试、类型检查、DMG/ZIP 构建、应用/导航/玻璃模块架构检查、SHA-256 校验及产物上传均通过。
- 本段为交付后的本地交接追加，位于原有混合工作区；不为同步交接而全量提交其他修改。独立 main worktree 中的提交前集成交接已随功能提交。
- GitHub artifact API 返回 2 个未过期产物：`oc-chan-macos-arm64-15`，ID `13392048687`，247101593 字节，摘要 `sha256:090363398d7d8b802421befbd0be51cfd21850323fdd9b240e68d393e5514daf`；`oc-chan-macos-x64-15`，ID `13392403380`，255266945 字节，摘要 `sha256:fd83054d3a40762e1a25d34a50107bb3ccb7ba06987df1a9b178d935e8439dbc`。本次核验云端上传及摘要回执，没有再次下载这两份归档到本机；本机安装来自同一提交的本地 arm64 构建。
- 本次交付已完成：main 提交/推送、本机替换/启动、个人设置保留、原生模块加载及两架构云端产物。未执行 GitHub Release 发布、Apple 公证或可见开发窗口验收。
