#import <AppKit/AppKit.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <QuartzCore/CATransaction.h>
#import <objc/runtime.h>
#include <stdint.h>

@interface OCGPUIAcceptanceScrollEvent : NSEvent
@property(nonatomic) NSPoint acceptanceLocation;
@property(nonatomic,weak) NSWindow *acceptanceWindow;
@property(nonatomic) CGFloat acceptanceDelta;
@end
@implementation OCGPUIAcceptanceScrollEvent
- (NSEventType)type{return NSEventTypeScrollWheel;}
- (NSPoint)locationInWindow{return self.acceptanceLocation;}
- (NSWindow *)window{return self.acceptanceWindow;}
- (NSInteger)windowNumber{return self.acceptanceWindow.windowNumber;}
- (CGFloat)scrollingDeltaX{return 0;}
- (CGFloat)scrollingDeltaY{return self.acceptanceDelta;}
- (BOOL)hasPreciseScrollingDeltas{return YES;}
- (NSEventPhase)phase{return NSEventPhaseNone;}
- (NSEventPhase)momentumPhase{return NSEventPhaseNone;}
- (BOOL)isDirectionInvertedFromDevice{return NO;}
- (NSEventModifierFlags)modifierFlags{return 0;}
- (NSTimeInterval)timestamp{return NSProcessInfo.processInfo.systemUptime;}
@end

// Acceptance-only capture of the actual GPUI drawable. No visible window,
// screen permission, or substitute renderer is used.
static NSMapTable<CAMetalLayer *, id<MTLTexture>> *textures;
static NSMapTable<NSWindow *,NSNumber *> *pressedButtons;
static id<CAMetalDrawable> (*originalNextDrawable)(id, SEL);
static void (*originalCommit)(id,SEL);
static bool synchronousFrame=false,drawFailed=false;
static void captureCommit(id<MTLCommandBuffer> command,SEL selector) {
    if(!synchronousFrame||!NSThread.isMainThread){originalCommit(command,selector);return;}
    dispatch_semaphore_t completed=dispatch_semaphore_create(0);
    [command addCompletedHandler:^(id<MTLCommandBuffer> buffer){dispatch_semaphore_signal(completed);}];
    originalCommit(command,selector);
    if(dispatch_semaphore_wait(completed,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))!=0||command.status!=MTLCommandBufferStatusCompleted)drawFailed=true;
}
static id<CAMetalDrawable> captureNextDrawable(CAMetalLayer *layer, SEL selector) {
    layer.framebufferOnly = NO;
    id<CAMetalDrawable> drawable = originalNextDrawable(layer, selector);
    if (drawable && textures.count < 8) [textures setObject:drawable.texture forKey:layer];
    return drawable;
}
extern "C" void oc_gpui_capture_init() {
    NSCAssert(NSThread.isMainThread, @"main thread required");
    textures = [NSMapTable weakToStrongObjectsMapTable];
    pressedButtons=[NSMapTable weakToStrongObjectsMapTable];
    Method method = class_getInstanceMethod(CAMetalLayer.class, @selector(nextDrawable));
    originalNextDrawable = (id<CAMetalDrawable> (*)(id, SEL))method_getImplementation(method);
    method_setImplementation(method, (IMP)captureNextDrawable);
    id<MTLDevice> device=MTLCreateSystemDefaultDevice();id<MTLCommandQueue> queue=[device newCommandQueue];id<MTLCommandBuffer> command=[queue commandBuffer];
    Method commit=class_getInstanceMethod(object_getClass(command),@selector(commit));NSCAssert(commit,@"Metal commit method required");
    originalCommit=(void (*)(id,SEL))method_getImplementation(commit);method_setImplementation(commit,(IMP)captureCommit);
}
static CAMetalLayer *findLayer(CALayer *layer) {
    if ([layer isKindOfClass:CAMetalLayer.class]) return (CAMetalLayer *)layer;
    for (CALayer *child in layer.sublayers) { CAMetalLayer *found = findLayer(child); if (found) return found; }
    return nil;
}
static CAMetalLayer *findViewLayer(NSView *view,NSUInteger depth) {
    if(!view||depth>16)return nil;CAMetalLayer *layer=findLayer(view.layer);if(layer)return layer;
    for(NSView *child in view.subviews){layer=findViewLayer(child,depth+1);if(layer)return layer;}return nil;
}
extern "C" int oc_gpui_draw(uint64_t pointer) {
    if(!NSThread.isMainThread||!pointer)return 1;
    NSWindow *window=(__bridge NSWindow *)(void *)pointer;CAMetalLayer *layer=findViewLayer(window.contentView,0);
    if(!layer)return 2;drawFailed=false;synchronousFrame=true;[layer.delegate displayLayer:layer];[CATransaction flush];synchronousFrame=false;return drawFailed?3:0;
}
extern "C" int oc_gpui_capture(uint64_t pointer, const char *output) {
    @autoreleasepool {
        if (!NSThread.isMainThread || !pointer || !output) return 1;
        NSWindow *window = (__bridge NSWindow *)(void *)pointer;
        CAMetalLayer *layer = findViewLayer(window.contentView,0);
        if (!layer) return 2;
        int status=oc_gpui_draw(pointer);if(status)return status;
        id<MTLTexture> texture = [textures objectForKey:layer];
        if (!texture || texture.width * texture.height > 8000000) return 2;
        NSUInteger stride = ((texture.width * 4 + 255) / 256) * 256;
        id<MTLBuffer> buffer = [texture.device newBufferWithLength:stride * texture.height options:MTLResourceStorageModeShared];
        id<MTLCommandQueue> queue = [texture.device newCommandQueue];
        if (!buffer || !queue) return 3;
        id<MTLCommandBuffer> command = [queue commandBuffer];
        id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
        [blit copyFromTexture:texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(texture.width,texture.height,1) toBuffer:buffer destinationOffset:0 destinationBytesPerRow:stride destinationBytesPerImage:stride * texture.height];
        [blit endEncoding]; [command commit]; [command waitUntilCompleted];
        if (command.status != MTLCommandBufferStatusCompleted) return 4;
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:texture.width pixelsHigh:texture.height bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bitmapFormat:0 bytesPerRow:stride bitsPerPixel:32];
        if (!bitmap) return 5;
        const uint8_t *source = (const uint8_t *)buffer.contents; uint8_t *destination = bitmap.bitmapData;
        for (NSUInteger y=0;y<texture.height;y++) for (NSUInteger x=0;x<texture.width;x++) {
            NSUInteger p=y*stride+x*4; destination[p]=source[p+2]; destination[p+1]=source[p+1]; destination[p+2]=source[p]; destination[p+3]=source[p+3];
        }
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        return [png writeToFile:[NSString stringWithUTF8String:output] options:NSDataWritingWithoutOverwriting error:nil] ? 0 : 6;
    }
}
extern "C" int oc_gpui_mouse(uint64_t pointer,double x,double y,int kind,bool right) {
    @autoreleasepool {
        if (!NSThread.isMainThread || !pointer || kind<0 || kind>2) return 1;
        NSWindow *window=(__bridge NSWindow *)(void *)pointer;
        CAMetalLayer *layer=findViewLayer(window.contentView,0);NSView *view=(NSView *)layer.delegate;if(![view isKindOfClass:NSView.class])return 3;
        NSPoint location=NSMakePoint(x,view.bounds.size.height-y);
        NSNumber *pressed=[pressedButtons objectForKey:window];bool dragging=kind==2&&pressed!=nil;bool dragRight=pressed.boolValue;
        NSEventType type=kind==0?(right?NSEventTypeRightMouseDown:NSEventTypeLeftMouseDown):kind==1?(right?NSEventTypeRightMouseUp:NSEventTypeLeftMouseUp):dragging?(dragRight?NSEventTypeRightMouseDragged:NSEventTypeLeftMouseDragged):NSEventTypeMouseMoved;
        NSEvent *event=[NSEvent mouseEventWithType:type location:location modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:kind==0?1.0:0.0];
        if(!event)return 2;
        if(kind==0){if(pressedButtons.count>=8&&!pressed)return 4;[pressedButtons setObject:@(right) forKey:window];if(right)[view rightMouseDown:event];else[view mouseDown:event];}
        else if(kind==1){[pressedButtons removeObjectForKey:window];if(right)[view rightMouseUp:event];else[view mouseUp:event];}
        else if(dragging){if(dragRight)[view rightMouseDragged:event];else[view mouseDragged:event];}else [view mouseMoved:event];
        return 0;
    }
}
extern "C" int oc_gpui_input(uint64_t pointer,const char *json) {
    @autoreleasepool {
        if(!NSThread.isMainThread||!pointer||!json)return 1;
        NSData *data=[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *input=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if(![input isKindOfClass:NSDictionary.class])return 2;
        NSWindow *window=(__bridge NSWindow *)(void *)pointer;CAMetalLayer *layer=findViewLayer(window.contentView,0);NSView *view=(NSView *)layer.delegate;if(![view isKindOfClass:NSView.class])return 9;
        NSString *command=input[@"command"];
        if([command isEqualToString:@"text"]){NSString *text=input[@"text"];if(![text isKindOfClass:NSString.class]||text.length>4096)return 3;if(![view conformsToProtocol:@protocol(NSTextInputClient)])return 9;[(id<NSTextInputClient>)view insertText:text replacementRange:NSMakeRange(NSNotFound,0)];return 0;}
        if([command isEqualToString:@"key"]){
            NSString *key=input[@"key"];if(![key isKindOfClass:NSString.class]||key.length>32)return 3;
            NSDictionary *codes=@{@"a":@0,@"escape":@53,@"tab":@48,@"enter":@36,@"space":@49,@"backspace":@51,@"left":@123,@"right":@124,@"down":@125,@"up":@126,@"home":@115,@"end":@119};
            NSNumber *code=codes[key];if(!code)return 4;
            NSDictionary *characters=@{@"escape":@"\x1b",@"tab":@"\t",@"enter":@"\r",@"space":@" ",@"backspace":@"\x7f",@"left":@"\uf702",@"right":@"\uf703",@"down":@"\uf701",@"up":@"\uf700",@"home":@"\uf729",@"end":@"\uf72b"};
            NSEventModifierFlags flags=0;NSArray *modifiers=input[@"modifiers"]?:@[];if(![modifiers isKindOfClass:NSArray.class]||modifiers.count>4)return 5;
            for(NSString *modifier in modifiers){if([modifier isEqualToString:@"command"])flags|=NSEventModifierFlagCommand;else if([modifier isEqualToString:@"shift"])flags|=NSEventModifierFlagShift;else if([modifier isEqualToString:@"control"])flags|=NSEventModifierFlagControl;else if([modifier isEqualToString:@"alt"])flags|=NSEventModifierFlagOption;else return 5;}
            NSString *text=characters[key]?:key;
            NSEvent *event=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code.unsignedShortValue];
            [view keyDown:event];return 0;
        }
        if([command isEqualToString:@"scroll"]){
            double x=[input[@"x"] doubleValue],y=[input[@"y"] doubleValue],delta=[input[@"deltaY"] doubleValue];
            if(!isfinite(x)||!isfinite(y)||!isfinite(delta)||fabs(delta)>2000)return 6;
            OCGPUIAcceptanceScrollEvent *event=[OCGPUIAcceptanceScrollEvent new];event.acceptanceWindow=window;event.acceptanceLocation=NSMakePoint(x,view.bounds.size.height-y);event.acceptanceDelta=delta;
            [view scrollWheel:event];return 0;
        }
        return 8;
    }
}
