mod host;
mod host_io;
mod registry;

pub use host::{NativePlugin, NativePluginSpec};
pub use registry::*;

use std::{future::Future, pin::Pin};
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[cfg(test)]
mod tests;
