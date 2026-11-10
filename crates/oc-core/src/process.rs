use serde::{Deserialize, Serialize};
use crate::error::{Error, Result};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity { pub pid: u32, pub start_seconds: u64, pub start_microseconds: u64, pub process_group: u32 }
impl ProcessIdentity {
    pub fn read(pid: u32) -> Result<Self> {
        if pid == 0 || pid > i32::MAX as u32 { return Err(Error::invalid("pid")); }
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let expected = std::mem::size_of::<libc::proc_bsdinfo>();
        let read = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), expected as i32) };
        if read != expected as i32 { return Err(Error::io("process identity", std::io::Error::last_os_error())); }
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != pid { return Err(Error::new("OC_PROCESS_IDENTITY", "进程身份不匹配 / Process identity mismatch")); }
        Ok(Self { pid, start_seconds: info.pbi_start_tvsec, start_microseconds: info.pbi_start_tvusec, process_group: info.pbi_pgid })
    }
    pub fn matches_live(&self) -> bool { Self::read(self.pid).is_ok_and(|current| current == *self) }
    pub fn started_at(&self) -> Result<String> {
        chrono::DateTime::from_timestamp(self.start_seconds as i64, (self.start_microseconds as u32) * 1000)
            .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .ok_or_else(|| Error::new("OC_PROCESS_IDENTITY", "进程启动时间无效 / Invalid process birth time"))
    }
}
