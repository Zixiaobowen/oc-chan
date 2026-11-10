//! `route -n get default` and `netstat -bdnI <iface>` parsing. Counter rows are
//! validated structurally; missing or unsafe counters are errors, never zero.
use oc_plugin_sdk::{Error, ErrorCode, Result, MAX_SAFE_INTEGER};

fn invalid(message: impl Into<String>) -> Error { Error::new(ErrorCode::Collect, message) }
pub fn parse_default_interface(output: &str) -> Result<String> {
    if output.len() > 64 * 1024 { return Err(Error::new(ErrorCode::Limit, "默认路由输出超过限制")); }
    let mut matches = output.lines().filter_map(|line| line.trim().strip_prefix("interface:").map(str::trim));
    let iface = matches.next().ok_or_else(|| invalid("没有可用的默认网络接口"))?;
    if matches.next().is_some() { return Err(invalid("默认网络接口不唯一")); }
    if iface.len() > 32 || !iface.chars().next().is_some_and(|c| c.is_ascii_lowercase()) || !iface.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._:-".contains(c)) { return Err(invalid("默认网络接口名称无效")); }
    Ok(iface.to_string())
}
pub fn parse_network_counters(output: &str, iface: &str) -> Result<(u64, u64)> {
    if output.len() > 64 * 1024 { return Err(Error::new(ErrorCode::Limit, "网络统计输出超过限制")); }
    let mut lines = output.lines().map(str::trim).filter(|l| !l.is_empty());
    let header = lines.next().ok_or_else(|| invalid("网络统计表结构无法识别"))?;
    let headers: Vec<&str> = header.split_whitespace().collect();
    if headers.first() != Some(&"Name") || headers.get(2) != Some(&"Network") { return Err(invalid("网络统计表结构无法识别")); }
    let rx = headers.iter().position(|h| *h == "Ibytes").ok_or_else(|| invalid("网络统计表结构无法识别"))?;
    let tx = headers.iter().position(|h| *h == "Obytes").ok_or_else(|| invalid("网络统计表结构无法识别"))?;
    if rx < 3 || tx <= rx { return Err(invalid("网络统计表结构无法识别")); }
    let mut counters = None;
    for line in lines {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let Some(name) = fields.first() else { continue; };
        let link = fields.get(2).is_some_and(|value| value.strip_prefix("<Link#").and_then(|value| value.strip_suffix('>')).is_some_and(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())))
            && (*name == iface || name.strip_suffix('*') == Some(iface));
        if !link { continue; }
        if counters.is_some() || fields.len() < headers.len() - 1 || fields.len() > headers.len() { return Err(invalid("网络接口统计行不完整或重复")); }
        let missing_address = headers.len() - fields.len();
        let at = |i: usize| fields[i - missing_address];
        let parse = |s: &str| -> Result<u64> {
            if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) { return Err(invalid("网络接口计数器无效")); }
            s.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE_INTEGER).ok_or_else(|| invalid("网络接口计数器超过安全范围"))
        };
        counters = Some((parse(at(rx))?, parse(at(tx))?));
    }
    counters.ok_or_else(|| invalid("网络接口未返回链路计数器"))
}
#[cfg(test)]
mod tests {
    use super::*;
    const H: &str = "Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll Drop";
    fn row(iface: &str, rx: u64, tx: u64, addr: &str) -> String { format!("{iface} 1500 <Link#1> {addr} 1 0 {rx} 1 0 {tx} 0 0\n") }
    #[test] fn selected_link_row_parses_both_counters() {
        assert_eq!(parse_network_counters(&format!("{H}\n{}", row("en0", 100, 50, "aa:bb:cc:dd:ee:ff")), "en0").unwrap(), (100, 50));
        assert_eq!(parse_network_counters(&format!("{H}\n{}", row("utun3", 1, 2, "")), "utun3").unwrap(), (1, 2));
        assert_eq!(parse_network_counters(&format!("{}\nen0 1500 <Link#1> aa 1 0 9 1 0 4 0\n", H.replace(" Drop", "")), "en0").unwrap(), (9, 4));
    }
    #[test] fn other_interfaces_and_non_link_rows_are_ignored() {
        let out = format!("{H}\n{}\n{}", row("en0", 10, 20, "aa"), "lo0 16384 <Link#1> 0 0 0 0 0 0 0 0");
        assert_eq!(parse_network_counters(&out, "en0").unwrap(), (10, 20));
    }
    #[test] fn missing_duplicate_unsafe_and_ambiguous_fail() {
        assert!(parse_network_counters(H, "en0").is_err());
        assert!(parse_network_counters(&format!("{H}\n{}{}", row("en0", 1, 2, "aa"), row("en0", 1, 2, "bb")), "en0").is_err());
        assert!(parse_network_counters(&format!("{H}\n{}", row("en0", u64::MAX, 2, "aa")), "en0").is_err());
        assert!(parse_network_counters(&format!("{H}\nen0 1500 <Link#1> aa 1 0 x 1 0 2 0 0\n"), "en0").is_err());
    }
    #[test] fn default_interface_rules() {
        assert_eq!(parse_default_interface("  interface: en0\n").unwrap(), "en0");
        assert!(parse_default_interface("interface: en0\ninterface: en1\n").is_err());
        assert!(parse_default_interface("interface: 1en0\n").is_err());
        assert!(parse_default_interface("no route\n").is_err());
    }
}
