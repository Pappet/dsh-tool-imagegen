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
 * It also contributes the configuration card in the "Plugins" settings section
 * (`settings.plugin.item`, keyed on the `dsh-tool-imagegen` settings
 * namespace): the scalar tunables plus the model-alias table. The card edits
 * the USER layer over the plugin's cordis config, so clearing a field falls
 * back to the configured value, and a row is only written once it would
 * survive the Host schema. It mounts in a child fiber that waits for
 * `settingsScope`, so a deployment without the settings surface still gets the
 * tool card.
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

        // ------------------------------------------------ settings card
        var NS = "dsh-tool-imagegen";

        var SCALARS = [
            { key: "defaultModel", label: "Standard-Alias", hint: "Alias, den ein Tool-Aufruf ohne Modellangabe benutzt.", kind: "text" },
            { key: "outputDir", label: "Ausgabeverzeichnis", hint: "Wohin Bilder geschrieben werden, relativ zum Workspace.", kind: "text" },
            { key: "showInChat", label: "Im Chat anzeigen", hint: "Bilder in den Chat und in den Modellkontext legen.", kind: "bool" },
            { key: "maxImagesPerCall", label: "Bilder pro Aufruf", hint: "Obergrenze für n.", kind: "int" },
            { key: "maxReferenceBytes", label: "Referenzbild max. (Bytes)", hint: "Größtes einzelnes Referenzbild für Bild-zu-Bild.", kind: "int" },
            { key: "maxReferenceTotalBytes", label: "Referenzbilder gesamt (Bytes)", hint: "Summe aller Referenzbilder eines Aufrufs.", kind: "int" },
        ];

        var labelStyle = { display: "block", font: "500 12px/18px inherit", marginBottom: "2px" };
        var hintStyle = { color: "var(--dsw-alias-label-tertiary, #888)", font: "400 11px/16px inherit" };
        var inputStyle = {
            boxSizing: "border-box", width: "100%", padding: "4px 8px", borderRadius: "6px",
            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
            background: "var(--dsw-alias-bg-input, transparent)", color: "inherit", font: "400 12px/18px inherit",
        };
        var badgeStyle = {
            marginLeft: "6px", padding: "0 6px", borderRadius: "999px", font: "500 10px/16px inherit",
            background: "var(--dsw-alias-bg-badge, rgba(127,127,127,.18))", color: "var(--dsw-alias-label-secondary, #aaa)",
        };
        var invalidStyle = { color: "var(--dsw-alias-label-error, #e5534b)", font: "400 11px/16px inherit" };
        var rowStyle = { display: "grid", gridTemplateColumns: "1fr 1.4fr 1.6fr auto", gap: "6px", alignItems: "start", marginBottom: "6px" };
        var buttonStyle = {
            padding: "4px 10px", borderRadius: "6px", cursor: "pointer", font: "500 12px/18px inherit",
            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
            background: "transparent", color: "inherit",
        };

        /** Snapshot of one settings namespace, re-read on every commit. */
        function useSnapshot(scope) {
            var pair = React.useState(function () { return scope.getSnapshot(); });
            var setState = pair[1];
            React.useEffect(function () {
                setState(scope.getSnapshot());
                return scope.subscribe(function () { setState(scope.getSnapshot()); });
            }, [scope]);
            return pair[0];
        }

        /** A field is overridden when the user layer CARRIES it — an override
         *  equal to the composition value is still an override, and comparing
         *  values could not see it. */
        function isOverridden(user, key) {
            return Boolean(user) && Object.prototype.hasOwnProperty.call(user, key);
        }

        function modelsToRows(models) {
            return Object.keys(models || {}).map(function (alias, i) {
                var entry = models[alias] || {};
                var defaults = entry.defaults;
                return {
                    key: "r" + i + "-" + alias,
                    alias: alias,
                    id: entry.id || "",
                    defaultsText: defaults && Object.keys(defaults).length > 0 ? JSON.stringify(defaults) : "",
                };
            });
        }

        /** Parse one row's defaults field; "" means no defaults. */
        function parseDefaults(text) {
            if (text.trim() === "") return {};
            try {
                var parsed = JSON.parse(text);
                if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
                return parsed;
            } catch (error) { return undefined; }
        }

        /** Per-row problem, or null. The card never writes a registry the
         *  schema would reject afterwards. */
        function rowProblem(row, rows) {
            if (row.alias.trim() === "") return "Alias fehlt";
            if (rows.filter(function (r) { return r.alias.trim() === row.alias.trim(); }).length > 1) return "Alias doppelt";
            if (row.id.trim() === "") return "Modell-Slug fehlt";
            if (parseDefaults(row.defaultsText) === undefined) return "Defaults sind kein JSON-Objekt";
            return null;
        }

        function rowsToModels(rows) {
            var models = {};
            rows.forEach(function (row) {
                models[row.alias.trim()] = { id: row.id.trim(), defaults: parseDefaults(row.defaultsText) };
            });
            return models;
        }

        function Field(props) {
            var spec = props.spec;
            var id = "imagegen-" + spec.key;
            var control = spec.kind === "bool"
                ? e("input", {
                    id: id, type: "checkbox", checked: props.draft === "true", disabled: props.disabled,
                    onChange: function (ev) { props.onEdit(ev.target.checked ? "true" : "false"); },
                })
                : e("input", {
                    id: id, type: "text", value: props.draft, disabled: props.disabled, style: inputStyle,
                    inputMode: spec.kind === "int" ? "numeric" : undefined,
                    onChange: function (ev) { props.onEdit(ev.target.value); },
                });
            return e("div", { style: { marginBottom: "10px" } },
                e("label", { htmlFor: id, style: labelStyle },
                    spec.label,
                    props.overridden ? e("span", { style: badgeStyle }, "überschrieben") : null),
                control,
                e("div", { style: props.invalid ? invalidStyle : hintStyle },
                    props.invalid
                        ? (spec.kind === "int" ? "Ganze Zahl ≥ 1 erwartet" : "Darf nicht leer sein")
                        : spec.hint),
                props.overridden && !props.disabled
                    ? e("button", { type: "button", style: buttonStyle, onClick: props.onReset }, "Auf Konfiguration zurücksetzen")
                    : null);
        }

        function draftOf(spec, value) {
            var raw = value === undefined ? "" : value;
            return spec.kind === "bool" ? (raw ? "true" : "false") : String(raw);
        }

        function parseScalar(spec, draft) {
            if (spec.kind === "bool") return draft === "true";
            if (spec.kind !== "int") return draft.trim() === "" ? undefined : draft;
            var n = Number(draft);
            return Number.isInteger(n) && n >= 1 ? n : undefined;
        }

        function SettingsCard() {
            var scope = SettingsCard.scope;
            var snapshot = useSnapshot(scope);
            var value = snapshot.value;
            var disabled = !snapshot.writable || snapshot.status !== "ready";

            var draftPair = React.useState({});
            var drafts = draftPair[0];
            var setDrafts = draftPair[1];
            var rowsPair = React.useState(null);
            var rows = rowsPair[0];
            var setRows = rowsPair[1];
            var busyPair = React.useState(false);
            var errorPair = React.useState(null);

            // Adopt committed state only while nothing is being edited, so a
            // background commit never overwrites what the user is typing.
            var clean = Object.keys(drafts).length === 0 && rows === null;
            React.useEffect(function () {
                if (value && clean) setRows(modelsToRows(value.models));
            }, [value, clean]);

            if (snapshot.status === "loading") return e("div", { style: hintStyle }, "Einstellungen werden geladen …");
            if (snapshot.status === "unavailable" || !value) {
                return e("div", { style: hintStyle }, "Dieses Deployment stellt die Einstellungen von dsh-tool-imagegen nicht bereit.");
            }

            var currentRows = rows === null ? modelsToRows(value.models) : rows;
            var problems = currentRows.map(function (row) { return rowProblem(row, currentRows); });
            var scalarInvalid = SCALARS.some(function (spec) {
                return drafts[spec.key] !== undefined && parseScalar(spec, drafts[spec.key]) === undefined;
            });
            var blocked = scalarInvalid || problems.some(function (p) { return p !== null; });
            var modelsDirty = rows !== null && JSON.stringify(rowsToModels(currentRows)) !== JSON.stringify(value.models || {});
            var dirty = modelsDirty || SCALARS.some(function (spec) {
                return drafts[spec.key] !== undefined && drafts[spec.key] !== draftOf(spec, value[spec.key]);
            });

            var edit = function (key, text) {
                setDrafts(function (prev) {
                    var next = Object.assign({}, prev);
                    next[key] = text;
                    return next;
                });
            };

            var write = function (run) {
                busyPair[1](true);
                errorPair[1](null);
                run().then(function () {
                    setDrafts({});
                    setRows(null);
                }).catch(function (error) {
                    errorPair[1](error && error.message ? error.message : String(error));
                }).then(function () { busyPair[1](false); });
            };

            var save = function () {
                write(function () {
                    var writes = [];
                    SCALARS.forEach(function (spec) {
                        var draft = drafts[spec.key];
                        if (draft === undefined || draft === draftOf(spec, value[spec.key])) return;
                        writes.push(scope.set(spec.key, parseScalar(spec, draft)));
                    });
                    if (modelsDirty) writes.push(scope.set("models", rowsToModels(currentRows)));
                    return Promise.all(writes);
                });
            };

            var setRow = function (index, patch) {
                setRows(currentRows.map(function (row, i) { return i === index ? Object.assign({}, row, patch) : row; }));
            };

            return e("div", { style: { padding: "12px 0" }, "data-plugin-card": NS },
                e("h4", { style: { margin: "0 0 2px", font: "600 13px/20px inherit" } }, "Bildgenerierung"),
                e("div", { style: Object.assign({ marginBottom: "12px" }, hintStyle) },
                    "Überschreibt die Plugin-Konfiguration. Änderungen wirken sofort, ohne Neustart."),

                SCALARS.map(function (spec) {
                    var draft = drafts[spec.key] !== undefined ? drafts[spec.key] : draftOf(spec, value[spec.key]);
                    return e(Field, {
                        key: spec.key,
                        spec: spec,
                        draft: draft,
                        disabled: disabled,
                        overridden: isOverridden(snapshot.user, spec.key),
                        invalid: drafts[spec.key] !== undefined && parseScalar(spec, draft) === undefined,
                        onEdit: function (text) { edit(spec.key, text); },
                        onReset: function () { write(function () { return scope.unset(spec.key); }); },
                    });
                }),

                e("div", { style: { marginTop: "14px" } },
                    e("label", { style: labelStyle },
                        "Modell-Aliase",
                        isOverridden(snapshot.user, "models") ? e("span", { style: badgeStyle }, "überschrieben") : null),
                    e("div", { style: Object.assign({ marginBottom: "6px" }, hintStyle) },
                        "Der Alias ist zugleich die Allowlist: ein Modell ohne Alias ist nicht erreichbar."),
                    e("div", { style: Object.assign({}, rowStyle, { font: "500 11px/16px inherit", color: "var(--dsw-alias-label-tertiary, #888)" }) },
                        e("div", null, "Alias"), e("div", null, "Modell-Slug"), e("div", null, "Defaults (JSON)"), e("div", null, "")),
                    currentRows.map(function (row, i) {
                        return e("div", { key: row.key },
                            e("div", { style: rowStyle },
                                e("input", {
                                    type: "text", value: row.alias, disabled: disabled, style: inputStyle,
                                    onChange: function (ev) { setRow(i, { alias: ev.target.value }); },
                                }),
                                e("input", {
                                    type: "text", value: row.id, disabled: disabled, style: inputStyle,
                                    placeholder: "anbieter/modell",
                                    onChange: function (ev) { setRow(i, { id: ev.target.value }); },
                                }),
                                e("input", {
                                    type: "text", value: row.defaultsText, disabled: disabled, style: inputStyle,
                                    placeholder: '{"resolution":"2K"}',
                                    onChange: function (ev) { setRow(i, { defaultsText: ev.target.value }); },
                                }),
                                e("button", {
                                    type: "button", style: buttonStyle, disabled: disabled,
                                    title: "Alias entfernen",
                                    onClick: function () { setRows(currentRows.filter(function (_, j) { return j !== i; })); },
                                }, "✕")),
                            problems[i] ? e("div", { style: Object.assign({ marginBottom: "6px" }, invalidStyle) }, problems[i]) : null);
                    }),
                    e("div", { style: { display: "flex", gap: "8px", marginTop: "4px" } },
                        e("button", {
                            type: "button", style: buttonStyle, disabled: disabled,
                            onClick: function () {
                                setRows(currentRows.concat([{ key: "neu-" + Date.now(), alias: "", id: "", defaultsText: "" }]));
                            },
                        }, "Alias hinzufügen"),
                        isOverridden(snapshot.user, "models") && !disabled
                            ? e("button", {
                                type: "button", style: buttonStyle,
                                onClick: function () { write(function () { return scope.unset("models"); }); },
                            }, "Auf Konfiguration zurücksetzen")
                            : null)),

                e("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "14px" } },
                    e("button", {
                        type: "button",
                        style: Object.assign({}, buttonStyle, { opacity: !dirty || blocked || busyPair[0] || disabled ? 0.5 : 1 }),
                        disabled: !dirty || blocked || busyPair[0] || disabled,
                        onClick: save,
                    }, busyPair[0] ? "Speichert …" : "Speichern"),
                    dirty && !blocked ? e("span", { style: hintStyle }, "Ungespeicherte Änderungen") : null,
                    blocked ? e("span", { style: invalidStyle }, "Erst die markierten Felder korrigieren") : null,
                    !snapshot.writable ? e("span", { style: hintStyle }, "Dieses Deployment speichert Einstellungen schreibgeschützt.") : null),
                errorPair[0] ? e("div", { style: Object.assign({ marginTop: "6px" }, invalidStyle) }, errorPair[0]) : null);
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

            // The settings card waits for its service in a CHILD fiber rather
            // than riding this plugin's own `inject`: a deployment without the
            // settings surface then loses the card only, not the tool view.
            var mountSettings = function (settingsCtx) {
                var binder = settingsCtx.settingsScope;
                if (!binder || typeof binder.bind !== "function") return;
                SettingsCard.scope = binder.bind({ namespace: NS });
                settingsCtx.slots.inject("settings.plugin.item", function () {
                    return settingsCtx.slots.register({
                        name: "settings.plugin.item",
                        key: NS,
                    }, function () { return React.createElement(SettingsCard, null); });
                });
            };
            if (typeof ctx.inject === "function") ctx.inject(["settingsScope"], mountSettings);
            else if (typeof ctx.get === "function" && ctx.get("settingsScope")) mountSettings(ctx);
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
