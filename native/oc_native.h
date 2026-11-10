#ifndef OC_NATIVE_H
#define OC_NATIVE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* macOS C ABI. Objective-C++17/ARC, deployment >=13, SDK >=26.
 * Build: cargo build --manifest-path native/Cargo.toml
 * The integrating crate can use oc-native-bridge as a path dependency; build.rs
 * links AppKit/Foundation/IOKit/ServiceManagement/UserNotifications/Carbon.
 * It also resolves and statically links the selected C++ compiler's macOS
 * compiler-rt archive for @available guards, including release builds with LTO.
 * Only oc_native.mm is compiled; oc_notifications.inc/oc_exports.inc are included.
 * This source does NOT contain the acceptance eval/socket driver.
 *
 * All entry points except string_free MUST run on the AppKit main thread.
 * All callbacks run on that same thread and MUST NOT unwind/panic or reenter.
 * Callback JSON is borrowed for callback duration. Caller owns userdata until
 * successful release. Inputs are borrowed NUL-terminated UTF-8 (args <=256KiB,
 * command <=64 bytes). All char** outputs are malloc-owned; use string_free.
 * Result JSON <=64KiB. Status 0 = success/accepted, -1 = explicit error.
 * Unknown commands, invalid types, OS errors and unsupported APIs are errors.
 * Error output is "<stage>\n<raw OS reason>"; stage is a fixed bridge label.
 * The host exposes only allowlisted operation/stage labels and error categories;
 * raw OS reasons must never enter IPC or logs.
 * Create requires the host's NSApplication subclass to be initialized first
 * (Tauri setup, after Tao creates TaoApp); the bridge never creates NSApplication.
 * Acceptance create and dockSet skip the policy setter when already at target;
 * actual policy is always read back. A requested change requires both setter
 * acceptance and matching readback; a failed mutation is never treated as success.
 * Notification operations require the real application bundle identity.
 *
 * One context per process, one OS request total, eight live notifications, 16
 * queued delegate events. Event overflow is reported as notificationEventOverflow.
 * Six fixed observers: appearance KVO, accessibility, sleep, wake, app launch, locale.
 * Loading creates no requests/listeners. Notification delegate installs lazily;
 * an existing delegate owned by another component is an explicit conflict.
 * Caller owns deadlines (query 2s/request 30s/send 3s recommended), then cancel.
 * Cancellation suppresses result delivery but emits operationSettled with the
 * original requestId after OS completion. OS slot and caller identity remain
 * occupied until then. Release rejects pending operations and retains context.
 * Request IDs must be >0 and strictly increasing per context.
 *
 * Events: {event,requestId,value} or {event,requestId,error}; requestId=0 for
 * observers/delegate events. permission returns {permission:"not-determined"|
 * "denied"|"authorized"|"provisional"}. operationFailed reports async exceptions.
 * systemChanged/applicationLaunched/systemSleeping/systemAwake include readback.
 * notificationAccepted means OS scheduling only, NOT visible delivery.
 * notificationPresented means willPresent delegate observation, NOT proof of a
 * displayed banner. notificationState reads OS pending/delivered identifiers.
 * notificationClicked includes action and original target; click revokes it.
 * Background banner visibility is not claimed from scheduling success.
 *
 * Release removes only this context's prefixed notifications, observers, delegate,
 * per-window glass and sleep assertion. Errors retain the handle for retry.
 * Success invalidates the handle and prevents all later caller callbacks.
 * Notification removals are OS requests. Cancelled entries retain their slots
 * until notificationState observes each absent from BOTH pending and delivered
 * lists. It returns {pending,delivered,revoking,owned}; these are sequential OS reads.
 * A timed-out/cancelled query retains all slots and cannot claim cancellation.
 * Release with notification entries requests revocation, returns an explicit
 * pending error and retains its handle. Query state asynchronously, then retry
 * release after confirmation. It never blocks waiting for the OS.
 * NSGlassEffectView is one associated view per window; intensity=0 releases it.
 *
 * loginRead uses SMAppService status. wasOpenedAtLogin is derived ONLY from the
 * current kAEOpenApplication event's keyAELaunchedAsLogInItem and retained when
 * observed at creation/app-launch/read. If no launch event was observed, it is
 * null and launchEventObserved=false; never guess from a parent process name.
 */
typedef struct oc_native_context oc_native_context;
typedef void (*oc_native_callback)(void *userdata, const char *json);
int oc_native_create(int acceptance_mode, oc_native_callback callback, void *userdata,
                     oc_native_context **out_context, char **error);
/* Synchronous commands, all args are JSON objects:
 * operationRead {} -> {osPending,requestId,authorizationPending}; used to confirm
 * start failure ownership. A scheduling exception may retain an OS request; no
 * caller identity or permit is released without this readback or its callback.
 * systemRead {} -> dark,appearance,reduceMotion,reduceTransparency,increaseContrast,
 *   invertColors,glassSupported,dockVisible,activationPolicy,preventSleep,systemLanguage.
 * systemLanguage is zh-CN/en resolved from the real first NSLocale preferred language
 * (one <=64-byte identifier); locale-change events trigger systemChanged readback.
 * themeSet {mode:"system"|"light"|"dark"} -> systemRead.
 * dockSet {visible:bool} -> actual activation-policy readback.
 * sleepSet {enabled:bool} -> actual IOPM assertion level readback.
 * loginRead {} -> status,openAtLogin,wasOpenedAtLogin,launchEventObserved,installed.
 * loginSet {enabled:bool} -> SMAppService mutation/readback; installed app required.
 * windowRead {window:<u64 NSWindow address>} -> visible,key,main,appActive,width,height.
 * glassSet {window:<address>,intensity:0..100,dark:bool} -> active,viewCount.
 *   NSWindow address is validated against NSApp.windows before dereference.
 * notificationRemove {id:string} -> {id,removalRequested:true}; no success claim
 *   about OS disappearance until notificationState readback confirms absence.
 * openReleaseNotes {url:string<=2048} -> {opened:true}; HTTPS fixed GitHub releases
 * authority/path only, no credentials/query/fragment. Non-acceptance only.
 * accessibilityRead {} -> {availability:"available",status:"authorized"|"not-authorized",details:null};
 * reads AXIsProcessTrusted without prompting. Non-acceptance only.
 * openPermissionSettings {target:"accessibility"|"notifications"} -> {opened:true};
 * opens only the fixed System Settings pane; non-acceptance only.
 * clipboardWrite {window,text} -> {copied:true}; prefer raw clipboard ABI to avoid
 * JSON expansion. Window must be live; host binds address to registered generation.
 * Acceptance rejects Dock/sleep/login mutation, clipboard, save panel, external
 * URL and notification request/send. Normal readback never prompts or focuses.
 * savePanel is explicit UI; it never writes a file. Core creates a new destination
 * without replacement. The host must cancel/revoke its owner before window removal.
 */
int oc_native_call(oc_native_context *context, const char *command, const char *args_json,
                   char **result_json, char **error);
/* Asynchronous commands:
 * permissionQuery {}; permissionRequest {} (explicit user action only).
 * notificationSend {id,title,body,target:<JSON object>} (silent; prior allowed query
 * required). Limits: id128/title1024/body4096 bytes, target8KiB. Duplicate IDs or
 * eight live/revoking entries reject explicitly; remove and confirm before adding.
 * notificationState {} -> owned pending/delivered IDs (max eight).
 * savePanel {window:<registered NSWindow address>} -> {path:string|null}.
 * Cancellation dismisses only this context's sheet; completion releases its slot.
 */
int oc_native_start(oc_native_context *context, uint64_t request_id, const char *command,
                    const char *args_json, char **error);
/* Returns {osPending,authorizationPending}; operationSettled confirms cancellation. */
int oc_native_cancel(oc_native_context *context, uint64_t request_id, char **result_json, char **error);
int oc_native_release(oc_native_context *context, char **error);
void oc_native_string_free(char *value);
/* Raw UTF-8 <=256KiB (no JSON expansion), live owned window, non-acceptance only. */
int oc_native_clipboard(oc_native_context *context, uint64_t window, const char *text, char **error);
#ifdef __cplusplus
}
#endif
#endif
