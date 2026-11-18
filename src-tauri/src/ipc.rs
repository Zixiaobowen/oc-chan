use std::{io::{self, Write}, sync::Arc};
use oc_core::error::{Error, Result};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use tauri::{Manager, ipc::{Invoke, InvokeBody, InvokeError, InvokeResponseBody}};
use crate::{api::{self, View}, host::Host};

const INPUT_LIMIT: usize = 128 * 1024;
pub(crate) const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

struct Limited { bytes: Vec<u8>, limit: usize }
impl Write for Limited {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) { return Err(io::Error::other("desktop response exceeds budget")); }
        self.bytes.extend_from_slice(bytes); Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}
pub fn serialized<T: Serialize + ?Sized>(value: &T) -> Result<String> {
    let mut output = Limited { bytes: Vec::with_capacity(4096), limit: OUTPUT_LIMIT };
    serde_json::to_writer(&mut output, value).map_err(|_| Error::new("OC_IPC_RESPONSE", "桌面响应序列化失败或超过8MiB / Desktop response serialization failed or exceeds 8MiB"))?;
    String::from_utf8(output.bytes).map_err(|_| Error::invalid("desktop response encoding"))
}
pub fn reply<T: Serialize + ?Sized>(value: &T) -> Result<InvokeResponseBody> { Ok(InvokeResponseBody::Json(serialized(value)?)) }
pub fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::invalid("desktop command parameters"))
}
pub fn empty(value: &Value) -> Result<()> {
    if value.as_object().is_some_and(|map| map.is_empty()) { Ok(()) } else { Err(Error::invalid("unexpected desktop command parameters")) }
}
fn bound(value: &Value, depth: usize, nodes: &mut usize, bytes: &mut usize) -> Result<()> {
    *nodes += 1;
    if depth > 8 || *nodes > 4096 { return Err(Error::invalid("desktop request nesting or items")); }
    match value {
        Value::String(text) => *bytes = bytes.checked_add(text.len()).ok_or_else(|| Error::invalid("desktop request size"))?,
        Value::Array(items) => for item in items { bound(item, depth + 1, nodes, bytes)?; },
        Value::Object(map) => for (key, item) in map {
            *bytes = bytes.checked_add(key.len()).ok_or_else(|| Error::invalid("desktop request size"))?;
            bound(item, depth + 1, nodes, bytes)?;
        },
        _ => *bytes += 16,
    }
    if *bytes > INPUT_LIMIT { return Err(Error::limit("desktop request", INPUT_LIMIT, *bytes)); }
    Ok(())
}

pub fn handle(invoke: Invoke<tauri::Wry>) -> bool {
    let command = invoke.message.command();
    if !api::COMMANDS.iter().any(|(name, _)| *name == command) { return false; }
    let authorized = (|| {
        if invoke.acl.is_none() { return Err(Error::invalid("desktop capability")); }
        let webview = invoke.message.webview();
        let view = View::from_label(webview.label()).ok_or_else(|| Error::invalid("desktop window"))?;
        if !api::permits(view, command) { return Err(Error::new("OC_IPC_DENIED", "窗口无权调用该操作 / This window cannot invoke this operation")); }
        let url = webview.url().map_err(|_| Error::invalid("desktop document URL"))?;
        let expected = match view { View::Main => "view=main", View::Tray => "view=tray", View::Recovery => "view=recovery" };
        if url.scheme() != "tauri" || url.host_str() != Some("localhost") || url.path() != "/index.html" || url.query() != Some(expected) || url.fragment().is_some() {
            return Err(Error::invalid("desktop document source"));
        }
        let key = invoke.message.headers().get("x-oc-document").and_then(|value| value.to_str().ok()).ok_or_else(|| Error::invalid("desktop document key"))?;
        if key.len() != 36 || uuid::Uuid::parse_str(key).is_err() { return Err(Error::invalid("desktop document key")); }
        let InvokeBody::Json(body) = invoke.message.payload() else { return Err(Error::invalid("desktop request body")); };
        if !body.is_object() { return Err(Error::invalid("desktop request body")); }
        bound(body, 0, &mut 0, &mut 0)?;
        let host = webview.state::<Arc<Host>>().inner().clone();
        let permit = host.admit(command)?;
        let task = host.requests.token();
        Ok((host, permit, task, view, key.to_owned(), command.to_owned(), body.clone()))
    })();
    match authorized {
        Err(error) => invoke.resolver.reject(error),
        Ok((host, permit, task, view, key, command, body)) => invoke.resolver.respond_async_serialized(async move {
            let (_permit, _task) = (permit, task);
            host.invoke(view, &key, &command, body).await.map_err(InvokeError::from)
        }),
    }
    true
}
