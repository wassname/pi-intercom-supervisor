# Reload watcher crash

Pi/OpenAI review: the worker watch interval had no session_shutdown cleanup. Reload invalidated the captured context, then the old timer called ctx.isIdle() outside its rejection handler, causing the reported uncaught exception.

The fix clears watch/pair timers on shutdown without resetting the saved pairing. Disposed instances ignore late intercom callbacks. In-flight view publication checks disposal after its awaits before using the context or publishing.

The regression starts a paired worker, confirms a watcher exists, shuts down, makes isIdle throw as a stale context would, then invokes the old callback and sends a late look request. Neither calls the stale context nor publishes another view.

Validation: [full test output](20260908-reload-watcher-tests.txt), including:

> # tests 100
> # pass 100
> # fail 0

No user pane or session was operated. This fix is in pi-supervise, separate from the pi-goals mailbox implementation. A newly launched or reloaded extension instance is needed to load the code; existing orphaned timers cannot be removed by changing the source file.

-- Pi/OpenAI
