// Acceptance-only. Never link this translation unit into production.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <cstring>
#include <cmath>
#include <libproc.h>
#include <sys/proc_info.h>
using Completion = void (*)(void *, const char *);
static void finish(Completion cb, void *ctx, id value, NSString *error) {
  NSDictionary *reply = error ? @{ @"ok": @NO, @"error": error } : @{ @"ok": @YES, @"value": value ?: [NSNull null] };
  NSError *serializationError = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:reply options:0 error:&serializationError];
  if (!data || data.length > 1024 * 1024) { cb(ctx, "{\"ok\":false,\"error\":\"native result serialization or 1MiB limit\"}"); return; }
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  cb(ctx, json.UTF8String);
}
// WebKit's localized description hides the actual JS exception. Only retain bounded
// scalar diagnostics, never the arbitrary userInfo graph or the evaluated source.
static NSString *javascriptError(NSError *error) {
  NSMutableString *message = [NSMutableString stringWithFormat:@"%@ (%@/%ld)", error.localizedDescription, error.domain, (long)error.code];
  for (NSString *key in @[@"WKJavaScriptExceptionMessage", @"WKJavaScriptExceptionLineNumber", @"WKJavaScriptExceptionColumnNumber", @"WKJavaScriptExceptionSourceURL"]) {
    id value = error.userInfo[key];
    if (![value isKindOfClass:NSString.class] && ![value isKindOfClass:NSNumber.class]) continue;
    NSString *text = [value isKindOfClass:NSString.class] ? value : [value stringValue];
    if (text.length > 512) text = [[text substringToIndex:512] stringByAppendingString:@" [truncated]"];
    [message appendFormat:@"; %@=%@", key, text];
  }
  return message.length > 4096 ? [[message substringToIndex:4096] stringByAppendingString:@" [truncated]"] : message;
}
static NSDictionary *rectInfo(NSRect rect) {
  return @{ @"x": @(rect.origin.x), @"y": @(rect.origin.y), @"width": @(rect.size.width), @"height": @(rect.size.height) };
}
static NSDictionary *viewportGeometry(WKWebView *webview, NSWindow *window) {
  id insets = [NSNull null];
  if (@available(macOS 26.0, *)) {
    NSEdgeInsets value = webview.obscuredContentInsets;
    insets = @{ @"top": @(value.top), @"left": @(value.left), @"bottom": @(value.bottom), @"right": @(value.right) };
  }
  return @{ @"webviewFrame": rectInfo(webview.frame), @"webviewBounds": rectInfo(webview.bounds),
    @"contentViewFrame": rectInfo(window.contentView.frame), @"contentViewBounds": rectInfo(window.contentView.bounds),
    @"contentLayoutRect": rectInfo(window.contentLayoutRect), @"contentLayoutInWebview": rectInfo([webview convertRect:window.contentLayoutRect fromView:nil]),
    @"obscuredContentInsets": insets, @"pageZoom": @(webview.pageZoom), @"magnification": @(webview.magnification) };
}
static pid_t acceptanceProcessIdentifier(id target, NSString *selectorName, BOOL *available) {
  *available = NO;
  if (!target) return -1;
  SEL selector = NSSelectorFromString(selectorName);
  if (!selector || ![target respondsToSelector:selector]) return -1;
  pid_t (*method)(id, SEL) = (pid_t (*)(id, SEL))[target methodForSelector:selector];
  if (!method) return -1;
  *available = YES;
  return method(target, selector);
}
static NSDictionary *acceptanceProcessEntry(NSString *role, id target, NSString *selectorName) {
  BOOL available = NO;
  pid_t first = acceptanceProcessIdentifier(target, selectorName, &available);
  if (!available) return @{ @"role": role, @"reason": @"identifier selector unavailable" };
  pid_t second = acceptanceProcessIdentifier(target, selectorName, &available);
  if (!available || first != second) return @{ @"role": role, @"reason": @"identifier changed during read" };
  if (first == 0) return nil;
  if (first < 0) return @{ @"role": role, @"reason": @"invalid process identifier" };
  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  if (proc_pidinfo(first, PROC_PIDTBSDINFO, 0, &info, (int)sizeof(info)) != (int)sizeof(info)) {
    return @{ @"role": role, @"reason": @"birth identity unavailable" };
  }
  uint64_t startSeconds = info.pbi_start_tvsec, startMicroseconds = info.pbi_start_tvusec;
  pid_t third = acceptanceProcessIdentifier(target, selectorName, &available);
  if (!available || third != first) return @{ @"role": role, @"reason": @"identifier changed during identity read" };
  struct proc_bsdinfo recheck;
  memset(&recheck, 0, sizeof(recheck));
  if (proc_pidinfo(first, PROC_PIDTBSDINFO, 0, &recheck, (int)sizeof(recheck)) != (int)sizeof(recheck)
      || recheck.pbi_start_tvsec != startSeconds || recheck.pbi_start_tvusec != startMicroseconds) {
    return @{ @"role": role, @"reason": @"birth identity changed during read" };
  }
  return @{ @"role": role, @"pid": @(first), @"startSeconds": @(startSeconds), @"startMicroseconds": @(startMicroseconds) };
}
static NSDictionary *acceptanceProcessSnapshot(WKWebView *webview) {
  NSMutableArray *entries = [NSMutableArray array];
  NSMutableArray *unavailable = [NSMutableArray array];
  NSMutableArray *notRunning = [NSMutableArray array];
  id store = webview.configuration.websiteDataStore;
  NSArray *roles = @[
    @[@"web", webview, @"_webProcessIdentifier"],
    @[@"provisionalWeb", webview, @"_provisionalWebProcessIdentifier"],
    @[@"gpu", webview, @"_gpuProcessIdentifier"],
    @[@"network", store ?: [NSNull null], @"_networkProcessIdentifier"]
  ];
  for (NSArray *roleInfo in roles) {
    NSString *role = roleInfo[0];
    id target = roleInfo[1];
    if (target == (id)[NSNull null]) { [unavailable addObject:@{ @"role": role, @"reason": @"website data store unavailable" }]; continue; }
    NSDictionary *entry = acceptanceProcessEntry(role, target, roleInfo[2]);
    if (!entry) [notRunning addObject:role];
    else if (entry[@"pid"]) [entries addObject:entry];
    else [unavailable addObject:entry];
  }
  return @{ @"entries": entries, @"unavailable": unavailable, @"notRunning": notRunning, @"scope": @"instance-associated processes; may be shared" };
}
extern "C" void oc_wk_prohibit_activation() {
  [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
}
extern "C" void oc_wk_request(void *pointer, const char *operation, const char *payload, Completion cb, void *ctx) {
  if (![NSThread isMainThread]) { finish(cb, ctx, nil, @"requires main thread"); return; }
  @try {
    WKWebView *webview = (__bridge WKWebView *)pointer;
    NSWindow *window = webview.window;
    if (!window || ![[NSApp windows] containsObject:window]) { finish(cb, ctx, nil, @"window no longer live"); return; }
    if (window.visible || window.keyWindow || NSApp.active || NSApp.activationPolicy != NSApplicationActivationPolicyProhibited) {
      finish(cb, ctx, nil, @"hidden/prohibited invariant violated"); return;
    }
    if (!strcmp(operation, "inspect")) {
      finish(cb, ctx, @{ @"visible": @(window.visible), @"key": @(window.keyWindow), @"main": @(window.mainWindow), @"appActive": @(NSApp.active), @"activationPolicy": @(NSApp.activationPolicy), @"width": @(webview.bounds.size.width), @"height": @(webview.bounds.size.height), @"outerWidth": @(window.frame.size.width), @"outerHeight": @(window.frame.size.height), @"loading": @(webview.loading), @"tabFocusesLinks": @(webview.configuration.preferences.tabFocusesLinks), @"url": webview.URL.absoluteString ?: [NSNull null], @"firstResponder": window.firstResponder ? NSStringFromClass(window.firstResponder.class) : [NSNull null], @"webviewClass": NSStringFromClass(webview.class), @"webviewIsFirstResponder": @(window.firstResponder == webview), @"webviewFlipped": @(webview.flipped), @"windowNumber": @(window.windowNumber), @"geometry": viewportGeometry(webview, window), @"processes": acceptanceProcessSnapshot(webview) }, nil);
    } else if (!strcmp(operation, "eval")) {
      // A window exists before its initial navigation commits. An async call in
      // that old document can lose both promise handlers when WebKit discards it.
      NSURL *documentURL = webview.URL;
      if (webview.loading || !documentURL || [documentURL.absoluteString isEqualToString:@"about:blank"]) {
        finish(cb, ctx, nil, @"eval requires a loaded document; inspect loading/url before dispatch"); return;
      }
      NSString *source = [NSString stringWithUTF8String:payload];
      __weak WKWebView *bound = webview;
      [webview callAsyncJavaScript:source arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result, NSError *error) {
        WKWebView *current = bound;
        if (!current || current.window != window) { finish(cb, ctx, nil, @"window lifecycle cancelled"); return; }
        if (window.visible || window.keyWindow || NSApp.active || NSApp.activationPolicy != NSApplicationActivationPolicyProhibited) { finish(cb, ctx, nil, @"hidden/prohibited invariant violated during eval"); return; }
        // eval scripts return JSON strings; undefined and unsupported objects are errors.
        BOOL documentChanged = ![current.URL isEqual:documentURL];
        if (error) { finish(cb, ctx, nil, [NSString stringWithFormat:@"%@; loading=%d; documentURLChanged=%d", javascriptError(error), current.loading, documentChanged]); return; }
        if (current.loading || documentChanged) { finish(cb, ctx, nil, @"navigation changed during eval"); return; }
        if (![result isKindOfClass:NSString.class]) { finish(cb, ctx, nil, @"eval must return JSON string"); return; }
        if ([(NSString *)result lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 1024 * 1024) { finish(cb, ctx, nil, @"eval result exceeds 1MiB"); return; }
        NSError *parseError = nil;
        id parsed = [NSJSONSerialization JSONObjectWithData:[result dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingFragmentsAllowed error:&parseError];
        finish(cb, ctx, parsed, parseError.localizedDescription);
      }];
    } else if (!strcmp(operation, "resize")) {
      NSData *data = [[NSString stringWithUTF8String:payload] dataUsingEncoding:NSUTF8StringEncoding];
      NSError *error = nil;
      NSDictionary *size = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
      if (error || ![size isKindOfClass:NSDictionary.class]) { finish(cb, ctx, nil, @"invalid resize payload"); return; }
      double width = [size[@"width"] doubleValue], height = [size[@"height"] doubleValue];
      if (width < 320 || width > 1920 || height < 240 || height > 1200) { finish(cb, ctx, nil, @"resize outside bounds"); return; }
      [window setContentSize:NSMakeSize(width, height)];
      [window.contentView layoutSubtreeIfNeeded];
      if (webview.bounds.size.width != width || webview.bounds.size.height != height) { finish(cb, ctx, nil, @"native resize was not applied"); return; }
      finish(cb, ctx, @{ @"width": @(webview.bounds.size.width), @"height": @(webview.bounds.size.height), @"visible": @(window.visible), @"key": @(window.keyWindow) }, nil);
    } else if (!strcmp(operation, "reload")) {
      [webview reload];
      finish(cb, ctx, @YES, nil);
    } else if (!strcmp(operation, "mouse") || !strcmp(operation, "key") || !strcmp(operation, "text") || !strcmp(operation, "select-all")) {
      NSError *parseError = nil;
      NSDictionary *input = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:payload] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&parseError];
      if (parseError || ![input isKindOfClass:NSDictionary.class]) { finish(cb, ctx, nil, @"invalid input payload"); return; }
      if (!strcmp(operation, "mouse")) {
        double x = [input[@"x"] doubleValue], y = [input[@"y"] doubleValue];
        NSString *kind = input[@"kind"];
        NSEdgeInsets insets;
        if (@available(macOS 26.0, *)) { insets = webview.obscuredContentInsets; }
        else { finish(cb, ctx, nil, @"native mouse acceptance requires macOS 26 public viewport insets"); return; }
        double zoom = webview.pageZoom;
        // clientX/clientY are CSS viewport coordinates, not NSView coordinates.
        // WebKit subtracts obscured native insets when delivering DOM events.
        // Pinch zoom also shifts the visual viewport; do not guess that offset.
        if (webview.magnification != 1) { finish(cb, ctx, nil, @"native mouse requires an unpinched viewport"); return; }
        NSRect bounds = webview.bounds;
        double viewportWidth = bounds.size.width - insets.left - insets.right;
        double viewportHeight = bounds.size.height - insets.top - insets.bottom;
        if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(zoom) || zoom <= 0 || x < 0 || y < 0 || x * zoom >= viewportWidth || y * zoom >= viewportHeight) { finish(cb, ctx, nil, @"mouse point outside CSS viewport"); return; }
        NSPoint local = NSMakePoint(NSMinX(bounds) + insets.left + x * zoom,
          webview.isFlipped ? NSMinY(bounds) + insets.top + y * zoom : NSMaxY(bounds) - insets.top - y * zoom);
        NSView *target = [webview hitTest:[webview convertPoint:local toView:webview.superview]];
        if (!target) { finish(cb, ctx, nil, @"no native hit target"); return; }
        NSEventType type;
        if ([kind isEqual:@"down"]) type = NSEventTypeLeftMouseDown;
        else if ([kind isEqual:@"up"]) type = NSEventTypeLeftMouseUp;
        else if ([kind isEqual:@"drag"]) type = NSEventTypeLeftMouseDragged;
        else if ([kind isEqual:@"move"]) type = NSEventTypeMouseMoved;
        else { finish(cb, ctx, nil, @"unknown mouse kind"); return; }
        // NSWindow normally establishes the responder before mouseDown. Direct
        // dispatch must do the same without making the hidden window key/active.
        if (type == NSEventTypeLeftMouseDown && ![window makeFirstResponder:webview]) { finish(cb, ctx, nil, @"cannot focus native mouse responder"); return; }
        NSEvent *event = [NSEvent mouseEventWithType:type location:[webview convertPoint:local toView:nil] modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:type == NSEventTypeLeftMouseDown ? 1 : 0];
        if (type == NSEventTypeLeftMouseDown) [target mouseDown:event];
        else if (type == NSEventTypeLeftMouseUp) [target mouseUp:event];
        else if (type == NSEventTypeLeftMouseDragged) [target mouseDragged:event];
        else [target mouseMoved:event];
      } else {
        NSResponder *target = window.firstResponder;
        // Direct responder dispatch bypasses NSWindow's normal focus routing.
        // A hidden window can still have its content container as first responder.
        if (![target isKindOfClass:NSView.class] || ![(NSView *)target isDescendantOf:webview]) {
          if (![window makeFirstResponder:webview]) { finish(cb, ctx, nil, @"no keyboard responder"); return; }
          target = window.firstResponder;
          if (![target isKindOfClass:NSView.class] || ![(NSView *)target isDescendantOf:webview]) { finish(cb, ctx, nil, @"keyboard responder outside webview"); return; }
        }
        if (!strcmp(operation, "select-all")) {
          if (![target respondsToSelector:@selector(selectAll:)]) { finish(cb, ctx, nil, @"responder cannot select all"); return; }
          [(id)target selectAll:nil];
        } else if (!strcmp(operation, "text")) {
          NSString *text = input[@"text"];
          if (![text isKindOfClass:NSString.class] || text.length > 4096 || ![target respondsToSelector:@selector(insertText:replacementRange:)]) { finish(cb, ctx, nil, @"text input unavailable or exceeds limit"); return; }
          [(id<NSTextInputClient>)target insertText:text replacementRange:NSMakeRange(NSNotFound, 0)];
        } else {
          NSString *key = input[@"key"];
          NSDictionary *codes = @{ @"Escape": @53, @"Tab": @48, @"Backspace": @51, @"Enter": @36, @"ArrowLeft": @123, @"ArrowRight": @124, @"ArrowDown": @125, @"ArrowUp": @126, @" ": @49, @"a": @0 };
          NSNumber *code = codes[key];
          if (!code) { finish(cb, ctx, nil, @"unsupported acceptance key"); return; }
          NSDictionary *characters = @{ @"Escape": @"\x1b", @"Tab": @"\t", @"Backspace": @"\x7f", @"Enter": @"\r", @"ArrowLeft": @"\uf702", @"ArrowRight": @"\uf703", @"ArrowDown": @"\uf701", @"ArrowUp": @"\uf700" };
          NSString *text = characters[key] ?: key;
          NSUInteger flags = [input[@"modifiers"] unsignedIntegerValue];
          NSEventModifierFlags modifiers = ((flags & 4) ? NSEventModifierFlagCommand : 0) | ((flags & 8) ? NSEventModifierFlagShift : 0);
          for (NSNumber *type in @[@(NSEventTypeKeyDown), @(NSEventTypeKeyUp)]) {
            NSEvent *event = [NSEvent keyEventWithType:(NSEventType)type.unsignedIntegerValue location:NSZeroPoint modifierFlags:modifiers timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code.unsignedShortValue];
            if (type.unsignedIntegerValue == NSEventTypeKeyDown) [target keyDown:event]; else [target keyUp:event];
          }
        }
      }
      if (window.visible || window.keyWindow || NSApp.active || NSApp.activationPolicy != NSApplicationActivationPolicyProhibited) { finish(cb, ctx, nil, @"input violated hidden invariant"); return; }
      finish(cb, ctx, @YES, nil);
    } else if (!strcmp(operation, "capture")) {
      WKSnapshotConfiguration *config = [WKSnapshotConfiguration new];
      config.rect = webview.bounds; config.snapshotWidth = @640;
      config.afterScreenUpdates = NO;
      __weak WKWebView *bound = webview;
      [webview takeSnapshotWithConfiguration:config completionHandler:^(NSImage *image, NSError *error) {
        if (!bound || bound.window != window) { finish(cb, ctx, nil, @"window lifecycle cancelled"); return; }
        if (window.visible || window.keyWindow || NSApp.active || NSApp.activationPolicy != NSApplicationActivationPolicyProhibited) { finish(cb, ctx, nil, @"hidden/prohibited invariant violated during capture"); return; }
        if (!image || error) { finish(cb, ctx, nil, error.localizedDescription ?: @"snapshot returned no image"); return; }
        CGImageRef cg = [image CGImageForProposedRect:nullptr context:nil hints:nil];
        if (!cg) { finish(cb, ctx, nil, @"snapshot lacks pixel image"); return; }
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:cg];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (!png || png.length > 700 * 1024) { finish(cb, ctx, nil, @"PNG missing or exceeds 700KiB"); return; }
        finish(cb, ctx, @{ @"pngBase64": [png base64EncodedStringWithOptions:0], @"width": @(bitmap.pixelsWide), @"height": @(bitmap.pixelsHigh) }, nil);
      }];
    } else { finish(cb, ctx, nil, @"unknown native operation"); }
  } @catch (NSException *exception) { finish(cb, ctx, nil, exception.reason ?: @"native exception"); }
}
