"use strict";

(function initializeTurnstileLifecycle(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.TalkSpaceTurnstileLifecycle = api;
    }
})(typeof globalThis === "object" ? globalThis : this, function createLifecycleApi() {
    const DEFAULT_INTERVAL_MS = 500;
    const DEFAULT_MAX_WAIT_MS = 15000;

    function createWaiter({
        getLibrary,
        intervalMs = DEFAULT_INTERVAL_MS,
        maxWaitMs = DEFAULT_MAX_WAIT_MS,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        now = Date.now
    }) {
        let generation = 0;
        let active = null;

        function cancel() {
            generation += 1;
            if (!active) return;

            const pending = active;
            active = null;
            if (pending.timer !== null) {
                clearTimeoutFn(pending.timer);
            }
            pending.resolve(false);
        }

        function wait({ isCurrent = () => true, onReady, onTimeout } = {}) {
            if (active) return active.promise;

            const id = ++generation;
            const startedAt = now();
            let resolvePromise;
            const promise = new Promise(resolve => { resolvePromise = resolve; });
            const pending = {
                id,
                promise,
                resolve: resolvePromise,
                timer: null
            };
            active = pending;

            function finish(result, callback) {
                if (active !== pending || generation !== id) return;
                active = null;
                if (pending.timer !== null) {
                    clearTimeoutFn(pending.timer);
                    pending.timer = null;
                }
                try {
                    callback?.();
                } finally {
                    pending.resolve(result);
                }
            }

            function poll() {
                if (active !== pending || generation !== id) return;
                if (!isCurrent()) {
                    finish(false);
                    return;
                }

                const library = getLibrary();
                if (library) {
                    finish(true, () => onReady?.(library));
                    return;
                }

                const remainingMs = maxWaitMs - (now() - startedAt);
                if (remainingMs <= 0) {
                    finish(false, onTimeout);
                    return;
                }

                pending.timer = setTimeoutFn(
                    poll,
                    Math.min(intervalMs, remainingMs)
                );
            }

            poll();
            return promise;
        }

        return {
            wait,
            cancel,
            get isWaiting() {
                return active !== null;
            }
        };
    }

    return {
        DEFAULT_INTERVAL_MS,
        DEFAULT_MAX_WAIT_MS,
        createWaiter
    };
});
