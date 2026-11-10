# Rust / Tauri 合入 main 与本机更新

## 范围与来源

- 原工作区 /Users/zvf003/ZStack/oc-chan 在 refactor/plugin-system-monitor，用户未提交改动完整保留。
- 独立整合工作区 /Users/zvf003/ZStack/oc-chan-rust-merge-20261110，分支 integrate/rust-tauri-20261110。
- 源迁移 df3bbad93f38abfdc39e1963d0b1a191f02426d9，目标 main 629db1f23b0d11d5aa47d95d024be85214279885。通过真实merge逐项处理分叉，而非覆盖main。
- 用户授权合并Rust迁移，并延续本机更新请求；不公开发布、不删除源分支/源码worktree、不修改原工作区或个人数据。

## 完成的整合与修复

- 保留Rust/Tauri宿主、核心、独立插件SDK和安装器；移除Electron生产路径，不恢复兼容层。
- 保留main的项目建筑/任务楼层、插件式renderer、Kubai图标、权限设置、公开发布源与发布防降级回读。
- 更新源改为现场确认public的Zixiaobowen/oc-chan；旧oc-chan-releases现场返回404。
- 修复codesign内联要求缺少`=`；本地delivery调用不存在package:dist改为dist，文档路径同步。
- 补齐Accessibility/打开系统设置的TS→Tauri权限→Rust→原生主线程API。无头查询明确unknown，打开外部设置拒绝，不申请系统授权。
- 保留unsigned/development手动检查更新、错误重试；仍禁止自动调度及下载安装，platform保持禁用。
- 修复Darwin只有僵尸成员的进程组kill(0)返回EPERM竞态；固定1字节sysctl查询，不吞权限错误、不放宽进程身份校验，新增真实僵尸回收回归。
- push-main夹具补真实依赖/Rust路径；事件分页smoke等待实际requestId，避免原生点击未处理前读取旧页，原不重叠/IPC游标断言保留。

## 本轮验证

- npm ci、Rust 1.99.0依赖获取通过；本机新装Rust minimal及cargo-audit0.22.2，未永久改shell PATH。Node v24.22.1，macOS SDK27.2。
- typecheck通过；frontend58项通过。
- 12份交付/安装/发布/CI脚本检查首次268中265通过、3个push夹具失败；修复后push-main9项全部通过，其他已通过项未重复。合计对应268个用例均已通过，不累计重跑数。
- installer31项通过、1项原有ignored；updates最终31项通过（acceptance feature），未运行全仓测试。
- 完整真实hidden Tauri/WKWebView + React + Rust IPC smoke：/Users/zvf003/tmp/merge-pr/oc-chan-rust-20261110/smoke-final/result.json，complete=true/errors=[]。覆盖首次启动、真实IPC权限边界、市场、2D/3D、历史/事件、通知设置、重启持久化、坏设置恢复。54张截图；主代理查看了任务楼层截图。夹具进程/目录及本次开发实例均已清理。
- 首次smoke失败证据保留在同目录smoke-all；根因是事件页面读取时序，不能删除或冒充从未失败。
- `npm run delivery:local -- --out release/tauri/merge-20261110`成功；`install:local -- --check-delivery` verified=true。交付source digest cec56ee7d402968f57e7968a9d117893598370bf7efc24376176f22b3df4aa7a，绑定整合中实际源码清单，不能仅用原HEAD df3bbad表示内容。
- ZIP 11,470,751字节；DMG 11,613,083字节；解包29,257,322字节。包、arm64、ad-hoc签名、ZIP内容、DMG只读挂载内容及依赖审计均verified。
- 依赖审计findings/errors为空；仍有proc-macro-error unmaintained、glib unsound informational warnings，不声称零告警。

## 边界与下一步

- 未验收Developer ID、公证、公开发布/在线安装、可见原生窗口/Dock/托盘/VoiceOver/系统通知投递、24小时与其他硬件；不宣称性能提升。此前迁移性能证据来自其他主机，未当成本轮实测。
- 下一步：将已验证整合提交推送为PR并核对SHA合并；核验远端main；从已验交付安装正式应用；记录真实就绪与清理回执；保留所有源码工作区和ZIP/DMG证据。
- 外部审查记录：/Users/zvf003/tmp/merge-pr/oc-chan-rust-20261110/review.md。

恢复提示：先读本文件与外部review.md，核对真实PR/远端main及安装回执，不重复已有适用检查。原工作区有用户改动，勿checkout/reset/stash/clean。集成产物位于独立worktree的release/tauri/merge-20261110。

## 后续执行回执

- 已推送集成提交a490928并创建PR https://github.com/Zixiaobowen/oc-chan/pull/4；Git与GitHub分页文件集合443项完全相同。
- 提交后重新计算构建输入digest仍为cec56ee7d402968f57e7968a9d117893598370bf7efc24376176f22b3df4aa7a，证明交付包含整合修复而非原df3bbad裸树。
- 正式安装已成功：PID46999，React commit/IPC/agents/events/schedules均ready，Hermes历史available/25条，system未安装。安装证据位于release/tauri/installations/installation-qjhMso/；otool确认系统WebKit链接，无Electron运行时。交付目录中的来源app已由安装器清理。
- GitHub第一轮run42750138461在行为测试前失败：build-marketplace-fixtures未映射。已按全部差异补市场夹具/WK探针映射，退役入口按模块映射且未知路径仍失败；修复host组冷checkout缺少catalog/前端产物的前置条件。
- CI修复本机验证：选择器16项通过，真实PR差异--plan通过；独立临时catalog/前端生成后的真实host组28项通过。只改CI脚本/测试与开发文档，不改变已验收安装包的生产实现。
- PR尚需新一轮GitHub检查及SHA条件合并，完成后记录最终平台回执。源码worktree、ZIP/DMG和source-snapshot证据保留；嵌套源码快照中的构建产物受现有清理规则保护，未绕过删除。
