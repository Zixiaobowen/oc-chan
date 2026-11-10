//! Bounded `ps -axo pid=,pcpu=,rss=,comm=` parsing into two top-ten rankings.
//! The full `comm` tail is retained through the last slash, as the original does.
use oc_plugin_sdk::{Error, ErrorCode, Result, MAX_SAFE_INTEGER};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo { pub pid: u64, pub name: String, pub cpu_percent: f64, pub memory_bytes: u64 }

#[derive(Debug, Default)]
pub struct ProcessRankings { pub cpu: Vec<ProcessInfo>, pub memory: Vec<ProcessInfo> }

fn invalid(message: impl Into<String>) -> Error { Error::new(ErrorCode::Collect, message) }
fn take_token(line: &str) -> Option<(&str, &str)> {
    let rest = line.trim_start(); let end = rest.find(char::is_whitespace)?;
    let token = &rest[..end]; let remainder = &rest[end..]; Some((token, remainder))
}
fn position(ranking: &[ProcessInfo], before: impl Fn(&ProcessInfo) -> bool) -> Option<usize> {
    ranking.iter().position(before).or_else(|| (ranking.len() < 10).then_some(ranking.len()))
}
fn insert(ranking: &mut Vec<ProcessInfo>, index: usize, process: ProcessInfo) {
    if ranking.len() == 10 { ranking.pop(); }
    ranking.insert(index, process);
}
pub fn parse_processes(output: &str) -> Result<ProcessRankings> {
    let mut rankings = ProcessRankings { cpu: Vec::with_capacity(10), memory: Vec::with_capacity(10) };
    for line in output.lines() {
        let mut rest = line.trim();
        if rest.is_empty() { continue; }
        let (pid, after_pid) = take_token(rest).ok_or_else(|| invalid("ps 输出行不完整"))?;
        let (cpu, after_cpu) = take_token(after_pid).ok_or_else(|| invalid("ps 输出行不完整"))?;
        let (rss, after_rss) = take_token(after_cpu).ok_or_else(|| invalid("ps 输出行不完整"))?;
        rest = after_rss;
        let pid = pid.parse::<u64>().ok().filter(|n| *n > 0 && *n <= MAX_SAFE_INTEGER).ok_or_else(|| invalid("ps 返回的进程指标无效"))?;
        let cpu = cpu.parse::<f64>().map_err(|_| invalid("ps 返回的进程指标无效"))?;
        if !cpu.is_finite() || cpu < 0.0 { return Err(invalid("ps 返回的进程指标无效")); }
        let memory = rss.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE_INTEGER).ok_or_else(|| invalid("ps 返回的进程指标无效"))?
            .checked_mul(1024).filter(|n| *n <= MAX_SAFE_INTEGER).ok_or_else(|| invalid("ps 返回的进程指标无效"))?;
        let full_name = rest.trim();
        let name = full_name.rsplit('/').next().unwrap_or(full_name);
        if name.is_empty() || name.len() > 1024 { return Err(invalid("ps 进程名称为空或超出 1024 字节预算")); }
        let cpu_index = position(&rankings.cpu, |b| b.cpu_percent < cpu || (b.cpu_percent == cpu && b.memory_bytes < memory));
        let memory_index = position(&rankings.memory, |b| b.memory_bytes < memory);
        match (cpu_index, memory_index) {
            (None, None) => (),
            (cpu_index, memory_index) => {
                let process = ProcessInfo { pid, name: name.to_owned(), cpu_percent: cpu, memory_bytes: memory };
                match (cpu_index, memory_index) {
                    (Some(c), Some(m)) => { insert(&mut rankings.cpu, c, process.clone()); insert(&mut rankings.memory, m, process); }
                    (Some(c), None) => insert(&mut rankings.cpu, c, process),
                    (None, Some(m)) => insert(&mut rankings.memory, m, process),
                    (None, None) => unreachable!(),
                }
            }
        }
    }
    Ok(rankings)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn many(n: usize) -> String { (1..=n).map(|i| format!("{i} {i}.0 {i} /bin/proc-{i}\n")).collect() }
    #[test] fn ten_rankings_hold_original_order_and_full_tail_name() {
        let rankings = parse_processes(&many(25)).unwrap();
        assert_eq!(rankings.cpu.len(), 10); assert_eq!(rankings.memory.len(), 10);
        assert_eq!(rankings.cpu[0].pid, 25); assert_eq!(rankings.memory[0].pid, 25);
        assert_eq!(rankings.cpu[0].name, "proc-25"); assert_eq!(rankings.memory[0].memory_bytes, 25 * 1024);
    }
    #[test] fn low_cpu_high_memory_process_kept_in_memory_ranking() {
        let out = "1 0.0 900 /bin/low\n2 90.0 1 /bin/high\n";
        let rankings = parse_processes(out).unwrap();
        assert_eq!(rankings.memory[0].pid, 1); assert_eq!(rankings.cpu[0].pid, 2);
    }
    #[test] fn invalid_metric_is_error_not_skip() {
        assert!(parse_processes("x 1 2 /bin/a").is_err());
        assert!(parse_processes("1 nope 2 /bin/a").is_err());
        assert!(parse_processes("1 2").is_err());
        assert!(parse_processes("1 -1 2 /bin/a").is_err());
        assert!(parse_processes(&format!("1 1 {} /bin/a", MAX_SAFE_INTEGER)).is_err());
        assert!(parse_processes(&format!("1 1 1 /bin/{}", "x".repeat(1025))).is_err());
    }
}
