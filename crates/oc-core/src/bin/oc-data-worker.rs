fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let result = match (arguments.next(), arguments.next()) {
        (None, None) => oc_core::worker::run_stdio(),
        (Some(mode), None) if mode == "--http" => oc_core::http::run_worker(),
        _ => Err(oc_core::error::Error::invalid("worker arguments")),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
