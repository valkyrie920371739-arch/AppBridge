#import <AppKit/AppKit.h>
#import <mach-o/dyld.h>
#import <crt_externs.h>
#import <stdlib.h>

// Loaded only into the selected Wine game's process. These presentation options
// belong to that NSApplication; no macOS Dock preferences are changed.
static NSApplicationPresentationOptions savedPresentation;
static BOOL changedPresentation = NO;
static NSHashTable<NSWindow *> *configuredWindows;
static NSString *displayMode;
static BOOL hideDock;

// Wine also pumps a private query-response run-loop mode. Use a run-loop
// timer in both modes rather than relying on the GCD main-queue timer source.
static void afterCocoa(NSTimeInterval delay, dispatch_block_t block) {
    CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(NULL, CFAbsoluteTimeGetCurrent() + delay, 0, 0, 0, ^(CFRunLoopTimerRef timer) { block(); });
    CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopCommonModes);
    CFRunLoopAddTimer(CFRunLoopGetMain(), timer, CFSTR("WineAppWaitQueryResponseMode"));
    CFRelease(timer);
    CFRunLoopWakeUp(CFRunLoopGetMain());
}
static void onCocoaThread(dispatch_block_t block) {
    if (NSThread.isMainThread) block();
    else afterCocoa(0, block);
}

static BOOL isGameWindow(NSWindow *window) {
    Class wineWindow = NSClassFromString(@"WineWindow");
    return window && window.isVisible && window.canBecomeKeyWindow &&
           (![window isKindOfClass:[NSPanel class]] || (wineWindow && [window isKindOfClass:wineWindow])) && window.contentView != nil;
}
static void restorePresentation(void) {
    if (!NSThread.isMainThread) { onCocoaThread(^{ restorePresentation(); }); return; }
    if (changedPresentation && NSApp) {
        @try { NSApp.presentationOptions = savedPresentation; } @catch (NSException *exception) {}
        changedPresentation = NO;
    }
}
static void updatePresentation(void) {
    if (!NSThread.isMainThread) { onCocoaThread(^{ updatePresentation(); }); return; }
    if (!NSApp.isActive || !isGameWindow(NSApp.keyWindow) || !hideDock) {
        restorePresentation();
        return;
    }
    if (!changedPresentation) { savedPresentation = NSApp.presentationOptions; changedPresentation = YES; }
    else if (NSApp.presentationOptions & NSApplicationPresentationAutoHideDock) return;
    @try {
        NSApplicationPresentationOptions options = NSApp.presentationOptions | NSApplicationPresentationAutoHideDock;
        options &= ~NSApplicationPresentationHideDock;
        NSApp.presentationOptions = options;
        fprintf(stderr, "[AppBridge display] Dock auto-hide applied to active game\n");
    } @catch (NSException *exception) { restorePresentation(); }
}
static void configureWindow(NSWindow *window) {
    if (!NSThread.isMainThread) { onCocoaThread(^{ configureWindow(window); }); return; }
    if (!configuredWindows) configuredWindows = [NSHashTable weakObjectsHashTable];
    if (!isGameWindow(window)) return;
    updatePresentation();
    if ([configuredWindows containsObject:window]) return;
    [configuredWindows addObject:window];
    fprintf(stderr, "[AppBridge display] Configuring %s window; mode=%s; content=%.0fx%.0f\n", NSStringFromClass(window.class).UTF8String, displayMode.UTF8String, window.contentView.bounds.size.width, window.contentView.bounds.size.height);
    // Set up the window once. Later game-driven size and aspect-ratio changes
    // remain under the control of Wine and the game itself.
    if ([displayMode isEqualToString:@"windowed"] || [displayMode isEqualToString:@"fullscreen"]) {
        @try {
            window.styleMask |= NSWindowStyleMaskResizable;
            window.collectionBehavior = (window.collectionBehavior & ~NSWindowCollectionBehaviorFullScreenAuxiliary & ~NSWindowCollectionBehaviorCanJoinAllSpaces) | NSWindowCollectionBehaviorFullScreenPrimary;
            if ([displayMode isEqualToString:@"windowed"]) {
                window.styleMask |= NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable;
                if (!window.parentWindow) {
                    window.accessibilityRole = NSAccessibilityWindowRole;
                    window.accessibilitySubrole = NSAccessibilityStandardWindowSubrole;
                }
                NSInteger width = atoi(getenv("APPBRIDGE_WINDOW_WIDTH") ?: "1280");
                NSInteger height = atoi(getenv("APPBRIDGE_WINDOW_HEIGHT") ?: "720");
                if (width >= 640 && height >= 360) [window setContentSize:NSMakeSize(width, height)];
                // Unity can restore its saved display preferences after the
                // first key event. Apply the user's requested startup window
                // once after that phase, then leave all later changes alone.
                afterCocoa(2, ^{
                    if (!isGameWindow(window)) return;
                    @try {
                        Class wineWindow = NSClassFromString(@"WineWindow");
                        if (wineWindow && [window isKindOfClass:wineWindow]) {
                            // This is the pinned Wine 10 WineWindow BOOL ivar;
                            // it controls Wine's own resize-constraint cache.
                            [window setValue:@YES forKey:@"resizable"];
                        }
                        window.contentMinSize = NSMakeSize(320, 180);
                        window.contentMaxSize = NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
                        window.styleMask |= NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
                        if (!window.parentWindow) {
                            window.accessibilityRole = NSAccessibilityWindowRole;
                            window.accessibilitySubrole = NSAccessibilityStandardWindowSubrole;
                            NSAccessibilityPostNotification(window, NSAccessibilityLayoutChangedNotification);
                        }
                        [window setContentSize:NSMakeSize(width, height)];
                        [window center];
                        [window makeFirstResponder:window.contentView];
                        fprintf(stderr, "[AppBridge display] Startup window applied: %.0fx%.0f; style=%lu\n", window.contentView.bounds.size.width, window.contentView.bounds.size.height, (unsigned long)window.styleMask);
                        afterCocoa(3, ^{
                            if (window.isVisible) fprintf(stderr, "[AppBridge display] Window follow-up: content=%.0fx%.0f frame=%.0fx%.0f style=%lu active=%d\n", window.contentView.bounds.size.width, window.contentView.bounds.size.height, window.frame.size.width, window.frame.size.height, (unsigned long)window.styleMask, NSApp.isActive);
                        });
                        updatePresentation();
                    } @catch (NSException *exception) { fprintf(stderr, "[AppBridge display] Startup window failed: %s\n", exception.reason.UTF8String); }
                });
            }
        } @catch (NSException *exception) { fprintf(stderr, "[AppBridge display] Window setup failed: %s\n", exception.reason.UTF8String); }
    }
    if ([displayMode isEqualToString:@"fullscreen"]) {
        afterCocoa(1, ^{
            if (isGameWindow(window) && !(window.styleMask & NSWindowStyleMaskFullScreen)) {
                @try { [window toggleFullScreen:nil]; fprintf(stderr, "[AppBridge display] Native fullscreen requested\n"); } @catch (NSException *exception) { fprintf(stderr, "[AppBridge display] Fullscreen failed: %s\n", exception.reason.UTF8String); }
            }
        });
    }
}
__attribute__((constructor)) static void initializeAppBridgeDisplay(void) {
    @autoreleasepool {
        const char *target = getenv("APPBRIDGE_GAME_EXE");
        if (!target) return;
        // Wine helpers inherit the environment. Never change their windows.
        char **arguments = *_NSGetArgv();
        int count = *_NSGetArgc();
        BOOL matches = NO;
        for (int index = 0; index < count; index++) if (arguments[index] && strcmp(arguments[index], target) == 0) matches = YES;
        if (!matches) return;
        displayMode = [NSString stringWithUTF8String:getenv("APPBRIDGE_DISPLAY_MODE") ?: "app"];
        hideDock = strcmp(getenv("APPBRIDGE_HIDE_DOCK") ?: "0", "1") == 0;
        fprintf(stderr, "[AppBridge display] Helper attached; mode=%s; hideDock=%d\n", displayMode.UTF8String, hideDock);
        onCocoaThread(^{
            configuredWindows = [NSHashTable weakObjectsHashTable];
            fprintf(stderr, "[AppBridge display] Window observers ready\n");
            afterCocoa(1, ^{
                for (NSWindow *window in NSApp.windows) {
                    fprintf(stderr, "[AppBridge display] Initial window: %s visible=%d canKey=%d active=%d\n", NSStringFromClass(window.class).UTF8String, window.isVisible, window.canBecomeKeyWindow, NSApp.isActive);
                    configureWindow(window);
                }
            });
            NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
            [center addObserverForName:NSWindowDidBecomeKeyNotification object:nil queue:nil usingBlock:^(NSNotification *note) { configureWindow(note.object); }];
            [center addObserverForName:NSApplicationDidBecomeActiveNotification object:nil queue:nil usingBlock:^(NSNotification *note) { configureWindow(NSApp.keyWindow); }];
            [center addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:nil usingBlock:^(NSNotification *note) { restorePresentation(); }];
            [center addObserverForName:NSWindowDidResignKeyNotification object:nil queue:nil usingBlock:^(NSNotification *note) { onCocoaThread(^{ updatePresentation(); }); }];
            [center addObserverForName:NSWindowWillCloseNotification object:nil queue:nil usingBlock:^(NSNotification *note) { if ([configuredWindows containsObject:note.object]) restorePresentation(); }];
            [center addObserverForName:NSApplicationWillTerminateNotification object:nil queue:nil usingBlock:^(NSNotification *note) { restorePresentation(); }];
            [center addObserverForName:NSWindowDidEndLiveResizeNotification object:nil queue:nil usingBlock:^(NSNotification *note) { onCocoaThread(^{ NSWindow *window = note.object; if (isGameWindow(window)) fprintf(stderr, "[AppBridge display] User resized window: %.0fx%.0f\n", window.contentView.bounds.size.width, window.contentView.bounds.size.height); }); }];
            configureWindow(NSApp.keyWindow);
        });
    }
}
