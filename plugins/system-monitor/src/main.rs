use oc_plugin_sdk::run_stdio;
use oc_system_monitor::SystemCollector;

fn main() {
    if let Err(error) = run_stdio(SystemCollector::new()) {
        eprintln!("oc-system-monitor: {error}");
        std::process::exit(1);
    }
}
