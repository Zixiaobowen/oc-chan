//! macOS physical-memory classification from the bounded vm_stat host response.
//! Swap bytes are supplied separately by the native kernel metadata request.
use oc_plugin_sdk::{Error, ErrorCode, Result, MAX_SAFE_INTEGER};

#[derive(Debug, Clone, PartialEq)]
pub struct SystemMemory {
    pub total: u64, pub active: u64, pub app: u64, pub wired: u64,
    pub compressed: u64, pub available: u64,
}
fn invalid(message: impl Into<String>) -> Error { Error::new(ErrorCode::Collect, message) }
pub fn parse_vm(vm: &str, total: u64) -> Result<SystemMemory> {
    if total == 0 || total > MAX_SAFE_INTEGER { return Err(invalid("物理内存总量无效")); }
    let page_size = vm.split_once("page size of ").and_then(|(_, rest)| rest.split_whitespace().next())
        .and_then(|n| n.parse::<u64>().ok()).filter(|n| *n > 0 && *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("vm_stat 未返回有效页大小"))?;
    let names = ["Anonymous pages", "Pages purgeable", "Pages wired down", "Pages occupied by compressor"];
    let mut counters: [Option<u64>; 4] = [None; 4];
    for line in vm.lines() {
        let Some((label, value)) = line.split_once(':') else { continue; };
        let Some(index) = names.iter().position(|name| *name == label.trim()) else { continue; };
        if counters[index].is_some() { return Err(invalid(format!("vm_stat 重复计数器 {}", names[index]))); }
        let number: &str = value.trim().strip_suffix('.').ok_or_else(|| invalid("vm_stat 计数格式无效"))?;
        if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) { return Err(invalid("vm_stat 计数无效")); }
        let n = number.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE_INTEGER).ok_or_else(|| invalid("vm_stat 计数超过安全范围"))?;
        counters[index] = Some(n);
    }
    let mut values = [0u64; 4];
    for (i, value) in counters.into_iter().enumerate() { values[i] = value.ok_or_else(|| invalid(format!("vm_stat 缺少 {}", names[i])))?; }
    let app = values[0].checked_sub(values[1]).and_then(|n| n.checked_mul(page_size)).filter(|n| *n <= total).ok_or_else(|| invalid("app 内存分项超出物理内存范围"))?;
    let wired = values[2].checked_mul(page_size).filter(|n| *n <= total).ok_or_else(|| invalid("wired 内存分项超出物理内存范围"))?;
    let compressed = values[3].checked_mul(page_size).filter(|n| *n <= total).ok_or_else(|| invalid("compressed 内存分项超出物理内存范围"))?;
    let active = app.checked_add(wired).and_then(|n| n.checked_add(compressed)).filter(|n| *n <= total).ok_or_else(|| invalid("内存使用量超出物理内存范围"))?;
    Ok(SystemMemory { total, active, app, wired, compressed, available: total - active })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn vm(page: u64) -> String { format!("Mach Virtual Memory Statistics: (page size of {page} bytes)\nAnonymous pages: 100.\nPages purgeable: 20.\nPages wired down: 40.\nPages occupied by compressor: 30.\n") }
    #[test] fn apple_silicon_page_size_and_purgeable_classification() {
        let m = parse_vm(&vm(16384), 1 << 30).unwrap();
        assert_eq!((m.app, m.wired, m.compressed, m.active), (80 * 16384, 40 * 16384, 30 * 16384, 150 * 16384));
        assert_eq!(m.available, (1 << 30) - m.active);
    }
    #[test] fn invalid_missing_negative_overflow_and_zero_page_are_errors() {
        assert!(parse_vm(&vm(4096).replace("Anonymous pages: 100.\n", ""), 1 << 30).is_err());
        assert!(parse_vm(&vm(4096).replace("Pages purgeable: 20", "Pages purgeable: 200"), 1 << 30).is_err());
        assert!(parse_vm(&vm(0), 1 << 30).is_err());
        assert!(parse_vm(&vm(4096), 1).is_err());
        assert!(parse_vm(&vm(4096).replace("100.", "9007199254740992."), 1 << 30).is_err());
    }
    #[test] fn full_memory_has_zero_available_bytes() {
        let m = parse_vm(&vm(4096), 150 * 4096).unwrap();
        assert_eq!(m.available, 0);
    }
}
