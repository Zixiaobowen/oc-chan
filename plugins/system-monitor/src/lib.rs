//! Official system monitor plugin. Collection is performed by the host on request;
//! this crate only parses and reduces the bounded results it receives.
pub mod collector;
pub mod memory;
pub mod network;
pub mod processes;
pub use collector::SystemCollector;
