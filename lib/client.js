/**
 * dsh-tool-imagegen — client half (browser bundle, served at
 * /plugins/dsh-tool-imagegen/client.js through the `dsh.client` manifest).
 *
 * Registers the keyed `tool.call.toolview` view for the wire tool name
 * `generate_image`, replacing the generic text card with an inline image card:
 *
 * - pending call: prompt excerpt with a running marker;
 * - settled result: the generated image(s) rendered inline, loaded through the
 *   session's `readAttachment` from the durable attachment refs the tool put
 *   into its `presentationMeta` (the same store the chat gallery uses);
 *   click opens the file through the Host opener;
 * - anything unavailable (no meta, no attachment service, load failure)
 *   degrades to the plain path list — never a crash.
 *
 * Styled with Harness design tokens (`--dsw-alias-*`) so it follows the theme.
 */
window.__ModuleLoader__.load({
    id: "dsh-tool-imagegen",
    factory: function (require) {
        var module = { exports: {} };
        var exports = module.exports;
        var React = require("react");

        function e(tag, attrs) {
            var children = Array.prototype.slice.call(arguments, 2);
            return React.createElement.apply(React, [tag, attrs].concat(children));
        }

        function metaOf(block) {
            return block && block.kind === "tool-result" && !block.isError ? block.meta : null;
        }

        function pathsOf(meta) {
            return ((meta && meta.images) || []).map(function (i) { return i.path; });
        }

        function currentSessionId(sessions) {
            try {
                var state = sessions.list.getSnapshot();
                return state && state.current;
            } catch (error) {
                return undefined;
            }
        }

        var cardStyle = { minWidth: 0, padding: "2px 0" };
        var imgStyle = {
            display: "block",
            maxWidth: "100%",
            maxHeight: "360px",
            borderRadius: "10px",
            border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))",
            cursor: "zoom-in",
        };
        var captionStyle = {
            color: "var(--dsw-alias-label-tertiary, #888)",
            font: "400 12px/18px var(--ds-font-family-code, monospace)",
            marginTop: "4px",
            overflowWrap: "anywhere",
            cursor: "pointer",
        };
        var pendingStyle = {
            color: "var(--dsw-alias-label-tertiary, #888)",
            font: "400 13px/20px var(--ds-font-family-code, monospace)",
        };

        function ImageCard(props) {
            var block = props.block;
            var openFile = props.openFile;
            var meta = metaOf(block);
            var refs = (meta && meta.attachments) || [];
            var paths = pathsOf(meta);

            var pair = React.useState({});
            var urls = pair[0];
            var setUrls = pair[1];
            var failedPair = React.useState(false);
            var failed = failedPair[0];
            var setFailed = failedPair[1];

            var refKey = refs.map(function (r) { return r.attachmentId; }).join(",");

            React.useEffect(function () {
                if (!ImageCard.sessions || refs.length === 0) return undefined;
                var cancelled = false;
                var created = [];
                refs.forEach(function (ref) {
                    var sessionId = currentSessionId(ImageCard.sessions);
                    var binding = sessionId ? ImageCard.sessions.binding(sessionId) : undefined;
                    if (!binding || !binding.session || !binding.session.readAttachment) {
                        setFailed(true);
                        return;
                    }
                    binding.session.readAttachment(ref.attachmentId).then(function (result) {
                        if (cancelled) return;
                        if (!result || result.ok !== true) { setFailed(true); return; }
                        var blob = new Blob([result.value.data], { type: result.value.attachment.mediaType });
                        var url = URL.createObjectURL(blob);
                        created.push(url);
                        setUrls(function (prev) {
                            var next = Object.assign({}, prev);
                            next[ref.attachmentId] = url;
                            return next;
                        });
                    }).catch(function () {
                        if (!cancelled) setFailed(true);
                    });
                });
                return function () {
                    cancelled = true;
                    created.forEach(function (url) { URL.revokeObjectURL(url); });
                };
            }, [refKey]);

            // Pending call: prompt excerpt + running marker.
            if (!meta) {
                var prompt = "";
                try {
                    var argsRaw = block && block.argsRaw;
                    prompt = argsRaw ? (JSON.parse(argsRaw).prompt || "") : "";
                } catch (error) { prompt = ""; }
                return e("div", { style: cardStyle, "data-tool": "generate_image" },
                    e("div", { style: pendingStyle },
                        "🎨 ", (prompt || "Bild").slice(0, 120), " …"));
            }

            // Settled: images when loadable, otherwise the plain path list.
            var children = [];
            refs.forEach(function (ref) {
                var url = urls[ref.attachmentId];
                if (url) {
                    children.push(e("img", {
                        key: ref.attachmentId,
                        src: url,
                        alt: ref.name || "Generated image",
                        style: imgStyle,
                        onClick: function () { if (openFile && paths[0]) openFile(paths[0]); },
                    }));
                } else if (!failed) {
                    children.push(e("div", {
                        key: ref.attachmentId + "-loading",
                        style: Object.assign({}, pendingStyle, {
                            width: "100%", maxWidth: "420px", height: "120px",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            border: "1px dashed var(--dsw-alias-border-secondary, rgba(127,127,127,.35))",
                            borderRadius: "10px",
                        }),
                    }, "Bild lädt …"));
                }
            });
            paths.forEach(function (path, i) {
                children.push(e("div", {
                    key: "p" + i,
                    style: captionStyle,
                    title: path,
                    onClick: function () { if (openFile) openFile(path); },
                }, path));
            });
            return e("div", { style: cardStyle, "data-tool": "generate_image" }, children);
        }

        var inject = ["slots", "sessions"];

        /**
         * Client plugin body: register the keyed generate_image tool card.
         * @param ctx - client root context.
         */
        function apply(ctx) {
            ImageCard.sessions = ctx.get("sessions");
            ctx.slots.inject("tool.call.toolview", function () {
                return ctx.slots.register({
                    name: "tool.call.toolview",
                    key: "generate_image",
                }, function (props) { return React.createElement(ImageCard, props); });
            });
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
