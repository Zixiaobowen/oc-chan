use oc_core::{model::*, settings::*, marketplace};
use crate::updates;

pub(super) trait UiLabel {
    fn labels(self) -> (&'static str, &'static str);
}
macro_rules! labels {
    ($ty:ty { $($variant:ident => ($zh:literal, $en:literal)),+ $(,)? }) => {
        impl UiLabel for $ty {
            fn labels(self) -> (&'static str, &'static str) {
                match self { $(Self::$variant => ($zh, $en)),+ }
            }
        }
    };
}
labels!(AgentKind { Main => ("主 Agent", "Main agent"), Subagent => ("子代理", "Subagent") });
labels!(AgentState { Working => ("工作中", "Working"), Idle => ("空闲", "Idle"), Running => ("进程运行中", "Process running"), Unknown => ("未知", "Unknown") });
labels!(ActivityKind { Tool => ("工具调用", "Tool call"), Model => ("模型调用", "Model call") });
labels!(JobState { Running => ("运行中", "Running"), Waiting => ("等待中", "Waiting"), Disabled => ("已停用", "Disabled"), Unloaded => ("未加载", "Unloaded"), Unknown => ("未知", "Unknown") });
labels!(JobStateReason { HermesReadFailed => ("无法读取 Hermes 状态", "Unable to read Hermes state"), HermesDispatching => ("Hermes 正在分派", "Hermes dispatching"), HermesUnconfirmed => ("Hermes 状态未确认", "Hermes state unconfirmed"), HermesStateUnsupported => ("不支持的 Hermes 状态", "Unsupported Hermes state") });
labels!(JobScope { User => ("当前用户", "Current user"), System => ("系统", "System") });
labels!(JobOrigin { Personal => ("个人配置", "Personal configuration"), System => ("系统", "System"), Application => ("应用程序", "Application"), Unknown => ("未知", "Unknown") });
labels!(RunResult { Succeeded => ("执行成功", "Succeeded"), Failed => ("执行失败", "Execution failed"), DeliveryFailed => ("投递失败", "Delivery failed"), Blocked => ("执行受阻", "Blocked"), Unknown => ("未知", "Unknown") });
labels!(ExecutionStatus { Claimed => ("已领取", "Claimed"), Running => ("执行中", "Running"), Succeeded => ("执行成功", "Succeeded"), Failed => ("执行失败", "Failed"), Unknown => ("未知", "Unknown") });
labels!(DeliveryStatus { Delivered => ("已投递", "Delivered"), Failed => ("投递失败", "Delivery failed"), Skipped => ("已跳过投递", "Delivery skipped"), Unknown => ("投递状态未知", "Delivery unknown") });
impl UiLabel for Option<DeliveryStatus> {
    fn labels(self) -> (&'static str, &'static str) { self.map(UiLabel::labels).unwrap_or(("无投递记录", "No delivery record")) }
}
impl UiLabel for Option<JobStateReason> {
    fn labels(self) -> (&'static str, &'static str) { self.map(UiLabel::labels).unwrap_or(("无补充说明", "No additional detail")) }
}
labels!(SourceState { Ok => ("正常", "Healthy"), Empty => ("无数据", "Empty"), Partial => ("数据不完整", "Partial data"), Error => ("采集失败", "Collection failed"), Unsupported => ("不支持", "Unsupported"), Disabled => ("已停用", "Disabled") });
labels!(CoverageState { Baseline => ("建立基线", "Establishing baseline"), Observing => ("观察中", "Observing"), CatchingUp => ("补采中", "Catching up"), Gap => ("存在断档", "Coverage gap"), Disabled => ("已停用", "Disabled"), Unavailable => ("不可用", "Unavailable") });
labels!(LocalEventType { ExecutionFailed => ("执行失败", "Execution failed"), DeliveryFailed => ("投递失败", "Delivery failed"), SourceUnavailable => ("来源不可用", "Source unavailable"), SourceRecovered => ("来源恢复", "Source recovered") });
labels!(MonitorSection { Agents => ("Agent", "Agents"), Schedules => ("定时任务", "Schedules"), System => ("系统监控", "System monitoring"), Events => ("事件", "Events") });
labels!(marketplace::Action { Install => ("安装", "Install"), Update => ("更新", "Update"), Uninstall => ("卸载", "Uninstall") });
labels!(marketplace::Phase { Downloading => ("下载中", "Downloading"), Verifying => ("校验中", "Verifying"), Activating => ("激活中", "Activating"), Removing => ("卸载中", "Removing") });
labels!(marketplace::Source { Bundled => ("随附离线包", "Bundled package"), Online => ("在线目录", "Online catalog"), Installed => ("本机已安装", "Installed locally") });
labels!(updates::UpdatePhase { Idle => ("等待检查", "Ready to check"), Checking => ("检查中", "Checking"), NoUpdate => ("没有适用更新", "No applicable update"), Available => ("有可用更新", "Update available"), Downloading => ("下载中", "Downloading"), Downloaded => ("下载完成", "Downloaded"), Extracting => ("解压中", "Extracting"), ReadyToInstall => ("准备安装", "Ready to install"), Installing => ("安装中", "Installing"), AwaitingQuit => ("正在结束业务后重启", "Draining work before restart"), Cancelled => ("已取消", "Cancelled"), Error => ("更新失败", "Update failed") });
labels!(LoginAvailability { Available => ("可用", "Available"), Development => ("开发版本不可用", "Unavailable in development builds"), NotInstalled => ("应用尚未安装", "Application not installed"), Unsupported => ("当前平台不支持", "Unsupported on this platform") });
labels!(LoginStatus { NotRegistered => ("未注册登录项", "Login item not registered"), Enabled => ("已启用", "Enabled"), RequiresApproval => ("需要系统批准", "System approval required"), NotFound => ("未找到登录项", "Login item not found"), Unknown => ("未知", "Unknown") });
labels!(SourceDiagnosticOperation { Services => ("services", "services"), Disabled => ("disabled", "disabled") });
labels!(SourceDiagnosticStage { Command => ("command", "command"), Timeout => ("timeout", "timeout"), Permission => ("permission", "permission"), Structure => ("structure", "structure"), Row => ("row", "row"), Limit => ("limit", "limit"), Queue => ("queue", "queue") });
labels!(SourceDiagnosticCode { CommandFailed => ("command-failed", "command-failed"), PermissionDenied => ("permission-denied", "permission-denied"), TimedOut => ("timed-out", "timed-out"), CommandMissing => ("command-missing", "command-missing"), OutputLimit => ("output-limit", "output-limit"), EntryLimit => ("entry-limit", "entry-limit"), MissingTable => ("missing-table", "missing-table"), InvalidRow => ("invalid-row", "invalid-row"), ResourceLimit => ("resource-limit", "resource-limit"), QueueTimeout => ("queue-timeout", "queue-timeout") });
labels!(NotificationPhase { Off => ("通知已关闭", "Notifications off"), EventsDisabled => ("事件采集已停用", "Event collection disabled"), Starting => ("启动中", "Starting"), Ready => ("已就绪", "Ready"), Quiet => ("静默时段", "Quiet hours"), Sleeping => ("休眠中", "Sleeping"), PermissionRequired => ("需要通知权限", "Notification permission required"), Denied => ("通知权限被拒绝", "Notification permission denied"), Unavailable => ("通知不可用", "Notifications unavailable"), Error => ("通知出错", "Notification error") });
labels!(NotificationPermission { NotDetermined => ("尚未授权", "Not yet requested"), Denied => ("已拒绝", "Denied"), Authorized => ("已授权", "Authorized"), Provisional => ("临时授权", "Provisional authorization"), Unsupported => ("不支持", "Unsupported"), Unknown => ("未知", "Unknown") });

pub(super) fn permission_labels(permission: &str) -> (&str, &str) {
    match permission {
        "system-metrics" => ("读取系统资源指标", "Read system resource metrics"),
        "process-ranking" => ("读取进程资源排行", "Read process resource rankings"),
        "read-default-network-interface" => ("读取默认网卡信息", "Read default network interface"),
        unknown => (unknown, unknown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_and_absent_statuses_remain_distinct() {
        assert_eq!(AgentState::Unknown.labels(), ("未知", "Unknown"));
        assert_eq!(ExecutionStatus::Unknown.labels(), ("未知", "Unknown"));
        assert_eq!(None::<DeliveryStatus>.labels(), ("无投递记录", "No delivery record"));
        assert_eq!(Some(DeliveryStatus::Unknown).labels(), ("投递状态未知", "Delivery unknown"));
        assert_eq!(None::<JobStateReason>.labels(), ("无补充说明", "No additional detail"));
        assert_eq!(permission_labels("future-permission"), ("future-permission", "future-permission"));
    }
    #[test]
    fn typed_statuses_have_chinese_and_english_labels() {
        assert_eq!(AgentState::Idle.labels(), ("空闲", "Idle"));
        assert_eq!(updates::UpdatePhase::Idle.labels(), ("等待检查", "Ready to check"));
        assert_eq!(LoginAvailability::Development.labels(), ("开发版本不可用", "Unavailable in development builds"));
        assert_eq!(JobState::Running.labels(), ("运行中", "Running"));
        assert_eq!(Some(DeliveryStatus::Delivered).labels(), ("已投递", "Delivered"));
        assert_eq!(LocalEventType::DeliveryFailed.labels(), ("投递失败", "Delivery failed"));
        assert_eq!(NotificationPermission::Authorized.labels(), ("已授权", "Authorized"));
        assert_eq!(marketplace::Action::Uninstall.labels(), ("卸载", "Uninstall"));
        assert_eq!(permission_labels("system-metrics"), ("读取系统资源指标", "Read system resource metrics"));
    }
}
