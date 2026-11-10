use std::path::PathBuf;

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).take(4).collect();
    let result = if arguments.len() == 2 && arguments[0] == "--handoff" {
        oc_installer::run_handoff(&PathBuf::from(&arguments[1]))
    } else {
        Err(oc_installer::Error::Rejected("usage: oc-installer --handoff <controlled-transaction/handoff.json>".into()))
    };
    if let Err(error) = result {
        eprintln!("oc-installer: {error}");
        std::process::exit(1);
    }
}
