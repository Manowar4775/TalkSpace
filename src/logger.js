// Optional browser diagnostics. Add ?talkspaceDebug=1 to the URL to enable.
(function initializeTalkSpaceLogger(root) {
    const enabled = new URLSearchParams(root.location.search).get("talkspaceDebug") === "1";

    root.TalkSpaceLogger = Object.freeze({
        enabled,
        debug(...details) {
            if (enabled) {
                console.debug("[TalkSpace]", ...details);
            }
        }
    });
})(window);
