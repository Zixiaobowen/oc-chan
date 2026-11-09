# OC Chan 推送与更新机制修复

> 后续状态（2026-11-09）：本记录中的修复已提交为 `269595c`，通过 `8c5a2ed` 合入GitHub main并推送。合并后的222项定向测试、真实交付与Electron无头smoke均通过；最新状态与恢复入口见 [main合并交接](2026-11-09-update-main.md)。下文保留2026-11-08各阶段当时的状态与证据。

- 日期：2026-11-08
- Repo/worktree：`/Users/zixiaobowen/myProjects/oc-chan-update-mechanism-20261108`
- 分支：`fix/push-update-mechanism-20261108`，基线 `330d1fc4ff3dcb28f87143e4aa0c259b76c4c377`。
- 目标：用户要求“修改所有问题”，修复前一阶段审计确认的六项代码问题，并处理CI保留策略和过时文档。
- 状态：六项代码问题已修复并完成下述本地验证；获批的40项历史Actions产物已全部删除并复查。用户随后指出旧分发地址404，客户端、打包器和发布器已统一到现有公开仓库 `Zixiaobowen/oc-chan`，本次68项定向测试及真实DMG/ZIP构建通过。未commit、push、合并、安装正式应用、启用hook或发布；签名发布仍缺外部条件。
- 原工作区 `/Users/zixiaobowen/myProjects/oc-chan` 及主线工作区 `/Users/zixiaobowen/myProjects/oc-chan-main-integration-20261106` 的既有文档、并行任务改动未动。创建修复分支时main已经包含Tern导航修复330d1fc；不要按旧审计的e184bc8覆盖它。

## 完成的修复

| 问题 | 结果 |
| --- | --- |
| 本地交付输出目录参数冲突 | 统一`--out DIRECTORY`并传入builder；`dist`拥有构建编排，参数、版本和签名环境在build:app之前检查，package/dist各构建一次。 |
| 历史交付误用当前工作区 | schema 2保存五项validation-source数据：manifest、lock、预算及两个Tern插件源文件。路径、字节数、SHA-256与source.digest严格绑定；同一已认证字节用于包、DMG、安装预检与暂存复验。schema 1明确拒绝，无兼容层。 |
| 发布与客户端版本契约不同 | 发布端提前拒绝`+build`；稳定客户端明确拒绝预发布及build metadata。 |
| 安装就绪协议拒绝合法SemVer | 复用semver解析并核对完整规范版本，保留`2.0.0-rc.1+local.7`身份。 |
| FIFO读取阻塞 | 安装元数据、就绪文件和来源读取以O_NONBLOCK/O_NOFOLLOW打开，再严格验证普通文件、上限及读取稳定性。 |
| Latest回退 | 发布作业使用固定串行组、queue:max；草稿上传完整后重读Latest，仅更高稳定版提升，公开后核对Release、四附件及Latest。失败保留远端状态和回查地址。 |

包预算文件缺失的失败报告回归已修复：普通工作区模式在诊断报告生成阶段读取预算，保持明确失败并写出失败证据；认证交付继续只用其快照预算。

CI保持每次真实打包与校验：主线/PR仅上传7天验证报告，smoke证据3天；手动构建和标签上传安装包，分别3/7天。上传错误仍失败。发布队列最多100个待处理作业；其他仓库或手工发布未参与同一串行约束，仍可能竞争，公开后读回不能防止之后的外部改写。

## 修改文件

- 构建、交付、安装：`package.json`、`scripts/dist.mjs`、`scripts/local-delivery.mjs`、`scripts/delivery-source.mjs`、`scripts/check-package.mjs`、`scripts/install-validation.mjs`、`scripts/install-local.mjs`及四个对应现有test文件。
- 版本：`scripts/release-config.mjs`、`scripts/prepare-release.test.mjs`、`src/main/plugins/update-source.ts`、`src/main/app-updates.test.ts`、`src/main/installation-check.mts`、`src/main/installation-check.test.ts`。
- 发布：`scripts/publish-release.mjs`、新增`publish-release.test.mjs`。
- 集成：`.github/workflows/build.yml`、`scripts/ci-tests.mjs`、`README.md`。
- 回执：本文件、同名HTML、原始`2026-11-08-artifact-cleanup-candidates.json`及执行回执`2026-11-08-artifact-cleanup-result.json`；实际构建与smoke结果位于忽略的`release/`目录。
- 没有改变依赖版本或锁文件。LSP没有可用服务，直接调用方通过定向文本搜索、测试和真实入口检查。

## 已运行验证

环境为macOS arm64、Node v24.22.2（本机已有npm缓存中的独立运行时，未改全局Node）。`npm ci --offline --no-audit --no-fund`成功。以下命令均在修复worktree运行；PATH只对该命令包含此Node 24。

```sh
node --import tsx --test --test-concurrency=2 scripts/local-delivery.test.mjs scripts/delivery-source.test.mjs scripts/check-package.test.mjs scripts/install-local.test.mjs scripts/prepare-release.test.mjs scripts/publish-release.test.mjs scripts/ci-tests.test.mjs src/main/app-updates.test.ts src/main/installation-check.test.ts
node --import tsx --test --test-concurrency=2 scripts/check-package.test.mjs scripts/local-delivery.test.mjs scripts/install-local.test.mjs
npm run delivery:local -- --out release/local-update-repair-verified-20261108
npm run install:local -- --check-delivery release/local-update-repair-verified-20261108
npm exec --offline -- install-electron
npm run smoke:renderer -- --out release/update-repair-renderer-verified-20261108
```

- 首轮221项中220通过、1项失败（缺预算未写失败报告）。修复后重跑受影响70项全部通过；未受影响151项保持有效，合计221项具有通过证据。未跑全仓测试。
- 实际delivery完成类型检查、Vite构建、arm64原生模块、DMG/ZIP、依赖审查、冻结包预算、签名检查、ZIP成员与只读挂载DMG内容核验。构建仍有原有大chunk提示；未隐藏提示或提高预算。
- 交付schema=2、version=0.1.0，来源digest=`2ee223cc6e0bf8728bf94a282353bb7e28cb26f379b93f95c3d762c938b863c7`。应用271,880,211字节，DMG122,020,035字节，ZIP117,434,270字节；ad-hoc verified，未公证、未安装。
- 真实`--check-delivery`成功且installed=false。在隔离副本把工作区版本改成9.9.9、替换插件与预算后再次调用真实CLI，原0.1.0交付仍通过。真实ditto复制到临时Applications目录并复验成功；篡改源快照、应用插件或ZIP首字节均拒绝；临时目录已删除。
- 发布器使用独立状态的模拟远端完成乱序稳定版、首次稳定版、预发布、上传/读回失败、重复tag和异常Latest测试；没有真实发布。另用真实只读`gh api --include`核对GitHub响应格式。
- 工作流YAML已解析并执行5类事件的上传条件：主线/PR不上传安装包、手动/标签上传；3/7天保留、固定发布组和错误传播符合预期。GitHub云端尚未运行本修复。
- 来源数据短时压力：五文件共28MiB，4并发、100次读取、1.169秒；单Node进程峰值RSS211,501,056字节（201.7MiB），超限文件拒绝。它不是整应用进程树、长时运行或插件反复启停的内存验收；未宣称性能提升。
- Electron无头smoke成功，197.95秒，真实main/preload/React/IPC，32条合成Agent，真实设置保存与独立重启，36张截图；两次运行进程/资料及夹具已清理。不是可见原生窗口、已安装应用或签名升级验收。

证据：`release/local-update-repair-verified-20261108/{delivery.json,build.log,package-manifest-arm64.json,dependency-review-arm64.json,SHA256SUMS.txt}`；`release/update-repair-verification.json`；`release/update-repair-renderer-verified-20261108/result.json`及evidence目录。

## 调查中发生的失败及处置

- 首次通过npm下载Node/npm时ECONNRESET；改用已存在Node24和离线锁定安装成功，未伪装成源码问题。
- 第一份真实交付在构建期间因主代理新增清理候选文件，工作区Git状态变化而正确拒绝签发回执。保留`release/local-update-repair-20261108/failure.json`，固定状态后的新目录交付成功。该失败目录不得当作交付使用。
- 第一轮Electron smoke缺运行时，日志为`Electron uninstall`；执行CI已有的install-electron后复跑通过，原失败证据保留。
- 隔离CLI冒烟最初使用`/var`路径而Node解析为`/private/var`，入口没有运行；临时夹具改为真实路径后真实CLI核验成功。没有修改产品入口来适配测试。

## 更新源 404 修正

- 事实：用户指出旧分发页404。GitHub API确认 `Zixiaobowen/oc-chan` 的 `private=false`，已有公开 `v0.1.0`，附件为arm64/x64各DMG/ZIP及SHA256SUMS，没有 `latest-mac.yml`。通过实际客户端的 `fetchUpdate` 匿名请求 `https://github.com/Zixiaobowen/oc-chan/releases` 返回HTTP 200。
- 改动：客户端 `RELEASES_URL`、`package.json`、`scripts/dist.mjs` 和 `releaseRepository` 全部使用此现有仓库。移除跨仓库专用令牌要求；release作业单独获得 `contents: write`，将Actions自带 `github.token` 作为 `GH_TOKEN` 传入，普通构建仍只读。README同步了地址、凭据和发布步骤。
- 同仓库标签契约：触发构建的Git tag必须已存在，创建Release使用 `--verify-tag`；缺失tag或同名Release/草稿都拒绝。修改前定向用例实际失败于 `Release or tag already exists: v1.10.0`，修改后通过。原有草稿完整性核验、Latest递增与错误回查逻辑保留。
- 定向验证：`node --import tsx --test --test-reporter=spec scripts/publish-release.test.mjs scripts/prepare-release.test.mjs src/main/app-updates.test.ts`，68/68通过。没有重跑全仓测试。
- 实际构建：`npm run dist -- --arm64 --out release/update-source-20261108-verified`，类型检查、Vite、原生模块与DMG/ZIP构建通过，33.96秒。仍有大于500kB的renderer chunk提示；本次没有新增运行依赖或修改渲染路径。
- 实际产物冒烟：包内 `app-update.yml` 为owner=Zixiaobowen、repo=oc-chan；用实际 `parseUpdate` 解析本次生成的 `latest-mac.yml`，得到该仓库下的ZIP地址；本地ZIP大小117,434,270字节及流式SHA-512校验均与元数据一致。证据：`release/update-source-20261108-verified/source-verification.json`。产物保持本地ad-hoc验证用途，未上传、未安装；没有用它覆盖公开的同版本安装包。
- 早先221项检查、schema2交付和Electron smoke为此地址变更前的阶段证据；本次受影响的发布/客户端路径使用上述68项及新构建复验。LSP引用查询仍无可用服务，已检查直接调用方；活跃代码、workflow和README中不再出现旧分发仓库或专用令牌名。

## 外部阻塞与权限边界

- 用户在看到40个精确ID、6.76GiB大小、保留项及不可恢复说明后，明确选择“清理这40项”。执行前复查40项身份一致且关联运行均completed；40次DELETE全部返回HTTP 204，复查获批ID全部消失，未获批产物全部保留。删除7,254,271,896字节；现存4项共485,751,009字节（463.2MiB），包含#30安装包/证据、#33 smoke以及核对期间新增的#34安装包。未删除Release附件。原候选JSON的executed=false保留为执行前快照，实际结果以cleanup-result.json为准；仓库字节统计不等于账号计费配额。
- 新核对main CI #34（run 42484775201，提交10abf427）为success并已有安装包：https://github.com/Zixiaobowen/oc-chan/actions/runs/42484775201 。它属于并行推进的main，不覆盖本修复分支；#33此前cancelled不能当作通过证据。没有触发或重跑云端CI。
- 本机签名身份及仓库级Secrets在前次审计中均为0；仍需Developer ID证书/私钥、密码和公证账号。公开发布地址已改为可匿名访问的 `Zixiaobowen/oc-chan/releases`，发布器使用Actions自带令牌。现有 `v0.1.0` 缺少更新元数据，仍需后续获得授权的签名新版发布与真实升级验收。
- 本轮没有启用hook或替换`/Applications/OC Chan.app`。现有hook语义是任意分支上传前安装待推送提交；启用该副作用需对应操作授权。
- 提交/推送、删除远端产物、正式安装、发布分别需要对应授权；不沿用此前删除旧分支的授权。不要删除其他会话的worktree、资料、缓存或未提交改动。

## 后续具体动作

1. 在修复worktree审阅源码与本回执；用户授权提交/推送后只提交本轮明确文件，整合最新main时保留并行改动。
2. 历史产物清理已完成，后续使用cleanup-result.json核对；新保留策略在本分支合入后才会生效，不再重复删除已处理ID。
3. 获得Developer ID与公证条件后，通过安全渠道配置签名Secrets，先做发布预检，不把凭据写入交接；发布使用现有源码仓库的Actions令牌。
4. 获得安装/hook或版本发布授权后分别执行，并记录真实应用就绪、版本变化及公开Release回执。
5. 代码若未变化，复用已通过的定向结果；变更后只复验受影响路径，不默认跑全仓测试。

## 恢复提示

> 继续OC Chan推送更新机制修复。先读本文件。修复worktree为oc-chan-update-mechanism-20261108，分支fix/push-update-mechanism-20261108，基线330d1fc，尚未commit/push。六项代码修复和40项获批CI产物清理已完成，不要重复删除。用户指出旧更新源404后，已统一为公开的Zixiaobowen/oc-chan，移除跨仓库令牌要求，发布器要求现存tag并使用--verify-tag。新增阶段68项定向测试、匿名HTTP200、真实DMG/ZIP构建及包内更新地址/本地ZIP校验通过，证据在release/update-source-20261108-verified/source-verification.json。此前221项检查、schema2交付、Electron无头smoke属于地址变更前证据。当前main工作区已推进fb59374，合入前需保留并行改动。剩余条件为签名与公证凭据、签名新版及元数据发布、hook/安装授权；公开v0.1.0没有latest-mac.yml。不要以本地构建代替真实发布，也勿使用首次失败交付目录。

## HTML 回执验收

- 最终HTML已使用`tern browser open`绑定当前pane `8169027796997`，并通过`tern dock 50878182588419 right --json`固定右侧；实际页面title、URL、shown状态已核对。
- 采用html文档技能与design-artifact，沿用OC Chan蓝白/深蓝；没有外部字体、样式或脚本。已查看真实窄栏截图，390/1100宽度的同源嵌入视口均保留六项修复；主题dark/light/system切换与40项候选折叠展开有效，测试iframe已移除并恢复跟随系统。
- Eval browser接管仍报no_window；已上报工具问题，使用同一Tern原生页的state/eval/capture完成验证，没有另开Chrome。回执页面验收不代表正式应用安装或签名升级。
- 更新源修正后复用同一HTML回执与浏览器块，刷新后实际title、正确公开链接和新增68项检查记录可见；当前窄栏无横向溢出，390/1100同源视口复验通过，截图已观察。`tern inspect --json`证实该块仍在包含当前pane的Row分割右侧。重新dock命令退出1，但现有布局已满足要求，未新建或替换其他会话页面。Eval targets/open仍报no_window，已记录工具问题，本次使用同一Tern原生页完成验收。
