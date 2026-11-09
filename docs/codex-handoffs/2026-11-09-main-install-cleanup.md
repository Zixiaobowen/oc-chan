# main 推送、本机更新及重复副本清理

- 仓库 `/Users/zvf003/ZStack/oc-chan`，当前分支 `main`。
- 用户授权：推送 GitHub main，更新本地 OC Chan，删除重复副本。
- 产品提交 `e31b58b7a87019802bc41c92c1ed038bed58a3b0`：Kubai图标、手动更新检查、系统权限入口及对应文档/测试。由 feat/kubai-icons 快进合入main。
- `git push origin main` 成功；GitHub API回读main为上述完整SHA。
- 推送前hook从上述提交git archive构建独立快照，类型检查、生产构建、目录包、签名和安装预检均通过，事务替换 `/Applications/OC Chan.app`。
- 实际安装回执：version 0.1.0、PID30727、status ready；renderer=true、ipc=true；agents/schedules/system/events均ready；Hermes历史25条。旧安装包由事务删除，个人设置和数据保留。
- 本轮合并检查 `node --import tsx --test src/main/app-updates.test.ts src/main/ipc-boundary.test.ts`：19/19通过。上一阶段图标完整renderer smoke、45项包门禁测试及实际视觉证据见Kubai handoff。不声称原生权限已授权或Tern导航恢复。

## 删除范围

逐项核对真实目录、Bundle ID local.oc-chan.desktop、未运行后删除9个应用包，并回读ENOENT确认：

- `release/mac-arm64/OC Chan.app`
- `release/local-20261105-d03-notification-fixed/mac-arm64/OC Chan.app`
- `release/local-20261105-d03-integrated-native/mac-arm64/OC Chan.app`
- `release/local-20261105-d03-chunks-verified/mac-arm64/OC Chan.app`
- `release/local-20261105-d03-verified/mac-arm64/OC Chan.app`
- `release/local-20261105-d02-verified/mac-arm64/OC Chan.app`
- `release/local-20261105-d02-signed/mac-arm64/OC Chan.app`
- `release/local-20261105-d02-isolated/mac-arm64/OC Chan.app`
- `/Applications/.oc-chan-install-5ilb8S/previous.app`

删除前du计数合计2333.73MiB；APFS共享块下不据此承诺实际释放字节。保留正式安装、ZIP/DMG、交付/失败记录、日志、源码、worktree及个人数据。历史delivery.json保留为历史证据，其目录包已按本次授权清理，不再代表完整可用交付目录。

## 边界与后续

- 安装仍为本地ad-hoc签名，无Developer ID、公证、GitHub Release或标签发布。
- 推送后另有并行文档改动 README.md 与新 docs/development.md；不在本次产品提交范围，不暂存或覆盖。
- 版本号仍0.1.0，以源码提交和安装回执辨别本次更新。
- 后续：1.新功能继续走定向验证；2.需要原生权限时由用户完成系统认证再验证Tern跳转；3.需要分发时重新生成目录包，不复用已删除的历史副本。
- 恢复提示：main产品提交e31b58b已成功推送并实际安装，9个重复app已删除。保留并行文档改动，不重复安装或清理其他范围。后续文档回执提交不改变已安装产品源码。
