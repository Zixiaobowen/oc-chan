# OMP 子代理生命周期公开接口调研

核对日期：2026-11-05。对应F-07，本期只读调研；没有实施适配器、启动RPC会话、请求Collab链接、读取私有会话正文、安装Hook或修改OMP配置。

公开接口已能表达子代理运行、完成、失败和取消，但本次核对的接口不能同时满足“接入任意既有本机会话、只读元数据、完整子代理状态和父子关系、断线后无歧义恢复”。OC Chan继续保留`activeSubagents=null`；本报告不把功能卡标为完成。

## 版本和证据范围

本机实际执行`omp --version`返回`omp/18.16.0`。公开仓库本次核对固定为[`650f3a108229ee11bf68ba3377f4e8c3391cd424`](https://github.com/can1357/oh-my-pi/tree/650f3a108229ee11bf68ba3377f4e8c3391cd424)，其[package.json](https://github.com/can1357/oh-my-pi/blob/650f3a108229ee11bf68ba3377f4e8c3391cd424/packages/coding-agent/package.json#L3)同为18.16.0。版本号相同不证明本机二进制来自该提交；未检查本机运行时私有状态或实现文件。本报告结论限定于以下公开文档和源码。

- [Collab公开文档](https://github.com/can1357/oh-my-pi/blob/650f3a108229ee11bf68ba3377f4e8c3391cd424/docs/collab.md)：本机发现、元数据、共享权限、房间轮转与重连。
- [Collab本机registry](https://github.com/can1357/oh-my-pi/blob/650f3a108229ee11bf68ba3377f4e8c3391cd424/packages/coding-agent/src/collab/registry.ts)：`CollabHostSnapshot`、认证、字段/帧上限、缺失来源处理。
- [Wire类型](https://github.com/can1357/oh-my-pi/blob/650f3a108229ee11bf68ba3377f4e8c3391cd424/packages/wire/src/index.ts)：`AgentSnapshot`、`SubagentLifecyclePayload`、`SubagentProgressPayload`、`welcome`与`agents`帧。
- [Collab主机协议](https://github.com/can1357/oh-my-pi/blob/650f3a108229ee11bf68ba3377f4e8c3391cd424/packages/coding-agent/src/collab/protocol.ts)：初始会话/Agent快照、正文分块、实时事件和总线。
- [RPC公开文档](https://github.com/can1357/oh-my-pi/blob/650f3a108229ee11bf68ba3377f4e8c3391cd424/docs/rpc.md)及[RPC类型](https://github.com/can1357/oh-my-pi/blob/650f3a108229ee11bf68ba3377f4e8c3391cd424/packages/coding-agent/src/modes/rpc/rpc-types.ts)：启动方式、订阅、快照、完成与传输语义。
- [SDK公开文档](https://github.com/can1357/oh-my-pi/blob/650f3a108229ee11bf68ba3377f4e8c3391cd424/docs/sdk.md)及[AgentRegistry源码](https://github.com/can1357/oh-my-pi/blob/650f3a108229ee11bf68ba3377f4e8c3391cd424/packages/coding-agent/src/registry/agent-registry.ts)：进程内注册、状态、父子关系、驻留和每轮生命周期。

## 可接入面及缺口

### 本机Collab发现：元数据足够判断主会话回合，不能统计子代理

公开入口是`omp collab list --json`，输出`version:1`与`hosts`。同一配置根目录内已发布的本机Host可见，未启用/未连接成功的Host、Guest和远端Host不在列表内。仅两种本机IPC操作：`snapshot`和`link`；`snapshot`不含子代理清单。

可读字段为`instanceId`、`generation`、`pid`、`sessionId`、`sessionName`、`cwd`、`model`、`startedAt`、`participants`、`relayConnected`、`inputRequired`、`busy`和`access`。`instanceId`在进程内跨房间稳定，`generation`随房间更换递增；PID本身不能作持久身份。名称和路径仍可能敏感，应按用途白名单取字段。

`busy=true`覆盖响应流与工具执行；`false`只表示此刻没有运行回合，调度暂停、等待异步结果和压缩期间也可能为false，不能等同整个任务完成。`null`表示未知。Host消失不能解释为idle、completed或子代理数0。

源码规定请求≤4KiB、响应≤64KiB、自由文本字段≤1024字符，查询默认1.5秒、最多8并发。目录缺失是合法空结果，目录不可读/链接是错误；单项不响应、版本不符或格式错误会独立省略。因此即使命令成功且返回空数组，也不证明所有本机OMP都已被覆盖。

`list`会清理失效/畸形发现记录，并非严格无副作用的读取。本次没有执行它，也没有读取发现目录的bearer token。`link`会取得具有会话访问能力的URL，本次未调用。

### Collab共享流：有父子关系和生命周期，但会同步正文

Wire的`AgentSnapshot`提供`id/displayName/kind/parentId/status/hasSessionFile/createdAt/lastActivity`，其中状态为`running | idle | parked | aborted`。总线`task:subagent:lifecycle`提供`started | completed | failed | aborted`，并带`id/agent/index/parentToolCallId`等；`task:subagent:progress`中的状态为`pending | running | completed | failed | aborted`。

两套状态不是同一枚举：`idle`是活着但已结束当前工作的Agent，`parked`保留引用和历史而会话已释放；它们都不能算作正在执行。单独的Agent快照没有`failed`或`completed`结果字段，不能由`parked`推断成功。生命周期/进度流能补结果，但已结束回合的遗漏事件能否从重连快照完整恢复，当前字段不足以保证。

只读view链接禁止提示、打断和Agent控制，却仍允许读取完整历史、实时文本及子代理正文。连接时主机发送`welcome`和`snapshot-chunk`，之后有`entry/event/state/bus/agents`；本次核对的协议没有“仅订阅生命周期、不传正文”的握手字段。因此view权限不等于元数据最小读取，不适合直接用于OC Chan当前只读观察边界。

房间归属于会话，切换会话会结束旧房间并轮转；旧链接不会转入新会话。自动托管可在断线/积压终止后建立新代房间，来宾需要重新加入和同步。协议中的子代理生命周期没有单独`runId`、顺序号或断点续传游标；重连不能只沿用旧Agent id和最后一次running状态。房间`generation`也不是每个子代理执行轮次的generation。

### RPC：子代理事件完整度更高，入口是新启动的受控进程

入口`omp --mode rpc`使用stdin/stdout JSONL；公开文档未提供把它附着到任意已经运行的交互式OMP进程的方式。它适合由调用者启动并管理的会话，不自动覆盖当前所有Tern/终端中的会话。

`set_subagent_subscription`默认off，progress订阅发送生命周期和进度，events还发送完整子代理事件。`get_subagents`返回按index/id排序的快照：`id/index/agent/agentSource/description/status/task/assignment/sessionFile/lastUpdate/progress/parentToolCallId`。`parentToolCallId`是工具调用身份，不等同显式父Agent id；任务说明、路径和progress中的参数/最近输出属于正文或敏感内容，不能原样收集。

主会话有`agent_start/agent_end`、`prompt_result`和`session_settled`。`prompt_result.status`可区分completed/aborted/error，但`sessionSettled=false`时后台工作仍可唤醒会话；`agent_end.isTerminal=false`也不是最终结束。`get_state`提供`isSettled/hasPendingAsyncWork`，可以核对当前静止状态。不能把每一次`agent_end`或一瞬间idle解释为整项工作已完成。

`set_event_filter`只过滤会话事件，并不统一过滤响应、prompt_result、session_settled或子代理帧。即使选progress，也不是经过白名单投影的无正文通道。物理输出帧上限1MiB；协商v2后可分块重组至64MiB，超限有明确错误。对OC Chan而言仍需更低的自身预算和背压，不能直接把协议最大值当作内存预算。

stdout必须持续被读取；背压会转存临时文件，文档明确该磁盘积压可持续增长。关闭stdin会触发会话释放，不是无损重连操作。此次核对的RPC合同没有面向外部观察者的事件重放游标或跨进程重接管保证；不能将重启的新RPC实例当作旧实例状态连续。

### SDK：有直接状态，但需要成为运行时宿主

`createAgentSession`、`session.subscribe`及公开`AgentRegistry`可在同一Bun进程读取身份、`parentId`、`running/idle/parked/aborted`及注册/状态改变/移除事件。Registry还记录每轮`responseAt/acceptedAt/terminalAt`；重新进入running会清除上一轮里程碑，取消的引用不能被迟到更新复活。

这证明OMP内部可以区分驻留和执行，不证明OC Chan已能从外部读取。SDK创建/管理会话、Hook或进程注入都会改变当前集成边界，本期不执行。SDK完整对象包含session和历史路径，未来若获授权也只应发布必要的元数据投影。

## 状态映射与身份要求

- start：RPC/Collab生命周期`started`，或SDK registered；registered默认running是实现行为，不能代替已开始模型请求的证据。
- working：子代理进度running或Registry running表示该运行时定义的执行状态；主Host busy表示回合进行中。两者不能互换，也不能用CPU、进程存活、lease或keepAlive补出缺失状态。
- idle：Registry idle/parked均不计入当前活动；Host busy=false只能解释主回合暂未运行。未知保持未知。
- completed：明确的子代理completed事件/进度；单独idle/parked不提供成功结果。主prompt completed与会话settled需分开。
- cancel/error：明确aborted或failed事件/进度；主prompt_result用aborted/error。断线、Host消失或来源读取失败保持不可用，不改成取消/失败/0。
- 父子和去重：进程身份、会话身份、房间代际和Agent id都需保留作用域；Collab/SDK有parentId，RPC快照当前只有parentToolCallId。子代理跨轮复用与重连时的完整结果恢复仍需上游明确run身份/版本或新的可恢复元数据快照，不能仅按名字拼接推断。

## 合成协议示例

以下是依照公开类型编写的最小字段投影，全部身份、PID和内容为合成数据，不是读取后脱敏的真实会话，不是完整服务器响应或可运行适配器。

```json
{
  "instanceId": "example-host-01",
  "generation": 3,
  "pid": 10001,
  "sessionId": "example-session",
  "relayConnected": true,
  "busy": true
}
```

```json
{
  "type": "subagent_lifecycle",
  "payload": {
    "id": "ExampleWorker",
    "agent": "scout",
    "index": 0,
    "parentToolCallId": "example-call",
    "status": "completed"
  }
}
```

## 本期结论和后续条件

本期调研已取得可定位公开证据，F-07功能未实施、未验收。建议未来优先确认上游能否提供面向既有本机会话的、经授权的只读元数据快照/事件接口：覆盖Agent父子身份、每轮执行身份、结果、来源完整性，以及断线后恢复语义。现有Collab发现可作为Host元数据参考，但不补齐子代理数量；连接共享正文流、启动受控RPC或宿主SDK属于不同产品方案，需要用户重新明确实施范围。

未验证真实运行/完成驻留/取消/失败/失联序列，未制作运行时fixture，也未将文档字段当作本机功能已启用。未来恢复实施后，按F-07原验收条件逐项验证并纳入A-02插件、取消及全局资源预算；本期不增加兼容路径或猜测活动数。
