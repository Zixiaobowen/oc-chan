//! Raw macOS C ABI. See `native/oc_native.h` for JSON commands and ownership.
//! Every operation except string_free requires AppKit's main thread. Do not
//! unwind or reenter the bridge from Callback. This crate grants no IPC rights.
use std::ffi::{c_char, c_int, c_void};
#[repr(C)]
pub struct Context { _private: [u8; 0] }
pub type Callback = unsafe extern "C" fn(userdata: *mut c_void, json: *const c_char);
extern "C" {
    pub fn oc_native_create(acceptance_mode: c_int, callback: Callback, userdata: *mut c_void, context: *mut *mut Context, error: *mut *mut c_char) -> c_int;
    pub fn oc_native_call(context: *mut Context, command: *const c_char, args_json: *const c_char, result_json: *mut *mut c_char, error: *mut *mut c_char) -> c_int;
    pub fn oc_native_start(context: *mut Context, request_id: u64, command: *const c_char, args_json: *const c_char, error: *mut *mut c_char) -> c_int;
    pub fn oc_native_cancel(context: *mut Context, request_id: u64, result_json: *mut *mut c_char, error: *mut *mut c_char) -> c_int;
    pub fn oc_native_release(context: *mut Context, error: *mut *mut c_char) -> c_int;
    pub fn oc_native_clipboard(context: *mut Context, window: u64, text: *const c_char, error: *mut *mut c_char) -> c_int;
    pub fn oc_native_string_free(value: *mut c_char);
}
