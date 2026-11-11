# GitHub Release 版本检查与 Actions 发布

## 仓库与目标

- Repo：/Users/zvf003/ZStack/oc-chan；branch：fix/github-release-updates，从feat/kubai-icons携现有改动创建。
- 用户要求：GitHub Actions构建产物到GitHub Release，应用对比该Release版本。
- 现场事实：gh repo view确认源码仓库oc-chan为PUBLIC，最新正式Release为v0.1.0，已含arm64/x64 DMG、ZIP及SHA256SUMS。旧oc-chan-releases端点404。原先文档里的私有源码/独立公开分发设计已不符合现状。

## 已完成

- update-source.ts使用同仓库GitHub REST latest Release，匿名版本化JSON请求；严格验证tag、公开稳定状态、机器架构、资产地址/大小/uploaded及SHA256 digest。弃用YAML元数据，保留64KiB响应和512MiB ZIP上限、有界流式下载、取消和超时。
- app-updates.ts静态使用项目package version，开发模式不再显示Electron版本。上一阶段修复保留：ad-hoc/development允许主动检查和重试，原生下载/安装仍受签名门禁约束。
- UpdateSettings.tsx说明手动下载方式，按钮为“发行说明与下载”，复用已有受限IPC打开对应Release页面。
- .github/workflows/build.yml：main/PR/manual构建Artifacts；匹配package版本的v* tag push构建ad-hoc arm64 DMG/ZIP并发布同仓库。仅release job有contents:write，使用内置GITHUB_TOKEN，无跨仓库Token或Apple证书强制前提。
- dist/release-config/prepare-release/publish-release脚本删除旧签名发布和YAML路径；先验证真实包及SHA256，再草稿上传三项附件，核对GitHub摘要/大小/状态后公开。预发布不标latest，不覆盖已有版本。
- package.json移除被替代的builder publish配置；check-package.mjs移除app-update.yml允许项。
- README和docs/development.md同步当前下载、发布、版本检查说明。保留并行任务新拆分的文档结构与图标修改。

## 实际验证

- node --import tsx --test src/main/app-updates.test.ts scripts/prepare-release.test.mjs scripts/check-package.test.mjs：90/90通过。
- npm run typecheck：通过。
- Actions YAML解析、tag触发及release-only写权限断言：通过；本机未安装actionlint，没有声称完成actionlint或云端运行。
- npm run dev独立无头Electron：当前版本0.1.0；实际点击检查，成功查询现有v0.1.0，显示“最近一次检查未发现新版本”和检查时间，按钮恢复可用。截图：/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15c6e93781e31877.webp。
- 直接调用产品fetchUpdate/readMetadata/parseUpdate访问真实API：当前0.1.0返回无更新；以0.0.9作为比较输入返回0.1.0及正确arm64 ZIP、GitHub SHA256。未下载远程包。
- npm run dist -- --arm64：类型检查、Vite、原生编译、ad-hoc签名、DMG/ZIP均成功。有既有大chunk提示及ad-hoc/hardenedRuntime提示；未关闭系统防护。没有Apple公证。
- npm run check:package -- --app '/Users/zvf003/ZStack/oc-chan/release/mac-arm64/OC Chan.app' --arch arm64 --artifacts-dir release --output release/package-manifest-arm64.json：通过；app 271823840 bytes、ASAR 2137601 bytes，budget=passed。
- 对实际DMG/ZIP生成SHA256SUMS，prepareRelease验证真实package manifest并输出release/verified-github-release-20261109成功。ZIP 117330688 bytes；DMG 121949418 bytes。
- 本任务开发实例instance-DuJmnq已正常以SIGTERM停止，相关PID不存在，临时目录已释放；监督器143为主动停止回执。

## 边界与限制

- 未提交、推送、创建tag、调用真实发布、替换已安装应用。现有v0.1.0未覆盖；本地产物是验证当前工作区（含用户并行改动），不是新发布。
- 云端Actions、正式签名/公证及原生自动升级未验收；此次提供Release检测与手动下载路径，不声称ad-hoc可原地自动安装。
- 没有全仓测试、长期压力或性能前后比较，不声称性能改善。网络读取和包大小上限沿用并有定向边界测试。
- 用户无关图标、文档等改动须保留，不能全量暂存或回滚。当前版本仍0.1.0，发新版本必须递增package及lock版本。

## 下一步

1. 如用户要求提交，区分本任务与并行改动，精确暂存并本地提交。
2. 获得发布授权后确定下一版本，更新package/lock并提交，再推送对应v标签。
3. 跟踪云端Build macOS实际运行，确认三项Release附件和GitHub digest，并验收客户端发现新版。
4. 用户要求本机升级时再使用既有install:local流程安装并验收；当前源码修改不会自动进入现有应用。

恢复提示：GitHub Release更新链路已本地实现并验证，分支fix/github-release-updates，90测试通过、真实Electron能比较现有v0.1.0、实际DMG/ZIP与发布准备成功。尚未提交推送发布或安装。保留现有并行改动，不覆盖v0.1.0；新发布必须新版本和授权。
