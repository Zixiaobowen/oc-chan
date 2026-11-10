// Included by oc_native.mm. No separate compilation; all callbacks enter main.
static void Finish(std::shared_ptr<State> state, NSString *event, id value, NSString *error = nil) {
  const uint64_t request = state->request;
  const bool deliver = !state->cancelled && !state->released;
  state->busy = false; state->authorization = false; state->request = 0;
  state->cancelled = false; state->sending = nil; state->panel = nil;
  if (state->released && currentState == state) currentState.reset();
  if (deliver) Emit(state, event, request, value, error);
  else if (!state->released) Emit(state, @"operationSettled", request, @{ @"cancelled":@YES });
}
static void AsyncFailure(std::shared_ptr<State> state, NSString *error) {
  @try {
    try { Finish(state, @"operationFailed", nil, error ?: @"native async failure"); }
    catch (const std::exception &e) { fprintf(stderr, "native async delivery failed: %s\n", e.what()); }
  } @catch (NSException *exception) { fprintf(stderr, "native async delivery exception: %s\n", exception.reason.UTF8String); }
}
static void OnMain(std::shared_ptr<State> state, void (^action)(void)) {
  dispatch_async(dispatch_get_main_queue(), ^{
    @autoreleasepool {
      @try {
        try { action(); }
        catch (const std::exception &error) { AsyncFailure(state, [NSString stringWithUTF8String:error.what()]); }
      } @catch (NSException *error) { AsyncFailure(state, error.reason); }
    }
  });
}
static NSString *PermissionName(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusNotDetermined: return @"not-determined";
    case UNAuthorizationStatusDenied: return @"denied";
    case UNAuthorizationStatusAuthorized: return @"authorized";
    case UNAuthorizationStatusProvisional: return @"provisional";
    default: throw std::runtime_error("unknown notification permission status");
  }
}
static void Permission(std::shared_ptr<State> state, bool request) {
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    OnMain(state, ^{
      if (state->cancelled || state->released) { Finish(state, @"permission", nil); return; }
      Require(settings != nil, "macOS returned no notification settings");
      state->permission = settings.authorizationStatus;
      if (request && state->permission == UNAuthorizationStatusNotDetermined) {
        state->authorization = true;
        [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert completionHandler:^(BOOL, NSError *error) {
          OnMain(state, ^{
            state->authorization = false;
            if (state->cancelled || state->released) { Finish(state, @"permission", nil); return; }
            if (error) { Finish(state, @"permission", nil, error.localizedDescription); return; }
            Permission(state, false); // granted boolean loses denied/provisional distinction
          });
        }];
      } else Finish(state, @"permission", @{ @"permission":PermissionName(state->permission) });
    });
  }];
}
static NSString *OSIdentifier(std::shared_ptr<State> state, NSString *id) { return [state->prefix stringByAppendingString:id]; }
static void Revoke(std::shared_ptr<State> state, NSString *id) {
  NSString *identifier = OSIdentifier(state, id);
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  [center removePendingNotificationRequestsWithIdentifiers:@[identifier]];
  [center removeDeliveredNotificationsWithIdentifiers:@[identifier]];
}
static void Send(std::shared_ptr<State> state, NSDictionary *args) {
  NSString *id = args[@"id"];
  state->sending = id;
  state->notifications[id] = @{ @"target":args[@"target"], @"cancelled":@NO };
  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = args[@"title"]; content.body = args[@"body"]; content.sound = nil;
  content.userInfo = @{ @"ocChanId":id, @"ocChanTarget":args[@"target"] };
  UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:OSIdentifier(state, id) content:content trigger:nil];
  [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request withCompletionHandler:^(NSError *error) {
    OnMain(state, ^{
      bool cancelled = state->released || state->cancelled || [state->notifications[id][@"cancelled"] boolValue];
      if (cancelled || error) {
        Revoke(state, id);
        state->notifications[id] = @{ @"target":args[@"target"], @"cancelled":@YES };
      }
      Finish(state, @"notificationAccepted", @{ @"id":id, @"scheduled":@(error == nil && !cancelled) }, error.localizedDescription);
    });
  }];
}
static NSString *OwnedID(std::shared_ptr<State> state, NSString *identifier, bool includeRevoking = false) {
  if (![identifier hasPrefix:state->prefix]) return nil;
  NSString *id = [identifier substringFromIndex:state->prefix.length];
  NSDictionary *entry = state->notifications[id];
  return entry && (includeRevoking || ![entry[@"cancelled"] boolValue]) ? id : nil;
}
static void NotificationState(std::shared_ptr<State> state) {
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *requests) {
    OnMain(state, ^{
      if (state->cancelled || state->released) { Finish(state, @"notificationState", nil); return; }
      NSMutableArray *pending = [NSMutableArray new];
      for (UNNotificationRequest *request in requests) {
        NSString *id = OwnedID(state, request.identifier, true);
        if (id) { Require(pending.count < 8, "OS pending notifications exceeded owned limit"); [pending addObject:id]; }
      }
      [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notifications) {
        OnMain(state, ^{
          if (state->cancelled || state->released) { Finish(state, @"notificationState", nil); return; }
          NSMutableArray *delivered = [NSMutableArray new];
          for (UNNotification *notification in notifications) {
            NSString *id = OwnedID(state, notification.request.identifier, true);
            if (id) { Require(delivered.count < 8, "OS delivered notifications exceeded owned limit"); [delivered addObject:id]; }
          }
          NSMutableArray *revoking = [NSMutableArray new];
          for (NSString *id in state->notifications.allKeys) {
            if (![state->notifications[id][@"cancelled"] boolValue]) continue;
            if ([pending containsObject:id] || [delivered containsObject:id]) [revoking addObject:id];
            else [state->notifications removeObjectForKey:id];
          }
          Finish(state, @"notificationState", @{ @"pending":pending, @"delivered":delivered, @"revoking":revoking, @"owned":state->notifications.allKeys });
        });
      }];
    });
  }];
}
static void DelegateEvent(std::shared_ptr<State> state, NSString *identifier, NSString *action, bool presented) {
  // Native delegate callbacks may be off-main. Bound queued events independently
  // of the single request slot. Overflow is reported, never presented as success.
  if (identifier.length > 256 || action.length > 256) { state->eventOverflow.fetch_add(1); return; }
  if (state->eventQueued.fetch_add(1) >= 16) {
    state->eventQueued.fetch_sub(1); state->eventOverflow.fetch_add(1); return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    @autoreleasepool {
      state->eventQueued.fetch_sub(1);
      if (state->released) return;
      @try {
        try {
          unsigned overflow = state->eventOverflow.exchange(0);
          if (overflow) Emit(state, @"notificationEventOverflow", 0, @{ @"count":@(overflow) });
          NSString *id = OwnedID(state, identifier);
          if (!id) return;
          NSDictionary *entry = state->notifications[id];
          Emit(state, presented ? @"notificationPresented" : @"notificationClicked", 0,
            @{ @"id":id, @"action":action ?: @"", @"target":entry[@"target"] });
          if (!presented) { Revoke(state, id); state->notifications[id] = @{ @"target":entry[@"target"], @"cancelled":@YES }; }
        } catch (const std::exception &error) { fprintf(stderr, "notification event: %s\n", error.what()); }
      } @catch (NSException *error) { fprintf(stderr, "notification event exception: %s\n", error.reason.UTF8String); }
    }
  });
}
@interface OCNativeDelegate : NSObject <UNUserNotificationCenterDelegate> { @public std::weak_ptr<State> state; }
@end
@implementation OCNativeDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
  auto owner = state.lock();
  bool owned = owner && !owner->released.load() && [notification.request.identifier hasPrefix:owner->prefix];
  if (owned) DelegateEvent(owner, notification.request.identifier, @"", true);
  completion(owned ? UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList : UNNotificationPresentationOptionNone);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))completion {
  auto owner = state.lock();
  if (owner) DelegateEvent(owner, response.notification.request.identifier, response.actionIdentifier, false);
  completion();
}
@end
