// Included by oc_native.mm. C ABI exception boundaries and synchronous commands.
static void SystemEvent(std::shared_ptr<State> state, NSString *event) {
  if (!state || state->released) return;
  @try {
    try { ObserveLaunch(state); Emit(state, event, 0, SystemRead(state)); }
    catch (const std::exception &e) { Emit(state, event, 0, nil, [NSString stringWithUTF8String:e.what()]); }
  } @catch (NSException *e) { fprintf(stderr, "native observer exception: %s\n", e.reason.UTF8String); }
}
@interface OCNativeAppearanceObserver : NSObject { @public std::weak_ptr<State> state; }
@end
@implementation OCNativeAppearanceObserver
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
  SystemEvent(state.lock(), @"systemChanged");
}
@end
static void RemoveObservers(std::shared_ptr<State> state) {
  while (state->observers.count) {
    NSDictionary *entry = state->observers.lastObject;
    if (entry[@"appearance"]) [NSApp removeObserver:entry[@"appearance"] forKeyPath:@"effectiveAppearance"];
    else [(NSNotificationCenter *)entry[@"center"] removeObserver:entry[@"token"]];
    [state->observers removeLastObject];
  }
}
static void AddObserver(std::shared_ptr<State> state, NSNotificationCenter *center, NSString *name, NSString *event) {
  std::weak_ptr<State> weak = state;
  id token = [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *) { SystemEvent(weak.lock(), event); }];
  Require(token != nil, "cannot create native observer");
  [state->observers addObject:@{ @"center":center, @"token":token }];
}
static void EnsureNotifications(std::shared_ptr<State> state) {
  Require(NSBundle.mainBundle.bundleIdentifier.length > 0, "UserNotifications requires a real application bundle identifier");
  if (state->delegate) return;
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  Require(center.delegate == nil, "UserNotifications delegate already owned by another component");
  OCNativeDelegate *delegate = [OCNativeDelegate new]; delegate->state = state;
  state->delegate = delegate; center.delegate = delegate;
}
extern "C" int oc_native_create(int acceptance_mode, oc_native_callback callback, void *userdata, oc_native_context **out_context, char **error) {
  if (error) *error = nullptr;
  if (out_context) *out_context = nullptr;
  OC_BEGIN
    stage = "mainThread";
    MainThread(); Require(out_context && callback, "context output and callback required");
    stage = "application";
    Require(NSApp != nil, "host must initialize its NSApplication subclass before native create");
    Require(!currentState, "native context or cancelled OS operation still alive");
    stage = "stateAllocation";
    auto context = std::make_unique<oc_native_context>();
    auto state = std::make_shared<State>();
    state->callback = callback; state->userdata = userdata; state->acceptance = acceptance_mode != 0;
    stage = "launchEvent";
    ObserveLaunch(state);
    if (state->acceptance) {
      stage = "activationPolicy";
      const auto policyBefore = NSApp.activationPolicy;
      const bool setterAttempted = policyBefore != NSApplicationActivationPolicyProhibited;
      const bool setterAccepted = setterAttempted && [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
      const auto policyAfter = NSApp.activationPolicy;
      NSArray<NSWindow *> *windows = NSApp.windows;
      NSUInteger visible = 0, key = 0, main = 0;
      for (NSWindow *window in windows) {
        visible += window.visible ? 1 : 0;
        key += window.keyWindow ? 1 : 0;
        main += window.mainWindow ? 1 : 0;
      }
      // Fixed scalars only: no window titles, bundle paths or OS exception text.
      fprintf(stderr, "OC_NATIVE_HEADLESS_STATE operation=create stage=activationPolicy policyBefore=%ld setterAttempted=%d setterAccepted=%d policyAfter=%ld active=%d running=%d windows=%lu visible=%lu key=%lu main=%lu bundleIdentifier=%d appBundle=%d\n",
        (long)policyBefore, (int)setterAttempted, (int)setterAccepted, (long)policyAfter, (int)NSApp.active, (int)NSApp.running,
        (unsigned long)windows.count, (unsigned long)visible, (unsigned long)key, (unsigned long)main,
        (int)(NSBundle.mainBundle.bundleIdentifier.length > 0), (int)[NSBundle.mainBundle.bundleURL.pathExtension isEqualToString:@"app"]);
      Require((!setterAttempted || setterAccepted) && policyAfter == NSApplicationActivationPolicyProhibited, "cannot set prohibited activation policy");
      stage = "hiddenWindows";
      for (NSWindow *window in NSApp.windows) Require(!window.visible && !window.keyWindow, "acceptance requires every window already hidden and unfocused");
      stage = "inactiveApplication";
      Require(!NSApp.active, "acceptance application is active");
    }
    @try {
      try {
      stage = "appearanceObserver";
      OCNativeAppearanceObserver *appearance = [OCNativeAppearanceObserver new]; appearance->state = state;
      [NSApp addObserver:appearance forKeyPath:@"effectiveAppearance" options:0 context:nil];
      [state->observers addObject:@{ @"appearance":appearance }];
      stage = "accessibilityObserver";
      AddObserver(state, NSWorkspace.sharedWorkspace.notificationCenter, NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification, @"systemChanged");
      stage = "sleepObserver";
      AddObserver(state, NSWorkspace.sharedWorkspace.notificationCenter, NSWorkspaceWillSleepNotification, @"systemSleeping");
      stage = "wakeObserver";
      AddObserver(state, NSWorkspace.sharedWorkspace.notificationCenter, NSWorkspaceDidWakeNotification, @"systemAwake");
      stage = "launchObserver";
      AddObserver(state, NSNotificationCenter.defaultCenter, NSApplicationDidFinishLaunchingNotification, @"applicationLaunched");
      stage = "localeObserver";
      AddObserver(state, NSNotificationCenter.defaultCenter, NSCurrentLocaleDidChangeNotification, @"systemChanged");
      } catch (...) { RemoveObservers(state); throw; }
    } @catch (NSException *exception) { RemoveObservers(state); @throw; }
    context->state = state; currentState = state; *out_context = context.release();
    return 0;
  OC_END
}
static id Call(std::shared_ptr<State> state, NSString *command, NSDictionary *args) {
  if ([command isEqualToString:@"operationRead"]) return @{ @"osPending":@(state->busy), @"requestId":@(state->request), @"authorizationPending":@(state->authorization) };
  if ([command isEqualToString:@"systemRead"]) return SystemRead(state);
  if ([command isEqualToString:@"themeSet"]) {
    NSString *mode = String(args, @"mode", 16);
    if ([mode isEqualToString:@"system"]) NSApp.appearance = nil;
    else if ([mode isEqualToString:@"light"]) NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    else if ([mode isEqualToString:@"dark"]) NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    else throw std::runtime_error("theme must be system, light or dark");
    return SystemRead(state);
  }
  if ([command isEqualToString:@"dockSet"]) {
    Require(!state->acceptance, "Dock mutation forbidden in acceptance");
    bool visible = BooleanArgument(args, @"visible");
    auto policy = visible ? NSApplicationActivationPolicyRegular : NSApplicationActivationPolicyAccessory;
    const bool setterAttempted = NSApp.activationPolicy != policy;
    const bool setterAccepted = setterAttempted && [NSApp setActivationPolicy:policy];
    const auto policyAfter = NSApp.activationPolicy;
    Require((!setterAttempted || setterAccepted) && policyAfter == policy, "Dock activation policy did not apply");
    return SystemRead(state);
  }
  if ([command isEqualToString:@"sleepSet"]) {
    Require(!state->acceptance, "sleep prevention mutation forbidden in acceptance");
    bool enabled = BooleanArgument(args, @"enabled");
    if (enabled && state->assertion == kIOPMNullAssertionID) {
      IOPMAssertionID assertion = kIOPMNullAssertionID;
      Require(IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep, kIOPMAssertionLevelOn, CFSTR("OC Chan prevent application suspension"), &assertion) == kIOReturnSuccess, "IOPM assertion create failed");
      state->assertion = assertion;
    } else if (!enabled && state->assertion != kIOPMNullAssertionID) {
      IOPMAssertionID old = state->assertion;
      Require(IOPMAssertionRelease(old) == kIOReturnSuccess, "IOPM assertion release failed");
      state->assertion = kIOPMNullAssertionID;
      CFDictionaryRef remaining = IOPMAssertionCopyProperties(old);
      if (remaining) { CFRelease(remaining); throw std::runtime_error("released assertion still readable"); }
    }
    bool actual = SleepRead(state); Require(actual == enabled, "IOPM assertion readback differs from requested state");
    return @{ @"preventSleep":@(actual) };
  }
  if ([command isEqualToString:@"loginRead"]) return LoginRead(state);
  if ([command isEqualToString:@"loginSet"]) {
    Require(!state->acceptance && Installed(), "login change requires installed application and non-acceptance mode");
    bool enabled = BooleanArgument(args, @"enabled");
    if (@available(macOS 13.0, *)) {
      SMAppService *service = SMAppService.mainAppService;
      NSError *error = nil;
      bool applied = enabled ? [service registerAndReturnError:&error] : [service unregisterAndReturnError:&error];
      if (!applied) throw std::runtime_error((error.localizedDescription ?: @"SMAppService change failed").UTF8String);
      auto status = service.status;
      Require(enabled ? status == SMAppServiceStatusEnabled || status == SMAppServiceStatusRequiresApproval : status == SMAppServiceStatusNotRegistered, "SMAppService readback mismatch");
      return LoginRead(state);
    }
    throw std::runtime_error("SMAppService requires macOS 13");
  }
  if ([command isEqualToString:@"windowRead"]) {
    NSWindow *window = Window(args);
    return @{ @"visible":@(window.visible), @"key":@(window.keyWindow), @"main":@(window.mainWindow), @"appActive":@(NSApp.active), @"width":@(window.contentView.bounds.size.width), @"height":@(window.contentView.bounds.size.height) };
  }
  if ([command isEqualToString:@"glassSet"]) return GlassSet(args);
  if ([command isEqualToString:@"clipboardWrite"]) {
    Require(!state->acceptance, "clipboard writes forbidden in acceptance");
    Window(args);
    NSString *text = String(args, @"text", 256 * 1024);
    NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
    [pasteboard clearContents];
    Require([pasteboard setString:text forType:NSPasteboardTypeString], "clipboard write failed");
    Require([[pasteboard stringForType:NSPasteboardTypeString] isEqualToString:text], "clipboard readback mismatch");
    return @{ @"copied":@YES };
  }
  if ([command isEqualToString:@"accessibilityRead"]) {
    Require(!state->acceptance, "accessibility query forbidden in acceptance");
    return @{ @"availability":@"available", @"status":AXIsProcessTrusted() ? @"authorized" : @"not-authorized", @"details":NSNull.null };
  }
  if ([command isEqualToString:@"openPermissionSettings"]) {
    Require(!state->acceptance, "system settings forbidden in acceptance");
    NSString *target = String(args, @"target", 32);
    Require([target isEqualToString:@"accessibility"] || [target isEqualToString:@"notifications"], "permission settings target rejected");
    NSString *destination = [target isEqualToString:@"accessibility"]
      ? @"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
      : @"x-apple.systempreferences:com.apple.Notifications-Settings.extension";
    Require([NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:destination]], "permission settings open failed");
    return @{ @"opened":@YES };
  }
  if ([command isEqualToString:@"openReleaseNotes"]) {
    Require(!state->acceptance, "external URL forbidden in acceptance");
    NSString *text = String(args, @"url", 2048);
    NSURL *url = [NSURL URLWithString:text];
    Require([url.scheme isEqualToString:@"https"] && [url.host isEqualToString:@"github.com"] && !url.user && !url.password && !url.port && !url.query && !url.fragment, "release URL authority rejected");
    NSString *base = @"/Zixiaobowen/oc-chan/releases";
    Require([url.path isEqualToString:base] || [url.path hasPrefix:[base stringByAppendingString:@"/tag/"]], "release URL path rejected");
    Require([NSWorkspace.sharedWorkspace openURL:url], "release URL open failed");
    return @{ @"opened":@YES };
  }
  if ([command isEqualToString:@"notificationRemove"]) {
    NSString *id = String(args, @"id", 128);
    Require(state->notifications[id] != nil, "notification is not owned by this context");
    Revoke(state, id);
    state->notifications[id] = @{ @"target":state->notifications[id][@"target"], @"cancelled":@YES };
    return @{ @"id":id, @"removalRequested":@YES };
  }
  throw std::runtime_error("unknown native command");
}
extern "C" int oc_native_call(oc_native_context *context, const char *command, const char *args_json, char **result_json, char **error) {
  if (error) *error = nullptr;
  if (result_json) *result_json = nullptr;
  OC_BEGIN
    auto state = Checked(context); Require(result_json, "result output required");
    *result_json = Copy(JSON(Call(state, Text(command, 64), Arguments(args_json)))); return 0;
  OC_END
}
extern "C" int oc_native_start(oc_native_context *context, uint64_t request_id, const char *command, const char *args_json, char **error) {
  if (error) *error = nullptr;
  OC_BEGIN
    auto state = Checked(context); NSString *name = Text(command, 64); NSDictionary *args = Arguments(args_json);
    Require(!state->busy, "one OS operation still pending, including cancelled operations");
    Require(request_id > state->lastRequest, "request ID must strictly increase");
    bool query = [name isEqualToString:@"permissionQuery"], request = [name isEqualToString:@"permissionRequest"], send = [name isEqualToString:@"notificationSend"], list = [name isEqualToString:@"notificationState"], panel = [name isEqualToString:@"savePanel"];
    Require(query || request || send || list || panel, "unknown async command");
    Require(!state->acceptance || (!request && !send && !panel), "native interaction forbidden in acceptance");
    NSWindow *owner = panel ? Window(args) : nil;
    if (send) {
      NSString *id = String(args, @"id", 128);
      String(args, @"title", 1024, true); String(args, @"body", 4096, true);
      Require([args[@"target"] isKindOfClass:NSDictionary.class] && [JSON(args[@"target"]) lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 8192, "notification target must be an object <=8KiB");
      Require(state->permission == UNAuthorizationStatusAuthorized || state->permission == UNAuthorizationStatusProvisional, "notification permission must first be queried and allowed");
      Require(state->notifications[id] == nil && state->notifications.count < 8, "duplicate ID or eight live notifications; remove one first");
    }
    if (!panel) { stage = "notificationCenter"; EnsureNotifications(state); }
    stage = "scheduleOperation";
    state->busy = true; state->request = request_id; state->lastRequest = request_id; state->cancelled = false;
    @try {
      try {
        if (query || request) Permission(state, request);
        else if (send) Send(state, args);
        else if (list) NotificationState(state);
        else {
          NSSavePanel *dialog = [NSSavePanel savePanel];
          Require(dialog != nil, "save panel allocation failed");
          dialog.nameFieldStringValue = @"oc-chan-diagnostics.json";
          dialog.canCreateDirectories = YES;
          state->panel = dialog;
          [dialog beginSheetModalForWindow:owner completionHandler:^(NSModalResponse response) {
            OnMain(state, ^{
              if (state->cancelled || state->released || response != NSModalResponseOK) { Finish(state, @"savePanel", @{ @"path":NSNull.null }); return; }
              NSURL *url = dialog.URL;
              Require(url.isFileURL && url.path.length > 0 && [url.path lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 4096, "save panel returned invalid path");
              Finish(state, @"savePanel", @{ @"path":url.path });
            });
          }];
        }
      } catch (...) {
        // A throwing Cocoa scheduling call is not proof that no completion will
        // arrive. Keep its identity until Finish observes actual settlement.
        state->cancelled = true;
        if (state->sending) { Revoke(state, state->sending); state->notifications[state->sending] = @{ @"target":state->notifications[state->sending][@"target"], @"cancelled":@YES }; }
        throw;
      }
    } @catch (NSException *exception) {
      state->cancelled = true;
      if (state->sending) { Revoke(state, state->sending); state->notifications[state->sending] = @{ @"target":state->notifications[state->sending][@"target"], @"cancelled":@YES }; }
      @throw;
    }
    return 0;
  OC_END
}
extern "C" int oc_native_cancel(oc_native_context *context, uint64_t request_id, char **result_json, char **error) {
  if (error) *error = nullptr;
  if (result_json) *result_json = nullptr;
  OC_BEGIN
    auto state = Checked(context); Require(result_json, "result output required");
    Require(state->busy && request_id == state->request, "request no longer pending");
    state->cancelled = true;
    if (state->panel) [state->panel cancel:nil];
    if (state->sending) {
      Revoke(state, state->sending);
      state->notifications[state->sending] = @{ @"target":state->notifications[state->sending][@"target"], @"cancelled":@YES };
    }
    *result_json = Copy(JSON(@{ @"osPending":@YES, @"authorizationPending":@(state->authorization) })); return 0;
  OC_END
}
extern "C" int oc_native_release(oc_native_context *context, char **error) {
  if (error) *error = nullptr;
  OC_BEGIN
    auto state = Checked(context);
    Require(!state->busy, "OS operation still pending; context retained");
    // Cleanup failures retain the caller's handle for retry, with no success claim.
    if (state->assertion != kIOPMNullAssertionID) { Require(IOPMAssertionRelease(state->assertion) == kIOReturnSuccess, "IOPM release failed; context retained"); state->assertion = kIOPMNullAssertionID; }
    if (state->notifications.count) {
      for (NSString *id in state->notifications.allKeys) {
        Revoke(state, id);
        state->notifications[id] = @{ @"target":state->notifications[id][@"target"], @"cancelled":@YES };
      }
      if (state->sending) state->cancelled = true;
      throw std::runtime_error("notification revocation pending; await OS operation, query notificationState until revoking/pending/delivered are empty, then retry release; context retained");
    }
    RemoveObservers(state);
    if (state->delegate) {
      UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
      if (center.delegate == state->delegate) center.delegate = nil;
      state->delegate = nil;
    }
    for (NSWindow *window in NSApp.windows) { NSView *glass = objc_getAssociatedObject(window, glassKey); [glass removeFromSuperview]; objc_setAssociatedObject(window, glassKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC); }
    state->released = true; state->cancelled = true; state->callback = nullptr; state->userdata = nullptr;
    if (!state->busy) currentState.reset();
    delete context; return 0;
  OC_END
}
extern "C" void oc_native_string_free(char *value) { free(value); }
extern "C" int oc_native_clipboard(oc_native_context *context, uint64_t window, const char *text, char **error) {
  if (error) *error = nullptr;
  OC_BEGIN
    auto state = Checked(context);
    Call(state, @"clipboardWrite", @{ @"window":@(window), @"text":Text(text, 256 * 1024) });
    return 0;
  OC_END
}
