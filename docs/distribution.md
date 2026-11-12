# 安装、构建与发布

[返回首页](../README.md)

命令和代码路径均相对仓库根目录。应用采用Rust/Tauri和系统WKWebView，构建目标为Apple Silicon。构建、产物验证、正式安装、Git推送和对外发布各有独立回执；其中一步成功不能代替其他步骤。

## 本地交付与手动升级

本地默认ad-hoc签名。它可验证包内字节一致性，但不代表Developer ID身份、Apple公证或Gatekeeper认可。正式签名凭据、公开Release和已安装版本升级需要分别验收；不能关闭系统防护来代替验证。

```sh
npm ci
npm run build
npm run package
npm run dist
```

`build`执行前端类型检查和完整release构建；`package`生成目录应用；`dist`生成目录应用、DMG、ZIP与schema2更新元数据。构建入口先生成Rust worker、安装器、系统插件、Swift导航助手、许可证及前端，再构建Tauri宿主。生产feature明确为`custom-protocol`，不含`acceptance`。

受控输出位于`release/tauri/`。`build.json`绑定本次buildId、版本、架构、feature、程序和资源摘要；每次分发有独立目录和`distribution.json`，实际应用路径以该回执为准。归档命名为`OC-Chan-<版本>-mac-arm64.zip`和`.dmg`；稳定版元数据为`latest.json`，不再生成Electron YAML、ASAR或N-API资源。

需要从包含未提交改动的当前源码生成可核对交付时：

```sh
npm run delivery:local -- --out release/tauri/local-rust-new
```

输出目录必须全新且位于当前工作区的`release/tauri/`内，工具创建父目录。工具记录实际HEAD、分支、dirty状态、精确构建输入和逐文件摘要，在独立源码快照中构建；HEAD不代表未提交内容。源码在构建期间变化会失败，不生成成功交付清单。源码、依赖审计、包内容、ZIP/DMG一致性和签名回执随交付保留，失败记录不能冒充可安装版本。此入口不启动、退出或替换正式应用。

核验与安装使用不同操作：

```sh
npm run install:local -- --check-delivery release/tauri/local-rust-new
# 只有获得替换正式应用的授权后：
npm run install:local -- --delivery release/tauri/local-rust-new
```

第一条只核对已有交付；第二条会退出旧应用、同卷暂存并整包替换`/Applications/OC Chan.app`，验证新包就绪，失败尝试还原。也可在获得对应授权后用`npm run install:local`安装当前工作目录。工具不把旧交付当作当前源码，不改写或迁移个人设置、事件库及上游数据；目标被其他任务替换、安装锁占用、签名/摘要不符或路径不安全时拒绝操作。

手动安装同样应先核对来源、归档摘要和实际签名，保留可还原旧包，退出旧应用，再整包替换唯一正式路径。不要合并新旧包内文件。启动后检查实际路径、版本、界面、采集、历史及个人设置；主进程存活不代表就绪。失败保留两份包和错误证据，不能反复覆盖或先删掉唯一可用的安装。

安装成功后清理本次受管应用副本，保留ZIP、DMG、源码worktree和交付证据。已删除目录包的历史交付不再具备可直接安装的目录源；它仍可证明当时的来源与归档，不代表当前目录包存在。

## 应用内更新

正式安装版必须通过Developer ID信任链、固定Bundle ID和实际架构校验，才启用自动检查、下载和安装。开发和ad-hoc版本仍可手动检查新版、查看结果和重试真实错误，界面保留下载/安装受限原因；不支持的平台不能检查。固定公开源为`Zixiaobowen/oc-chan`；客户端不含GitHub凭据、用户自定义更新URL或远程上报。

更新页的“发行说明与下载”打开 GitHub Releases。开发和未签名版本会明确提示从该页面下载并手动安装；此入口不绕过应用内安装的签名门禁。

更新元数据返回 HTTP 404 时，更新页明确提示“尚无可用 Release，或发布仓库不可访问”，保留失败状态；不会显示为“已是最新版本”。其他 HTTP 错误及安装包下载失败保持各自错误，不套用此提示。

具备完整更新资格时启动30秒后检查，此后每6小时检查，也可手动检查。元数据使用schema2的稳定语义版本和单个arm64资产，记录固定ZIP文件名、精确长度与SHA-512。HTTP仅允许受限HTTPS发布域，流式写入私有暂存文件；元数据、下载大小、磁盘空间、并发、超时和取消均有边界。

下载、取消和“重启并安装”都是显式操作。普通退出不安装。安装前复验Developer ID、同Team、固定应用标识、架构和严格升级版本；Rust安装助手绑定父进程出生身份、应用路径及文件身份，持独占锁并记录事务阶段，同卷替换。

提交成功必须收到当前事务的真实就绪回执：版本、进程、nonce及可执行身份匹配，renderer已提交、IPC往返成功、已启用采集域就绪，可用Hermes历史查询成功，且进程持续存活。停用分区和无历史来源明确记为disabled/unavailable，不能填充成功空结果。失败回滚保留可定位现场。完整规则见[更新事务契约](rust-migration/update-contract.md)。

## GitHub Actions构建与发布

[Build macOS工作流](https://github.com/Zixiaobowen/oc-chan/actions/workflows/build.yml)覆盖main、目标为main的PR、版本标签及手动构建。macOS安装包使用GitHub Releases分发；GitHub Packages用于依赖包或容器镜像，不用于本项目的DMG/ZIP。原生验收运行器需要macOS 26+；生产最低系统要求与验收系统不能混同。云端执行状态以对应提交的实际Actions回执为准，本地修改工作流不等于CI已经通过。

CI安装锁定的npm/Cargo依赖，按变更映射运行行为测试；应用入口、采集、桥接、界面或构建改变时运行真实隔离WKWebView场景。未映射测试、未知代码路径、测试失败、许可证/公告查询失败和产物校验失败都阻止交付。只上传明确成功的安装材料，失败场景证据单独保存。

`main`推送或在`main`手动运行工作流时，检查通过后自动发布预览Release，标签为`preview-<运行编号>-<提交短SHA>`，绑定本次构建的完整提交。附件包含ad-hoc签名的arm64 DMG、ZIP和`SHA256SUMS.txt`；Release标为Pre-release，不设为Latest，也不上传`latest.json`，不会触发应用内稳定更新。仓库可见性不因发布而改变。

PR和其他分支上的手动构建只上传Actions产物，不发布。PR新提交可取消旧检查；main和标签运行不因后续推送取消在途发布。GitHub同一并发组只保留一个运行和一个待运行任务，密集推送可能合并为最新的待运行提交。

正式版仍由匹配`package.json`的稳定版本标签`vX.Y.Z`触发，要求完整Developer ID签名和Apple公证密钥。已有Release和附件不得覆盖。同一次运行重跑会使用相同标签；若已存在Release或预览标签，发布会明确拒绝并保留现场，不能用覆盖或自动删除掩盖不完整发布。

签名CI使用以下Secrets，不将证书、密码或令牌写入仓库：

| Secret | 用途 |
| --- | --- |
| `APPLE_CERTIFICATE` | 包含私钥的Developer ID Application p12，Base64编码 |
| `APPLE_CERTIFICATE_PASSWORD` | p12导出密码 |
| `APPLE_SIGNING_IDENTITY` | 完整`Developer ID Application: … (TEAMID)`身份，与Team匹配 |
| `APPLE_ID` | 公证账号 |
| `APPLE_PASSWORD` | Apple应用专用密码 |
| `APPLE_TEAM_ID` | 10位Team ID |

构建签名输入统一为`APPLE_SIGNING_IDENTITY`。证书只导入runner临时keychain，构建后回收；本地ad-hoc构建不自动发现签名或公证凭据。标签流水线验证完整签名、公证票据和Gatekeeper，复核归档及元数据后先上传草稿，确认附件完整再公开。客户端只消费稳定版`latest.json`，没有旧Electron更新元数据兼容路径。

Actions产物可在成功运行记录中下载`oc-chan-macos-arm64-<运行编号>`。预览版和稳定版都使用`Zixiaobowen/oc-chan`的Release，发布job显式申请Contents写权限，使用内置`github.token`，不需要额外PAT。两种发布共用并发锁，先上传草稿、核对附件完整性，再公开并回读验证；预览版额外核对标签指向构建提交，稳定版只在版本较新时更新Latest。校验失败不公开草稿，公开后的错误保留Release供诊断，不自动删除。实际签名、公证、公开下载及正式应用内升级须各自取得回执，不能以ad-hoc测试代替。

草稿核验与公开后的最终回读均要求每个附件的GitHub `digest`严格等于发布前从同一已打开文件句柄流式计算的`sha256:<本地摘要>`；摘要缺失或不一致（即使文件名和大小相同）也明确失败。

发布准备还必须读取 schema 2 的 `package-manifest-arm64.json`，核对版本、arm64 架构和完整 ZIP/DMG 附件集合，并将文件名、长度、ZIP SHA-512 与 DMG SHA-256 同本地重算结果交叉核验。报告超过 16 MiB、缺失或不一致时，在创建发布输出目录前拒绝。

发布入口在访问 GitHub 前再次校验 ZIP/DMG 与 `SHA256SUMS.txt` 的一致性及各自 512 MiB 上限；稳定版还复验 schema 2 的 `latest.json`。准备完成后文件被修改、摘要清单缺项或元数据不一致都会拒绝发布，不能仅以远端附件等于上传字节视为安装材料有效。

若构建期间较新的main提交又修改了`.github/workflows/`，旧构建的workflow内容可能不同于当前默认分支。GitHub对此类目标要求Workflows写权限，而内置`GITHUB_TOKEN`不具备该权限，创建Release可能明确返回403/404。此时检查较新main的运行结果；流程不会用新提交给旧附件打标签，也不把权限错误解释为成功。

## 包内容、体积与依赖审查

产物只允许主程序、Rust worker、安装器、Swift导航助手、Tern插件资源、原生系统插件包、图标和完整依赖许可。前端编译进Tauri资源，实际使用的npm模块通过Vite清单追踪；Rust闭包按目标平台、精确Cargo.lock、运行/构建依赖关系和crate摘要追踪。

Rust许可生成器校验锁定crate归档，收集完整LICENSE/NOTICE。未随crate发布的许可按精确VCS commit与上游文本摘要补齐，证据保留在`resources/rust-license-supplements/manifest.json`。产物使用明确的license-only目录，清单保留原始sourcePath和hash，不复制crate源码树。缺许可或来源不能证明时构建失败。

```sh
npm run audit:dependencies -- --output release/dependency-review-arm64.json
npm run check:package -- --app /absolute/path/to/OC-Chan.app --arch arm64 --output release/package-manifest-arm64.json
```

包路径必须替换为`distribution.json`里的真实`.app`；验证归档时再传`--artifacts-dir`对应分发目录。依赖审查要求`cargo-audit 0.22.2`可用，实时查询npm公告和RustSec数据库；`docs/dependency-review-policy.json`绑定精确npm/Cargo锁与已核对许可，不豁免公告、不静默忽略查询失败。锁或实际前端清单改变后必须重新审查。

包检查核对Mach-O架构、可执行权限、完整签名、资源摘要、编译期插件目录pin、许可证及实际条目；拒绝Electron、Chromium、Node、N-API、ASAR、验收驱动和私有XPC观察selector、测试、源码、缓存、个人数据、任意多余资源和逃逸链接。归档检查包含长度、摘要、ZIP条目和DMG校验。

沿用`docs/package-baseline.json`中的arm64应用总量300MiB、Tern helper160KiB、ZIP125MiB及DMG130MiB上限；原ASAR和已删除依赖的历史分量只保留作证据，不伪造新运行时同类文件。遍历总量保护线不是发布体积预算，插件2MiB/展开9MiB预算也独立执行。历史测量不能当作当前包的体积或性能证明。

## 本机安装与推送后的清理

Git推送不再通过`pre-push`隐式替换正式应用。安装使用上文明确入口，并有对应授权；不恢复旧自动安装hook或Electron构建路径。

合并到本地 main 后可使用 `npm run push:main`；集成分支也可按项目提交技能正常推送 `HEAD:main` 并回读远端。`push:main` 在 GitHub 接收提交并确认远端后清理符合条件的调试应用和开发实例，但不移除源码 worktree。推送、应用清理与下述任务收尾分别记录，不能相互代替。

```sh
npm run cleanup:local
npm run cleanup:local -- --apply
```

第一条只报告；第二条执行受管清理。先复验launcher的出生身份与工作目录，等待它及确认后代退出，再删除本任务临时目录；不跟随符号链接，不凭进程名批量终止。失败保留现场，不把未处理目录称为已清理。

本机永久应用只保留 `/Applications/OC Chan.app`。分支、未提交改动、个人数据库和必要交付证据继续保留。完整任务交付还须执行 [任务收尾](development.md#任务收尾)：先把交接提交到 GitHub main，将原始证据保全到目标外，再从保留工作区用 `npm run closeout:task -- --worktree <任务临时目录> --handoff <已推送交接>` 预检；逐项审阅 ignored 材料并明确可丢弃条目，无阻塞后加 `--apply` 移除本任务临时 worktree。已有目录和其他任务不能自动纳入，任何未提交材料或在用状态都阻止删除。收尾回执保存在 Git common dir 的 `task-closeouts/`，不随目标消失。

无头测试只覆盖软件链路，正式安装、Dock、物理托盘、VoiceOver和可见动画仍须独立验收；任务收尾也不代表这些验收已经完成。
