#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

namespace {
struct Operation {
  uint32_t id = 0;
  bool cancelled = false;
  bool osPending = true;
  bool authorizationPending = false;
  bool finalized = false;
  napi_threadsafe_function callback = nullptr;
  const char *permission = "unknown";
  std::string error;
};

struct State {
  std::mutex mutex;
  bool stopping = false;
  uint32_t sequence = 0;
  std::shared_ptr<Operation> active;
};

struct CallbackContext {
  std::shared_ptr<State> state;
  std::shared_ptr<Operation> operation;
};

bool CheckNapi(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  if (status != napi_pending_exception) {
    const napi_extended_error_info *info = nullptr;
    napi_get_last_error_info(env, &info);
    napi_throw_error(env, nullptr, info && info->error_message ? info->error_message : "N-API operation failed");
  }
  return false;
}

// Caller holds state.mutex. Cancellation does not free the OS slot: Apple's
// completion block is not cancellable. Even a never-returning call retains at
// most one small native operation, with no JS callback after cancellation.
void Retire(const std::shared_ptr<State> &state, const std::shared_ptr<Operation> &operation) {
  if (!operation->osPending && operation->finalized && state->active == operation)
    state->active.reset();
}

void FinalizeCallback(napi_env, void *data, void *) {
  std::unique_ptr<CallbackContext> context(static_cast<CallbackContext *>(data));
  std::lock_guard<std::mutex> lock(context->state->mutex);
  context->operation->finalized = true;
  context->operation->callback = nullptr;
  Retire(context->state, context->operation);
}

void CallJS(napi_env env, napi_value callback, void *data, void *) {
  auto *context = static_cast<CallbackContext *>(data);
  if (!env || !callback) return;
  {
    std::lock_guard<std::mutex> lock(context->state->mutex);
    if (context->state->stopping || context->operation->cancelled) return;
  }
  const auto &operation = context->operation;
  napi_value args[2], receiver, result;
  if (!CheckNapi(env, napi_get_undefined(env, &receiver))) return;
  if (operation->error.empty()) {
    if (!CheckNapi(env, napi_get_null(env, &args[0]))) return;
  } else {
    napi_value message;
    if (!CheckNapi(env, napi_create_string_utf8(env, operation->error.c_str(), operation->error.size(), &message)) ||
        !CheckNapi(env, napi_create_error(env, nullptr, message, &args[0]))) return;
  }
  if (!CheckNapi(env, napi_create_string_utf8(env, operation->permission, NAPI_AUTO_LENGTH, &args[1]))) return;
  CheckNapi(env, napi_call_function(env, receiver, callback, 2, args, &result));
}

void Finish(const std::shared_ptr<State> &state, const std::shared_ptr<Operation> &operation,
            const char *permission, NSString *error) {
  std::lock_guard<std::mutex> lock(state->mutex);
  operation->osPending = false;
  operation->authorizationPending = false;
  if (operation->callback) {
    operation->permission = permission;
    if (error) {
      NSString *bounded = error.length > 2048 ? [error substringToIndex:2048] : error;
      operation->error = bounded.UTF8String ?: "Native notification permission operation failed";
    }
    // Only one completion is enqueued. No worker waits for JS or for a user to
    // answer the permission dialog; a closing environment discards this result.
    napi_status status = napi_call_threadsafe_function(operation->callback, nullptr, napi_tsfn_nonblocking);
    // napi_closing relinquishes this thread's use; touching the TSFN again is
    // unsafe once environment teardown has taken ownership of finalization.
    if (status != napi_closing) napi_release_threadsafe_function(operation->callback, napi_tsfn_release);
    operation->callback = nullptr;
  }
  Retire(state, operation);
}

const char *Permission(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusNotDetermined: return "not-determined";
    case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusAuthorized: return "authorized";
    case UNAuthorizationStatusProvisional: return "provisional";
    default: return "unknown";
  }
}

// Objective-C blocks preserve C++ reference captures as references. Own these
// shared_ptr parameters so system callbacks outlive the initiating stack frame.
void ReadSettings(std::shared_ptr<State> state, std::shared_ptr<Operation> operation, bool request);

void RequestAuthorization(std::shared_ptr<State> state, std::shared_ptr<Operation> operation) {
  @try {
    // Serialize cancellation against dispatch of the non-cancellable OS request.
    // This is an asynchronous API; the mutex is never held awaiting its result.
    std::lock_guard<std::mutex> lock(state->mutex);
    if (state->stopping || operation->cancelled) {
      operation->osPending = false;
      Retire(state, operation);
      return;
    }
    operation->authorizationPending = true;
    [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:UNAuthorizationOptionAlert
      completionHandler:^(BOOL, NSError *error) {
        @autoreleasepool {
          bool cancelled;
          {
            std::lock_guard<std::mutex> callbackLock(state->mutex);
            operation->authorizationPending = false;
            cancelled = state->stopping || operation->cancelled;
          }
          if (cancelled || error) {
            Finish(state, operation, "unknown", error.localizedDescription);
            return;
          }
          // The granted boolean loses denied/provisional distinctions. Always
          // re-read the authoritative settings after an authorization response.
          ReadSettings(state, operation, false);
        }
      }];
  } @catch (NSException *exception) {
    Finish(state, operation, "unknown", exception.reason ?: @"macOS notification authorization failed");
  }
}

void ReadSettings(std::shared_ptr<State> state, std::shared_ptr<Operation> operation, bool request) {
  @autoreleasepool {
    @try {
      [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        @autoreleasepool {
          @try {
            if (!settings) {
              Finish(state, operation, "unknown", @"macOS returned no notification settings");
            } else if (request && settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
              RequestAuthorization(state, operation);
            } else {
              Finish(state, operation, Permission(settings.authorizationStatus), nil);
            }
          } @catch (NSException *exception) {
            Finish(state, operation, "unknown", exception.reason ?: @"macOS notification settings failed");
          }
        }
      }];
    } @catch (NSException *exception) {
      Finish(state, operation, "unknown", exception.reason ?: @"macOS notification settings failed");
    }
  }
}

napi_value Start(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) {
    napi_throw_error(env, nullptr, "Notification permissions must use the Electron main thread");
    return nullptr;
  }
  size_t argc = 3;
  napi_value args[3];
  void *data = nullptr;
  if (!CheckNapi(env, napi_get_cb_info(env, info, &argc, args, nullptr, &data))) return nullptr;
  napi_valuetype requestType, callbackType;
  if (argc != 2) {
    napi_throw_type_error(env, nullptr, "start requires a request boolean and a callback");
    return nullptr;
  }
  if (!CheckNapi(env, napi_typeof(env, args[0], &requestType)) ||
      !CheckNapi(env, napi_typeof(env, args[1], &callbackType))) return nullptr;
  if (requestType != napi_boolean || callbackType != napi_function) {
    napi_throw_type_error(env, nullptr, "start requires a request boolean and a callback");
    return nullptr;
  }
  bool request;
  if (!CheckNapi(env, napi_get_value_bool(env, args[0], &request))) return nullptr;
  auto state = *static_cast<std::shared_ptr<State> *>(data);
  std::shared_ptr<Operation> operation;
  napi_value token, name;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    if (state->stopping || state->active) {
      napi_throw_error(env, "ERR_NOTIFICATION_PERMISSION_PENDING",
        state->active && state->active->authorizationPending
          ? "macOS 授权请求仍在进行；系统权限弹窗无法由应用取消，请先在系统弹窗完成选择"
          : "上一次 macOS 通知权限操作尚未释放；等待系统回调后才能重试");
      return nullptr;
    }
    operation = std::make_shared<Operation>();
    if (++state->sequence == 0) ++state->sequence;
    operation->id = state->sequence;
    if (!CheckNapi(env, napi_create_uint32(env, operation->id, &token)) ||
        !CheckNapi(env, napi_create_string_utf8(env, "OCChanNotificationPermission", NAPI_AUTO_LENGTH, &name))) return nullptr;
    auto *context = new CallbackContext{state, operation};
    napi_status status = napi_create_threadsafe_function(env, args[1], nullptr, name, 1, 1,
      context, FinalizeCallback, context, CallJS, &operation->callback);
    if (status != napi_ok) {
      delete context;
      CheckNapi(env, status);
      return nullptr;
    }
    state->active = operation;
    if (!CheckNapi(env, napi_unref_threadsafe_function(env, operation->callback))) {
      operation->cancelled = true;
      operation->osPending = false;
      napi_release_threadsafe_function(operation->callback, napi_tsfn_abort);
      operation->callback = nullptr;
      return nullptr;
    }
  }
  ReadSettings(state, operation, request);
  return token;
}

napi_value Cancel(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2], result;
  void *data = nullptr;
  if (!CheckNapi(env, napi_get_cb_info(env, info, &argc, args, nullptr, &data))) return nullptr;
  uint32_t id;
  if (argc != 1) {
    napi_throw_type_error(env, nullptr, "cancel requires an operation token");
    return nullptr;
  }
  if (!CheckNapi(env, napi_get_value_uint32(env, args[0], &id))) return nullptr;
  auto state = *static_cast<std::shared_ptr<State> *>(data);
  bool promptPending = false;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    const auto &operation = state->active;
    if (operation && operation->id == id) {
      operation->cancelled = true;
      promptPending = operation->authorizationPending;
      if (operation->callback) {
        napi_status status = napi_release_threadsafe_function(operation->callback, napi_tsfn_abort);
        operation->callback = nullptr;
        if (!CheckNapi(env, status)) return nullptr;
      }
    }
  }
  if (!CheckNapi(env, napi_get_boolean(env, promptPending, &result))) return nullptr;
  return result;
}

void Cleanup(void *data) {
  std::unique_ptr<std::shared_ptr<State>> holder(static_cast<std::shared_ptr<State> *>(data));
  const auto &state = *holder;
  std::lock_guard<std::mutex> lock(state->mutex);
  state->stopping = true;
  if (state->active) {
    auto operation = state->active;
    operation->cancelled = true;
    if (operation->callback) {
      napi_release_threadsafe_function(operation->callback, napi_tsfn_abort);
      operation->callback = nullptr;
    }
    state->active.reset();
  }
}

napi_value Initialize(napi_env env, napi_value exports) {
  // Loading creates no system requests, delegates, threads, timers or JS refs.
  auto *state = new std::shared_ptr<State>(std::make_shared<State>());
  if (!CheckNapi(env, napi_add_env_cleanup_hook(env, Cleanup, state))) {
    delete state;
    return nullptr;
  }
  napi_property_descriptor properties[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, state},
    {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, state}
  };
  if (!CheckNapi(env, napi_define_properties(env, exports, 2, properties))) return nullptr;
  return exports;
}
}  // namespace

NAPI_MODULE(notification_permission, Initialize)
