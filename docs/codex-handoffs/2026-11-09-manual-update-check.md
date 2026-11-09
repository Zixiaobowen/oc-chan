# 手动检查更新修复

- 仓库：/Users/zvf003/ZStack/oc-chan；分支：feat/kubai-icons。
- 目标：本地 ad-hoc 应用可主动检查更新，不能因安装签名限制将检查按钮置灰。
- 根因：UpdateController.start/check 将 development/unsigned 同时作为查询和安装门禁；前端跟随 disabled phase 禁用按钮。
- 修改：src/main/plugins/update-controller.ts 拆开门禁，development/unsigned 可手动检查，不自动检查，download/install 仍受签名限制；src/main/plugins/app-updates.ts 签名检测异常时启动可检查的 unsigned 控制器并保留错误；src/renderer/src/UpdateSettings.tsx 分开检查和安装按钮条件并更新中英文说明；src/main/app-updates.test.ts 更新回归覆盖；README.md 同步说明。
- 验证：node --import tsx --test src/main/app-updates.test.ts，11/11通过；npm run typecheck通过。
- 真实界面：npm run dev 独立无头 Electron，实例 instance-GpSHlH，CDP 57497。设置中检查按钮可用，点击真实请求返回HTTP 404，错误可见且按钮恢复可用，再次点击后同样完成并恢复。截图：/var/folders/0w/k5qp70m100z50z8_yzgcdb980000gn/T/omp-sshots-15c6e244e251b7ca.webp。
- 限制：公开更新元数据当前HTTP 404，不能宣称发现新版或完成升级。没有正式签名、下载安装、可见原生窗口或性能对比验收；未跑全仓测试。开发实例显示Electron版本45.2.1，本次未改版本取值。
- 未提交、推送、发布或替换 /Applications/OC Chan.app。保留用户/并行任务已有图标与界面改动；README仅修改更新说明段落。

## 后续动作

1. 用户要求安装时，按现有本地安装流程构建并验证已安装版本；当前源码修复不会自动作用于现有应用。
2. 获得发布授权及签名条件后，发布公开更新元数据和安装包，验收真实新版发现。
3. 使用正式签名包验收下载、原生安装及重启后版本号变化。

恢复提示：手动检查置灰已修复并通过11项更新测试、类型检查和真实无头Electron点击/错误重试。当前更新服务HTTP404，源码未提交且未安装；保持其他并行改动，不把本次检查验证等同正式升级验收。
