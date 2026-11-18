# 安装、构建与发布

[返回首页](../README.md)

命令和代码路径均相对仓库根目录。应用采用 Rust 核心、`src-tauri` 宿主和 React / TypeScript 界面，使用系统 WKWebView，构建目标为 Apple Silicon。构建、产物验证、正式安装、Git推送和对外发布各有独立回执；其中一步成功不能代替其他步骤。当前恢复实现尚未验证，文档不构成构建、视觉、签名或安装已通过的证据。

## 本地交付与手动升级

本地默认ad-hoc签名。它可验证包内字节一致性，但不代表Developer ID身份、Apple公证或Gatekeeper认可。正式签名凭据、公开Release和已安装版本升级需要分别验收；不能关闭系统防护来代替验证。

```sh
npm ci
npm run build
npm run package
npm run dist
```

`build`执行 Vite 前端打包和 Rust release 构建；`package`生成目录应用；`dist`生成目录应用、DMG和ZIP，稳定发布另生成签名 appcast。入口生成Rust worker、系统插件、Swift导航助手及许可证，准备固定版本的 Sparkle framework，再构建 `src-tauri` 宿主。生产 features 为 `["custom-protocol"]`，不含 `acceptance`。

受控输出位于`release/tauri/`。`build.json`使用schema 3、`renderer: "react"`，绑定buildId、版本、架构、features、程序和资源摘要；开发features为`["acceptance", "custom-protocol"]`，生产为`["custom-protocol"]`。每次分发有独立目录和`distribution.json`，实际路径以回执为准。归档命名为`OC-Chan-<版本>-mac-arm64.zip`和`.dmg`；稳定更新源为 `appcast.xml`，旧 `latest.json` 已删除，不要与构建回执schema混淆。

需要从包含未提交改动的当前源码生成可核对交付时：

```sh
npm run delivery:local -- --out release/tauri/local-react-new
```

输出目录必须全新且位于当前工作区的`release/tauri/`内，工具创建父目录。工具记录实际HEAD、分支、dirty状态、精确构建输入和逐文件摘要，在独立源码快照中构建；HEAD不代表未提交内容。源码在构建期间变化会失败，不生成成功交付清单。源码、依赖审计、包内容、ZIP/DMG一致性和签名回执随交付保留，失败记录不能冒充可安装版本。此入口不启动、退出或替换正式应用。

核验与安装使用不同操作：

```sh
npm run install:local -- --check-delivery release/tauri/local-react-new
# 只有获得替换正式应用的授权后：
npm run install:local -- --delivery release/tauri/local-react-new
```

第一条只核对已有交付；第二条会退出旧应用、同卷暂存并整包替换`/Applications/OC Chan.app`，验证新包就绪，失败尝试还原。也可在获得对应授权后用`npm run install:local`安装当前工作目录。工具不把旧交付当作当前源码，不改写或迁移个人设置、事件库及上游数据；目标被其他任务替换、安装锁占用、签名/摘要不符或路径不安全时拒绝操作。

手动安装同样应先核对来源、归档摘要和实际签名，保留可还原旧包，退出旧应用，再整包替换唯一正式路径。不要合并新旧包内文件。启动后检查实际路径、版本、界面、采集、历史及个人设置；主进程存活不代表就绪。失败保留两份包和错误证据，不能反复覆盖或先删掉唯一可用的安装。

安装成功后清理本次受管应用副本，保留ZIP、DMG、源码worktree和交付证据。已删除目录包的历史交付不再具备可直接安装的目录源；它仍可证明当时的来源与归档，不代表当前目录包存在。

## 应用内更新

应用内更新由 Sparkle 2.10.1 负责，稳定 feed 和 ZIP 使用 Ed25519 签名。生产源固定为 `https://github.com/Zixiaobowen/oc-chan/releases/latest/download/appcast.xml`；客户端不含GitHub凭据、用户自定义更新URL或远程上报。启用 `SUVerifyUpdateBeforeExtraction`、`SURequireSignedFeed`，签名过期 fallback 为 0；签名错误不得降级放行。

React 设置显示状态和自动检查选项；显式检查经 Tauri 命令调用 Sparkle，下载、安装与重启使用 Sparkle 标准界面。自动检查由 Sparkle 管理，自动下载关闭，普通退出不自动安装。“发行说明与下载”打开 GitHub Releases。检查失败保留真实错误，不能显示为“已是最新版本”。

「每个版本」默认接收普通和 LTS 的正式版本。「仅 LTS」只检查维护者明确指定的 LTS 版本。策略同时用于手动和自动检查，并跨重启保存。普通版发布会在签名清单中保留最近的 LTS 条目，已安装较高版本的用户切换到 LTS 后仍按版本顺序检查。

不再以缺少 Developer ID 为由禁用应用更新，无需付费 Apple 开发者会员。ad-hoc 签名与 Ed25519 更新签名不等于 Apple 公证、Gatekeeper 认可或免除首次用户批准；不得关闭系统防护来代替验收。开发和无头实例只探测更新，不启动安装界面。

旧版 0.2.0 没有 Sparkle，首次切换须手动安装新包。旧核心更新器和在线安装助手已删除；`oc-installer` 只保留本地安装就绪库，不再把本地安装的自定义回执/回滚事务描述为 Sparkle 更新协议。真实隐藏场景、标准更新界面、安装与重启需分别验收。完整规则见[更新事务契约](rust-migration/update-contract.md)。

## 版本管理

产品版本只接受 `X.Y.Z`。根 `Cargo.toml` 的 `[workspace.package].version` 是权威来源；`package.json`、npm 锁文件及 Cargo 锁文件中的 workspace 继承版本包必须一致。`patch` 递增修订号，`minor` 递增次版本并清零修订号，`major` 递增主版本并清零其余两项。发布后修复必须用新版本，不覆盖旧安装包。预览构建继续用运行编号与提交 SHA 区分，不进入稳定自动更新；本流程不新增 beta 更新通道。

默认使用 GitHub Actions 的两个入口：

1. 在 `main` 运行 **Prepare release**（`release-prepare.yml`），选择 `patch`、`minor` 或 `major`，填写本次用户可见变化。工作流同步版本，保存 `releases/<版本>.md`，创建版本分支及目标为 `main` 的 PR，并显式启动该分支的 Build macOS 验证。PR 本身不发布正式版。
2. 审阅版本、发布说明、中英文 README 和 CI 结果后合并 PR。发布准备不自动合并；main 的既有预览流程保持不变。
3. 在 `main` 运行 **Release stable**（`release-stable.yml`），输入已合并的完整版本。工作流检查版本、发布说明和 Sparkle 签名配置，创建不可覆盖的 `vX.Y.Z` 标签，再显式启动该标签的 Build macOS；签名和产物验证通过后才公开正式 Release。默认 ad-hoc 发布不要求 Apple 公证凭据。

发布时将 `channel` 选为 `regular`（默认）或 `lts`。渠道记录在版本标签中，重试沿用同一渠道。main 预览包继续通过 GitHub Releases 提供。

准备入口与正式入口使用内置 `GITHUB_TOKEN`。仓库 Settings → Actions → General 必须允许 GitHub Actions 创建 Pull Request；组织策略也须允许该操作。工作流合入默认分支后，手动入口才可使用。内置令牌创建 PR 或标签不会触发普通 push/PR 工作流，因此入口显式 dispatch 后续构建；不能把“PR/标签已创建”当成构建或发布成功。无需添加额外 PAT。

本地也可准备同样的变更：

```sh
npm run version:check
npm run version:bump -- patch --notes-file /absolute/path/to/notes.md
npm run version:check -- --release
npm run test:release
```

本地递增命令只修改版本相关文件和新增发布说明，不提交、不推送、不创建标签、不替换正式应用。发布说明必须非空且受大小上限约束；不要用 `npm version` 单独修改 npm 版本。递增前会验证原始锁文件与依赖审计记录一致，仅在外部依赖未改变时同步新锁摘要，不重写许可、公告、审查日期或审查结论。普通版本检查不要求为既有历史版本补写发布说明；正式发布检查必须有对应说明。

重复版本、版本漂移、锁摘要漂移、缺失发布说明、签名配置缺失及非 main 来源均明确失败。发生网络中断时先查看工作流日志和已创建的分支、PR、标签、草稿；不删除或覆盖既有对象来伪装重试成功。正式安装和签名版之间的原地升级仍需独立验收，版本自动化不替代这些证据。

## GitHub Actions构建与发布

[Build macOS工作流](https://github.com/Zixiaobowen/oc-chan/actions/workflows/build.yml)覆盖main、目标为main的PR、版本标签及手动构建。macOS安装包使用GitHub Releases分发；GitHub Packages用于依赖包或容器镜像，不用于本项目的DMG/ZIP。原生验收运行器需要macOS 26+；生产最低系统要求与验收系统不能混同。云端执行状态以对应提交的实际Actions回执为准，本地修改工作流不等于CI已经通过。

CI安装锁定npm/Cargo依赖，按变更映射运行行为测试；应用入口、采集、桥接、界面或构建改变时运行隔离、真实隐藏的WKWebView场景。页面探针、截图与认证驱动仅在acceptance构建。未映射测试、未知代码路径、测试失败、许可证/公告查询失败和产物校验失败都阻止交付。只上传明确成功的安装材料，失败证据单独保存；工作流已更新不等于运行已通过。

`main`推送或在`main`手动运行工作流时，检查通过后自动发布预览Release，标签为`preview-<运行编号>-<提交短SHA>`，绑定本次构建的完整提交。附件包含ad-hoc签名的arm64 DMG、ZIP和`SHA256SUMS.txt`；Release标为Pre-release，不设为Latest，也不上传稳定 `appcast.xml`，不会触发应用内稳定更新。仓库可见性不因发布而改变。

PR和其他分支上的手动构建只上传Actions产物，不发布。PR新提交可取消旧检查；main和标签运行不因后续推送取消在途发布。GitHub同一并发组只保留一个运行和一个待运行任务，密集推送可能合并为最新的待运行提交。

正式版由与 Cargo workspace、npm 和锁文件一致的稳定标签 `vX.Y.Z` 的 push 或显式 dispatch 触发；标签提交必须属于 main，并提供对应发布说明和 Sparkle Ed25519 签名配置。已有 Release 和附件不得覆盖。同一次运行重跑会使用相同标签；若已存在 Release 或预览标签，发布会明确拒绝并保留现场，不能用覆盖或自动删除掩盖不完整发布。

GitHub Actions 使用 `SPARKLE_PRIVATE_KEY` Secret 签署稳定 feed 和 ZIP；该 Secret 已配置，但配置存在不代表发布或真实更新验收通过。源码只保存 `resources/sparkle.json` 中的公钥。本机私钥保存在专用 macOS keychain 的 `local.oc-chan.desktop` 账号；私钥不得写入源码、日志、公开文档或附件。

主应用采用 ad-hoc 签名并完整保留上游签名的 Sparkle framework，无需付费 Apple 开发者会员。构建拒绝另行注入 Developer ID 身份，避免 hardened runtime 的同 Team 动态库校验与上游 framework 身份冲突。Ed25519 更新签名不代表 Apple 公证或 Gatekeeper 认可。客户端只消费稳定版 `appcast.xml`，没有旧更新元数据兼容路径。

Actions产物可在成功运行记录中下载`oc-chan-macos-arm64-<运行编号>`。预览版和稳定版都使用`Zixiaobowen/oc-chan`的Release，发布job显式申请Contents写权限，使用内置`github.token`，不需要额外PAT。两种发布共用并发锁，先上传草稿、核对附件完整性，再公开并回读验证；预览版额外核对标签指向构建提交，稳定版只在版本较新时更新Latest。校验失败不公开草稿，公开后的错误保留Release供诊断，不自动删除。实际签名、公开下载及正式应用内升级须各自取得回执，不能以脚本单测代替。

草稿核验与公开后的最终回读均要求每个附件的GitHub `digest`严格等于发布前从同一已打开文件句柄流式计算的`sha256:<本地摘要>`；摘要缺失或不一致（即使文件名和大小相同）也明确失败。

发布准备还必须读取 schema 2 的 `package-manifest-arm64.json`，核对版本、arm64 架构和完整 ZIP/DMG 附件集合，并将文件名、长度、ZIP SHA-512 与 DMG SHA-256 同本地重算结果交叉核验。报告超过 16 MiB、缺失或不一致时，在创建发布输出目录前拒绝。

发布入口在访问 GitHub 前再次校验 ZIP/DMG 与 `SHA256SUMS.txt` 的一致性及各自 512 MiB 上限；稳定版还复验 `appcast.xml`、feed 与 ZIP 的 Ed25519 签名及声明的版本和归档信息。准备完成后文件被修改、摘要清单缺项或元数据不一致都会拒绝发布，不能仅以远端附件等于上传字节视为安装材料有效。

若构建期间较新的main提交又修改了`.github/workflows/`，旧构建的workflow内容可能不同于当前默认分支。GitHub对此类目标要求Workflows写权限，而内置`GITHUB_TOKEN`不具备该权限，创建Release可能明确返回403/404。此时检查较新main的运行结果；流程不会用新提交给旧附件打标签，也不把权限错误解释为成功。

## 包内容、体积与依赖审查

产物只允许主程序及其打包的React页面资源、Rust worker、Swift导航助手、Tern插件资源、原生系统插件包、图标、完整 Sparkle 2.10.1 framework 和依赖许可。Sparkle 官方归档由 SHA-256 及逐文件 pin 校验；保留上游签名 helpers，Headers/Modules 也属于上游签名封印，不得裁剪或重签 helpers。旧在线安装助手不再打包。Vite打包真实renderer依赖，ReactFlow与Three.js属于界面运行依赖；WKWebView由系统提供。Rust闭包按目标平台、精确Cargo.lock、运行/构建依赖关系和crate摘要追踪；renderer npm闭包与仅开发工具分别审查。

Rust许可生成器校验锁定crate归档，收集完整LICENSE/NOTICE。未随crate发布的许可按精确VCS commit与上游文本摘要补齐，证据保留在`resources/rust-license-supplements/manifest.json`。产物使用明确的license-only目录，清单保留原始sourcePath和hash，不复制crate源码树。缺许可或来源不能证明时构建失败。

```sh
npm run audit:dependencies -- --output release/dependency-review-arm64.json
npm run check:package -- --app /absolute/path/to/OC-Chan.app --arch arm64 --output release/package-manifest-arm64.json
```

包路径必须替换为`distribution.json`里的真实`.app`；验证归档时再传`--artifacts-dir`对应分发目录。依赖审查要求`cargo-audit 0.22.2`可用，实时查询npm公告和RustSec数据库；`docs/dependency-review-policy.json`绑定精确npm/Cargo锁与已核对许可，不豁免公告、不静默忽略查询失败。锁改变后须重新审查，renderer打包依赖须纳入实际产物闭包。

包检查核对Mach-O架构、可执行权限、完整签名、资源摘要、编译期插件目录pin、许可证及实际条目；拒绝Electron、Chromium、Node、N-API、ASAR、验收驱动/探针、测试、非 Sparkle 上游封印必需的源码、缓存、个人数据、多余资源和逃逸链接。WKWebView验收入口不得进入生产。归档检查包含长度、摘要、ZIP条目和DMG校验。

沿用`docs/package-baseline.json`中的arm64应用总量300MiB、Tern helper160KiB、ZIP125MiB及DMG130MiB上限；原ASAR和已删除依赖的历史分量只保留作证据，不伪造新运行时同类文件。遍历总量保护线不是发布体积预算，插件2MiB/展开9MiB预算也独立执行。历史测量不能当作当前包的体积或性能证明。

此前本地生产构建的 DMG、ZIP 与包检查结果仅是历史证据，具体大小与签名回执记录在当时的本地交接，不能作为本次恢复实现已通过的证据。包含完整 framework 的成本仍由现有预算约束，不根据 SDK 归档大小推断最终应用体积。

## 本机安装与推送后的清理

Git推送不再通过`pre-push`隐式替换正式应用。安装使用上文明确入口，并有对应授权；不恢复旧自动安装hook或Electron构建路径。

合并到本地 main 后可使用 `npm run push:main`；集成分支也可按项目提交技能正常推送 `HEAD:main` 并回读远端。`push:main` 在 GitHub 接收提交并确认远端后清理符合条件的调试应用和开发实例，但不移除源码 worktree。推送、应用清理与下述任务收尾分别记录，不能相互代替。

```sh
npm run cleanup:local
npm run cleanup:local -- --apply
```

第一条只报告；第二条执行受管清理。先复验launcher的出生身份与工作目录，等待它及确认后代退出，再删除本任务临时目录；不跟随符号链接，不凭进程名批量终止。失败保留现场，不把未处理目录称为已清理。

本机永久应用只保留 `/Applications/OC Chan.app`。分支、未提交改动、个人数据库和必要交付证据继续保留。交接保存在本地被忽略的 `docs/codex-handoffs/`，不要求提交或推送；原始证据须保全到目标 worktree 外。按[任务收尾](development.md#任务收尾)记录独立清理授权及现场状态：现有 `closeout:task` 的远端交接blob门禁不适用于本地交接，因此保留工作树并报告阻塞，不强制添加忽略文件、不借用无关交接或绕过门禁。已有目录和其他任务不能自动纳入，未提交材料或在用状态均阻止删除。工具已有收尾回执保存在 Git common dir 的 `task-closeouts/`，不随目标消失。

无头测试只覆盖软件链路，正式安装、Dock、物理托盘、VoiceOver和可见动画仍须独立验收；任务收尾也不代表这些验收已经完成。
