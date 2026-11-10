use std::{collections::{BTreeMap, BTreeSet}, path::Path, time::Duration};
use crate::{error::{Error, Result, check_cancel}, io::{BoundedIo, CommandSpec}, model::{AgentInfo, AgentKind, AgentState}, process::ProcessIdentity};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub(super) struct ProcessRow {
    pub pid: u32, pub ppid: u32, pub executable: String, pub args: String,
    pub cpu: f64, pub memory: u64,
}
#[derive(Clone, Debug)]
pub(super) struct Runtime { pub name: &'static str, pub wrapper: bool, pub host: bool }
fn base(value: &str) -> &str { value.rsplit('/').next().unwrap_or(value) }
fn interpreter(name: &str) -> bool {
    matches!(name, "node" | "bun") || name.strip_prefix("node-").or_else(|| name.strip_prefix("bun-")).is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}
struct Tokens<'a>(&'a str);
impl<'a> Iterator for Tokens<'a> {
    type Item = &'a str;
    fn next(&mut self) -> Option<Self::Item> {
        let input = self.0.trim_start();
        if input.is_empty() { self.0 = ""; return None; }
        let mut quote = None; let mut escaped = false;
        for (index, ch) in input.char_indices() {
            if escaped { escaped = false; continue; }
            if ch == '\\' && quote != Some('\'') { escaped = true; continue; }
            if quote == Some(ch) { quote = None; continue; }
            if quote.is_none() && matches!(ch, '\'' | '"') { quote = Some(ch); continue; }
            if quote.is_none() && ch.is_whitespace() { self.0 = &input[index..]; return Some(&input[..index]); }
        }
        self.0 = ""; Some(input)
    }
}
fn command<'a>(runtime: &str, args: &'a str) -> Option<&'a str> {
    let (values, booleans, ambiguous) = match runtime {
        "OMP" => (
            "--model --smol --slow --plan --provider --api-key --profile --alias --cwd --mode --config --add-dir --session-dir --models --tools --thinking --service-tier --max-time --warn-cost --max-cost --approval-mode --skills --hook --extension -e --plugin-dir --plan-yolo-into --prewalk-into",
            "--continue -c --allow-home --prewalk --no-prewalk --plan-yolo --no-session --no-tools --no-lsp --no-pty --hide-thinking --advisor --wait-async --external-thinking --no-extensions --no-skills --no-rules --no-context-files --no-title --no-ui --print-thoughts --auto-approve",
            "-p --print --goal -r --resume --restore --system-prompt --append-system-prompt --system-prompt-template"),
        "Codex" => (
            "-c --config --enable --disable --remote --remote-auth-token-env -i --image -m --model --local-provider -p --profile -s --sandbox -C --cd --add-dir -a --ask-for-approval",
            "--strict-config --oss --approve-for-me --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --worktree --search --no-alt-screen --no-daemon --full-auto", ""),
        "Claude Code" => (
            "--model --agent --advisor --settings --setting-sources --permission-mode --output-format --input-format --effort --debug-file --session-id --plugin-dir --fallback-model",
            "--dangerously-skip-permissions --allow-dangerously-skip-permissions --verbose --debug --bare --strict-mcp-config --no-chrome",
            "-p --print -c --continue -r --resume --system-prompt --append-system-prompt --agents --name -n"),
        _ => ("--log-level --model -m --agent --port --hostname --mdns-domain --cors --session -s", "--print-logs --pure --continue -c --fork --auto --mdns", "--prompt"),
    };
    let has = |set: &str, value: &str| set.split_whitespace().any(|item| item == value);
    let mut parts = Tokens(args);
    while let Some(token) = parts.next() {
        if token == "--" { return None; }
        if matches!(token, "--help" | "-h" | "--version" | "-v" | "-V") { return Some("__help"); }
        if !token.starts_with('-') { return Some(token.trim_matches(['\'', '"'])); }
        let flag = token.split('=').next().unwrap_or(token);
        if has(ambiguous, flag) { return None; }
        if has(values, flag) { if !token.contains('=') { parts.next(); } continue; }
        if token.len() > 2 && !token.starts_with("--") && token.is_char_boundary(2) && has(values, &token[..2]) { continue; }
        if !has(booleans, token) { return None; }
    }
    None
}
pub(super) fn identify(row: &ProcessRow) -> Option<Runtime> {
    let name = base(&row.executable); let mut wrapper = false;
    let runtime = match name {
        "omp" => "OMP", "codex" => "Codex", "claude" => "Claude Code", "opencode" => "OpenCode",
        _ if row.executable.rsplit_once("/Tern/omp/versions/").is_some_and(|(_, version)| version.split('.').count() == 3 && version.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))) => "OMP",
        _ if interpreter(name) => {
            let entry = row.args.split_whitespace().nth(1)?; wrapper = true;
            if entry.ends_with("/@openai/codex/bin/codex.js") { "Codex" }
            else if entry.ends_with("/@anthropic-ai/claude-code/cli.js") { "Claude Code" }
            else if entry.ends_with("/opencode-ai/bin/opencode") || entry.rsplit_once("/@opencode-ai/").is_some_and(|(_, end)| end.split('/').count() == 3 && end.ends_with("/bin/opencode")) { "OpenCode" }
            else if entry.ends_with("/@oh-my-pi/pi-coding-agent/dist/cli.js") || entry.ends_with("/@oh-my-pi/pi-coding-agent/src/cli.ts") { "OMP" }
            else { return None; }
        },
        _ => return None,
    };
    if runtime == "OMP" && row.args.split_whitespace().next().is_some_and(|a| base(a).starts_with("__omp_worker_")) { return None; }
    let mut rest = row.args.strip_prefix(&row.executable).map(str::trim_start).unwrap_or_else(|| row.args.split_once(char::is_whitespace).map(|(_, s)| s.trim_start()).unwrap_or(""));
    if wrapper { rest = rest.split_once(char::is_whitespace).map(|(_, s)| s.trim_start()).unwrap_or(""); }
    let subcommand = command(runtime, rest);
    let excluded = match runtime {
        "OMP" => "agents anonymize auth auth-broker auth-gateway bench browser-relay clip collab completions compress config dry-balance find gallery gc git grep grievances images install login models play plugin predict ps read render say search session setup share shell skill stats stream tiny-models token toks ttsr update usage worktree daemon help",
        "Codex" => "agents exec-server mcp-server mcp plugin remote-control app login logout completion update doctor sandbox debug apply a queue archive delete migrate-rollouts migrate-nfs-db unarchive cloud features help",
        "Claude Code" => "mcp daemon gateway remote-control auth doctor update install plugin plugins setup-token self-hosted-runner agents logs stop kill rm purge auto-mode",
        _ => "serve web mcp auth completion models stats export import upgrade uninstall agent session",
    };
    if subcommand.is_some_and(|cmd| cmd == "__help" || (runtime == "OMP" && cmd.starts_with("__omp_worker_")) || excluded.split_whitespace().any(|word| word == cmd)) { return None; }
    Some(Runtime { name: runtime, wrapper, host: runtime == "Codex" && subcommand == Some("app-server") })
}

pub(super) async fn read_processes(io: &BoundedIo, cancel: &CancellationToken) -> Result<(Vec<ProcessRow>, BTreeMap<u32, ProcessIdentity>)> {
    let output = io.command("agent-processes", CommandSpec::new("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,rss=,comm="], 4 * 1024 * 1024, Duration::from_millis(1500)), cancel).await?.success()?;
    let mut rows = Vec::new();
    for line in output.stdout_text()?.lines() {
        // ps aligns numeric columns; consume whitespace explicitly without splitting executable paths.
        let mut rest = line.trim(); let mut numeric = [""; 4];
        for field in &mut numeric { let end = rest.find(char::is_whitespace).unwrap_or(rest.len()); *field = &rest[..end]; rest = rest[end..].trim_start(); }
        let (Ok(pid), Ok(ppid), Ok(cpu), Ok(rss)) = (numeric[0].parse::<u32>(), numeric[1].parse::<u32>(), numeric[2].parse::<f64>(), numeric[3].parse::<u64>()) else { continue; };
        if rest.is_empty() || !cpu.is_finite() { continue; }
        if rows.len() >= 4096 { return Err(Error::limit("process rows", 4096, rows.len() + 1)); }
        rows.push(ProcessRow { pid, ppid, executable: rest.into(), args: String::new(), cpu, memory: rss.saturating_mul(1024) });
    }
    if rows.is_empty() { return Err(Error::new("OC_PROCESS_TABLE", "无法解析 macOS 进程表 / Invalid process table")); }
    let candidates: BTreeSet<_> = rows.iter().filter(|row| identify(row).is_some() || interpreter(base(&row.executable))).map(|r| r.pid).collect();
    let mut identities: BTreeMap<_, _> = candidates.iter().filter_map(|pid| ProcessIdentity::read(*pid).ok().map(|identity| (*pid, identity))).collect();
    if !candidates.is_empty() {
        let pids = candidates.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let output = io.command("agent-processes", CommandSpec::new("/bin/ps", ["-ww", "-p", &pids, "-o", "pid=,args="], 2 * 1024 * 1024, Duration::from_millis(1500)), cancel).await?;
        if output.exit_code != 0 && output.exit_code != 1 { output.success()?; return Err(Error::new("OC_PROCESS_TABLE", "进程参数读取失败")); }
        for line in output.stdout_text()?.lines() {
            if let Some((pid, args)) = line.trim().split_once(char::is_whitespace) {
                if let Ok(pid) = pid.parse::<u32>() { if let Some(row) = rows.iter_mut().find(|r| r.pid == pid) { row.args = args.trim_start().into(); } }
            }
        }
    }
    identities.retain(|pid, identity| identity.matches_live() && rows.iter().any(|row| row.pid == *pid && !row.args.is_empty()));
    check_cancel(cancel)?; Ok((rows, identities))
}

pub(super) fn process_agents(rows: &[ProcessRow], identities: &BTreeMap<u32, ProcessIdentity>) -> (Vec<AgentInfo>, BTreeSet<u32>) {
    let matches: BTreeMap<_, _> = rows.iter().filter_map(|row| identify(row).filter(|_| identities.contains_key(&row.pid)).map(|runtime| (row.pid, (row, runtime)))).collect();
    let mut aliases = BTreeMap::new();
    for (pid, (row, runtime)) in &matches { if let Some((parent, p)) = matches.get(&row.ppid) { if p.wrapper && p.name == runtime.name && !runtime.wrapper { aliases.insert(parent.pid, *pid); } } }
    let by_pid: BTreeMap<_, _> = rows.iter().map(|r| (r.pid, r)).collect();
    let hosts = matches.iter().filter(|(_, (_, runtime))| runtime.host).map(|(pid, _)| *pid).collect();
    let agents = matches.iter().filter(|(pid, _)| !aliases.contains_key(*pid)).map(|(pid, (row, runtime))| {
        let mut seen = BTreeSet::from([*pid]); let mut ancestor = row.ppid; let mut parent_id = None;
        while ancestor > 1 && seen.insert(ancestor) {
            let canonical = *aliases.get(&ancestor).unwrap_or(&ancestor);
            if canonical != *pid && matches.contains_key(&canonical) { parent_id = Some(format!("process:{canonical}")); break; }
            ancestor = by_pid.get(&ancestor).map(|r| r.ppid).unwrap_or(0);
        }
        AgentInfo { id: format!("process:{pid}"), name: runtime.name.into(), summary: None, runtime: runtime.name.into(),
            kind: if parent_id.is_some() { AgentKind::Subagent } else { AgentKind::Main }, state: AgentState::Running,
            activity: None, pid: *pid, parent_id, model: None, cwd: None, session_id: None, tern: None,
            cpu_percent: Some(row.cpu), memory_bytes: Some(row.memory), started_at: identities.get(pid).and_then(|i| i.started_at().ok()),
            source: "macOS process table (executable + PID birth identity)".into() }
    }).collect();
    (agents, hosts)
}
pub(super) fn filename(path: &Path) -> &str { path.file_name().and_then(|p| p.to_str()).unwrap_or("") }
