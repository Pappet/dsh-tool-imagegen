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
                var t = props.t || fallbackT;
                var prompt = "";
                try {
                    var argsRaw = block && block.argsRaw;
                    prompt = argsRaw ? (JSON.parse(argsRaw).prompt || "") : "";
                } catch (error) { prompt = ""; }
                return e("div", { style: cardStyle, "data-tool": "generate_image" },
                    e("div", { style: pendingStyle },
                        "🎨 ", (prompt || t("imagePending")).slice(0, 120), " …"));
            }

            // Settled: images when loadable, otherwise the plain path list.
            var children = [];
            refs.forEach(function (ref) {
                var url = urls[ref.attachmentId];
                if (url) {
                    children.push(e("img", {
                        key: ref.attachmentId,
                        src: url,
                        alt: ref.name || (props.t || fallbackT)("imageAlt"),
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
                    }, (props.t || fallbackT)("imageLoading")));
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

        /** English copy for both cards. Also the fallback when no locale
         *  service is bound, so every string has a value without one. */
        var en = {
            title: "Image generation",
            description: "Overrides the plugin configuration. Changes apply immediately, no restart.",
            loading: "Loading settings…",
            unavailable: "This deployment does not expose this plugin's settings.",
            readOnly: "This deployment stores settings read-only.",
            unsaved: "Unsaved",
            overridden: "Overridden",
            reset: "Reset",
            discard: "Discard",
            save: "Save",
            saving: "Saving…",
            blocked: "Correct the marked fields first",
            invalidInt: "Whole number ≥ 1 expected",
            invalidMib: "Number greater than 0 expected",
            invalidEmpty: "Must not be empty",
            label_defaultModel: "Default alias",
            hint_defaultModel: "Alias used by a tool call that names no model.",
            label_outputDir: "Output directory",
            hint_outputDir: "Where images are written, relative to the workspace.",
            label_showInChat: "Show in chat",
            hint_showInChat: "Put images into the chat and into the model context.",
            label_maxImagesPerCall: "Images per call",
            hint_maxImagesPerCall: "Upper bound on n.",
            label_maxReferenceBytes: "Reference image max. (MiB)",
            hint_maxReferenceBytes: "Largest single reference image for image-to-image. Base64 adds roughly a third on the wire.",
            label_maxReferenceTotalBytes: "Reference images total (MiB)",
            hint_maxReferenceTotalBytes: "Sum of all reference images of one call.",
            modelsLabel: "Model aliases",
            modelsHint: "The alias is also the allowlist: a model without an alias cannot be reached.",
            colAlias: "Alias",
            colId: "Model slug",
            colDefaults: "Defaults (JSON)",
            placeholderId: "provider/model",
            addRow: "+ Add alias",
            removeRow: "Remove",
            removeRowAria: "Remove alias",
            rowNoAlias: "Alias missing",
            rowDuplicate: "Alias listed twice",
            rowNoId: "Model slug missing",
            rowBadDefaults: "Defaults are not a JSON object",
            imagePending: "Image",
            imageLoading: "Loading image…",
            imageAlt: "Generated image",
        };

        /** Simplified Chinese copy. */
        var zh = {
            title: "图像生成",
            description: "覆盖插件配置。修改立即生效，无需重启。",
            loading: "正在加载设置…",
            unavailable: "本部署未公开该插件的设置。",
            readOnly: "本部署的设置为只读。",
            unsaved: "未保存",
            overridden: "已覆盖",
            reset: "重置",
            discard: "放弃修改",
            save: "保存",
            saving: "保存中…",
            blocked: "请先修正标记的字段",
            invalidInt: "需填写不小于 1 的整数",
            invalidMib: "需填写大于 0 的数字",
            invalidEmpty: "不能为空",
            label_defaultModel: "默认别名",
            hint_defaultModel: "工具调用未指定模型时使用的别名。",
            label_outputDir: "输出目录",
            hint_outputDir: "图像写入位置，相对于工作区。",
            label_showInChat: "在对话中显示",
            hint_showInChat: "将图像放入对话和模型上下文。",
            label_maxImagesPerCall: "每次调用的图像数",
            hint_maxImagesPerCall: "n 的上限。",
            label_maxReferenceBytes: "单张参考图上限（MiB）",
            hint_maxReferenceBytes: "图生图的单张参考图上限。base64 编码后体积约增加三分之一。",
            label_maxReferenceTotalBytes: "参考图总计（MiB）",
            hint_maxReferenceTotalBytes: "一次调用中所有参考图之和。",
            modelsLabel: "模型别名",
            modelsHint: "别名同时也是允许清单：没有别名的模型无法调用。",
            colAlias: "别名",
            colId: "模型标识",
            colDefaults: "默认参数（JSON）",
            placeholderId: "提供方/模型",
            addRow: "+ 添加别名",
            removeRow: "移除",
            removeRowAria: "移除别名",
            rowNoAlias: "缺少别名",
            rowDuplicate: "别名重复",
            rowNoId: "缺少模型标识",
            rowBadDefaults: "默认参数不是 JSON 对象",
            imagePending: "图像",
            imageLoading: "正在加载图像…",
            imageAlt: "生成的图像",
        };

        /** Locale binding when one exists, English otherwise. */
        function fallbackT(key) {
            return en[key] === undefined ? key : en[key];
        }

        // Copy lives in the dictionaries, keyed `label_<key>` / `hint_<key>`.
        var SCALARS = [
            { key: "defaultModel", kind: "text" },
            { key: "outputDir", kind: "text" },
            { key: "showInChat", kind: "bool" },
            { key: "maxImagesPerCall", kind: "int" },
            { key: "maxReferenceBytes", kind: "mib" },
            { key: "maxReferenceTotalBytes", kind: "mib" },
        ];

        // The shell every card in this section wears. The class names are
        // module-hashed and the chevron is a primitives value import, so a
        // third-party card cannot reuse either — these are the same values,
        // restated. Keep them in step with PluginCard.module.css.
        var shellStyle = {
            border: "1px solid var(--dsw-alias-border-l2)",
            background: "var(--dsw-alias-bg-layer-3)",
            borderRadius: "12px", listStyle: "none",
            transition: "border-color .16s, background .16s",
        };
        var shellOpenStyle = {
            background: "var(--dsw-alias-bg-layer-2)",
            borderColor: "var(--dsw-alias-label-dimmed)",
        };
        var headerStyle = {
            appearance: "none", width: "100%", font: "inherit", color: "inherit", textAlign: "left",
            cursor: "pointer", background: "transparent", border: 0, borderRadius: "12px",
            alignItems: "center", gap: "12px", padding: "14px 16px", display: "flex",
        };
        var headTextStyle = { flexDirection: "column", flex: 1, gap: "4px", minWidth: 0, display: "flex" };
        var nameStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "15px", fontWeight: 600, lineHeight: 1.4 };
        var descStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: 1.5 };
        var pillStyle = {
            whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)",
            color: "var(--dsw-alias-label-secondary)", borderRadius: "999px", flex: "none",
            padding: "1px 8px", fontSize: "11px", fontWeight: 500, lineHeight: "17px",
        };
        var bodyStyle = { borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "0 16px", paddingBottom: "8px" };
        var readOnlyStyle = { color: "var(--dsw-alias-label-tertiary)", margin: "12px 0 0", fontSize: "12px", lineHeight: 1.5 };
        var footerStyle = {
            borderTop: "1px solid var(--dsw-alias-border-l2)", justifyContent: "flex-end",
            alignItems: "center", gap: "8px", padding: "12px 0 4px", display: "flex",
        };
        var discardStyle = {
            appearance: "none", font: "inherit", cursor: "pointer", borderRadius: "8px",
            padding: "5px 14px", fontSize: "13px", lineHeight: 1.5,
            border: "1px solid var(--dsw-alias-border-l2)",
            color: "var(--dsw-alias-label-secondary)", background: "transparent",
        };
        var saveStyle = Object.assign({}, discardStyle, {
            border: "1px solid transparent",
            background: "var(--dsw-alias-label-primary)",
            color: "var(--dsw-alias-bg-layer-3)",
        });
        var failedStyle = { minWidth: 0, color: "var(--dsw-alias-label-error)", flex: 1, margin: 0, fontSize: "12px", lineHeight: 1.5 };

        function Chevron(props) {
            return e("svg", {
                width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true,
                style: {
                    color: "var(--dsw-alias-label-tertiary)", flex: "none",
                    transition: "transform .16s", transform: props.open ? "rotate(180deg)" : "none",
                },
            }, e("path", {
                d: "M3.5 5.25 7 8.75l3.5-3.5", fill: "none", stroke: "currentColor",
                strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
            }));
        }

        var rowStyle = { display: "grid", gridTemplateColumns: "1fr 1.4fr 1.6fr auto", gap: "8px", alignItems: "center", marginBottom: "8px" };

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
            return (models || []).map(function (entry, i) {
                var defaults = entry && entry.defaults;
                return {
                    key: "r" + i + "-" + (entry && entry.alias),
                    alias: (entry && entry.alias) || "",
                    id: (entry && entry.id) || "",
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
            if (row.alias.trim() === "") return "rowNoAlias";
            if (rows.filter(function (r) { return r.alias.trim() === row.alias.trim(); }).length > 1) return "rowDuplicate";
            if (row.id.trim() === "") return "rowNoId";
            if (parseDefaults(row.defaultsText) === undefined) return "rowBadDefaults";
            return null;
        }

        /** The list the card writes IS the whole registry — that is what makes a
         *  removed row stay removed (see the settings module's note on layering). */
        function rowsToModels(rows) {
            return rows.map(function (row) {
                return {
                    alias: row.alias.trim(),
                    id: row.id.trim(),
                    defaults: parseDefaults(row.defaultsText),
                };
            });
        }

        function Field(props) {
            var spec = props.spec;
            var id = "imagegen-" + spec.key;
            var control = spec.kind === "bool"
                ? e("input", {
                    id: id, type: "checkbox", checked: props.draft === "true", disabled: props.disabled,
                    style: Object.assign({}, checkboxStyle, { cursor: props.disabled ? "default" : "pointer" }),
                    onChange: function (ev) { props.onEdit(ev.target.checked ? "true" : "false"); },
                })
                : e("input", {
                    id: id, type: "text", value: props.draft, disabled: props.disabled,
                    style: props.invalid ? inputInvalidStyle : inputStyle,
                    inputMode: spec.kind === "int" || spec.kind === "mib" ? "numeric" : undefined,
                    "aria-invalid": props.invalid ? true : undefined,
                    onChange: function (ev) { props.onEdit(ev.target.value); },
                });
            var t = props.t;
            return e("div", { style: props.first ? fieldStyle : fieldDividedStyle },
                e("div", { style: headStyle },
                    e("label", { htmlFor: id, style: labelStyle }, t("label_" + spec.key)),
                    props.overridden
                        ? e("span", { style: badgesStyle },
                            e("span", { style: badgeStyle }, t("overridden")),
                            e("button", {
                                type: "button", style: resetStyle, disabled: props.disabled, onClick: props.onReset,
                            }, t("reset")))
                        : null),
                control,
                e("p", { style: props.invalid ? invalidStyle : hintStyle },
                    props.invalid
                        ? t(spec.kind === "int" ? "invalidInt" : spec.kind === "mib" ? "invalidMib" : "invalidEmpty")
                        : t("hint_" + spec.key)));
        }

        var MIB = 1024 * 1024;

        function draftOf(spec, value) {
            var raw = value === undefined ? "" : value;
            if (spec.kind === "bool") return raw ? "true" : "false";
            // Bytes are the document's unit; MiB is only how the control speaks.
            if (spec.kind === "mib") {
                if (typeof raw !== "number") return "";
                var mib = raw / MIB;
                return String(Number.isInteger(mib) ? mib : Math.round(mib * 100) / 100);
            }
            return String(raw);
        }

        function parseScalar(spec, draft) {
            if (spec.kind === "bool") return draft === "true";
            if (spec.kind === "mib") {
                var mib = Number(draft);
                return draft.trim() !== "" && Number.isFinite(mib) && mib > 0 ? Math.round(mib * MIB) : undefined;
            }
            if (spec.kind !== "int") return draft.trim() === "" ? undefined : draft;
            var n = Number(draft);
            return Number.isInteger(n) && n >= 1 ? n : undefined;
        }

        function SettingsCard(props) {
            var t = (props && props.t) || fallbackT;
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
            var openPair = React.useState(false);
            var open = openPair[0];

            // Adopt committed state only while nothing is being edited, so a
            // background commit never overwrites what the user is typing.
            var clean = Object.keys(drafts).length === 0 && rows === null;
            React.useEffect(function () {
                if (value && clean) setRows(modelsToRows(value.models));
            }, [value, clean]);

            if (snapshot.status === "loading" || snapshot.status === "unavailable" || !value) {
                return e("li", { style: shellStyle, "data-plugin-card": NS },
                    e("div", { style: headerStyle },
                        e("span", { style: headTextStyle },
                            e("span", { style: nameStyle }, t("title")),
                            e("span", { style: descStyle },
                                t(snapshot.status === "loading" ? "loading" : "unavailable")))));
            }

            var currentRows = rows === null ? modelsToRows(value.models) : rows;
            var problems = currentRows.map(function (row) { return rowProblem(row, currentRows); });
            var scalarInvalid = SCALARS.some(function (spec) {
                return drafts[spec.key] !== undefined && parseScalar(spec, drafts[spec.key]) === undefined;
            });
            var blocked = scalarInvalid || problems.some(function (p) { return p !== null; });
            var modelsDirty = rows !== null && JSON.stringify(rowsToModels(currentRows)) !== JSON.stringify(modelsToRows(value.models).map(function (row) {
                return { alias: row.alias, id: row.id, defaults: parseDefaults(row.defaultsText) };
            }));
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

            var discard = function () {
                setDrafts({});
                setRows(null);
                errorPair[1](null);
            };

            var setRow = function (index, patch) {
                setRows(currentRows.map(function (row, i) { return i === index ? Object.assign({}, row, patch) : row; }));
            };

            return e("li", {
                style: open ? Object.assign({}, shellStyle, shellOpenStyle) : shellStyle,
                "data-plugin-card": NS,
            },
                e("button", {
                    type: "button", style: headerStyle, "aria-expanded": open,
                    onClick: function () { openPair[1](!open); },
                },
                    e("span", { style: headTextStyle },
                        e("span", { style: nameStyle }, t("title")),
                        e("span", { style: descStyle }, t("description"))),
                    dirty ? e("span", { style: pillStyle }, t("unsaved")) : null,
                    e(Chevron, { open: open })),
                open ? e("div", { style: bodyStyle },
                    !snapshot.writable
                        ? e("p", { style: readOnlyStyle, role: "status" }, t("readOnly"))
                        : null,
                    e("div", null,
                        SCALARS.map(function (spec, i) {
                        var draft = drafts[spec.key] !== undefined ? drafts[spec.key] : draftOf(spec, value[spec.key]);
                        return e(Field, {
                            key: spec.key,
                            spec: spec,
                            t: t,
                            // Only BETWEEN fields — the body already draws the
                            // line under the card header.
                            first: i === 0,
                            draft: draft,
                            disabled: disabled,
                            overridden: isOverridden(snapshot.user, spec.key),
                            invalid: drafts[spec.key] !== undefined && parseScalar(spec, draft) === undefined,
                            onEdit: function (text) { edit(spec.key, text); },
                            onReset: function () { write(function () { return scope.unset(spec.key); }); },
                        });
                    }),
                    e("div", { style: fieldDividedStyle },
                        e("div", { style: headStyle },
                            e("label", { style: labelStyle }, t("modelsLabel")),
                            isOverridden(snapshot.user, "models")
                                ? e("span", { style: badgesStyle },
                                    e("span", { style: badgeStyle }, t("overridden")),
                                    e("button", {
                                        type: "button", style: resetStyle, disabled: disabled,
                                        onClick: function () { write(function () { return scope.unset("models"); }); },
                                    }, t("reset")))
                                : null),
                        e("div", { style: Object.assign({}, rowStyle, { marginBottom: "4px" }) },
                            e("span", { style: hintStyle }, t("colAlias")),
                            e("span", { style: hintStyle }, t("colId")),
                            e("span", { style: hintStyle }, t("colDefaults")),
                            e("span", null, "")),
                        currentRows.map(function (row, i) {
                            var rowInput = problems[i] ? inputInvalidStyle : inputStyle;
                            return e("div", { key: row.key },
                                e("div", { style: rowStyle },
                                    e("input", {
                                        type: "text", value: row.alias, disabled: disabled, style: rowInput,
                                        onChange: function (ev) { setRow(i, { alias: ev.target.value }); },
                                    }),
                                    e("input", {
                                        type: "text", value: row.id, disabled: disabled, style: rowInput,
                                        placeholder: t("placeholderId"),
                                        onChange: function (ev) { setRow(i, { id: ev.target.value }); },
                                    }),
                                    e("input", {
                                        type: "text", value: row.defaultsText, disabled: disabled, style: rowInput,
                                        placeholder: '{"resolution":"2K"}',
                                        onChange: function (ev) { setRow(i, { defaultsText: ev.target.value }); },
                                    }),
                                    e("button", {
                                        type: "button", style: resetStyle, disabled: disabled,
                                        "aria-label": t("removeRowAria"),
                                        onClick: function () { setRows(currentRows.filter(function (_, j) { return j !== i; })); },
                                    }, t("removeRow"))),
                                problems[i]
                                    ? e("p", { style: Object.assign({}, invalidStyle, { marginBottom: "8px" }) }, t(problems[i]))
                                    : null);
                        }),
                        e("button", {
                            type: "button", disabled: disabled,
                            style: Object.assign({}, resetStyle, { alignSelf: "flex-start" }),
                            onClick: function () {
                                setRows(currentRows.concat([{ key: "neu-" + Date.now(), alias: "", id: "", defaultsText: "" }]));
                            },
                        }, t("addRow")),
                        e("p", { style: hintStyle }, t("modelsHint")))),
                    e("div", { style: footerStyle },
                        errorPair[0]
                            ? e("p", { style: failedStyle, role: "status" }, errorPair[0])
                            : (blocked ? e("p", { style: failedStyle, role: "status" }, t("blocked")) : null),
                        e("button", {
                            type: "button",
                            style: Object.assign({}, discardStyle, !dirty || busyPair[0] ? { opacity: 0.4, cursor: "default" } : {}),
                            disabled: !dirty || busyPair[0],
                            onClick: discard,
                        }, t("discard")),
                        e("button", {
                            type: "button",
                            style: Object.assign({}, saveStyle, !dirty || blocked || busyPair[0] || disabled ? { opacity: 0.4, cursor: "default" } : {}),
                            disabled: !dirty || blocked || busyPair[0] || disabled,
                            onClick: save,
                        }, t(busyPair[0] ? "saving" : "save")))) : null);
        }

        var inject = ["slots", "sessions"];

        /**
         * Client plugin body: register the keyed generate_image tool card.
         * @param ctx - client root context.
         */
        function apply(ctx) {
            ImageCard.sessions = ctx.get("sessions");
            // The harness ships 中文 and English; the dictionaries follow it.
            // Without the locale service every string still resolves, through
            // the English fallback.
            var localized = ctx.locale !== undefined && typeof ctx.locale.register === "function";
            if (localized) ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); });
            var keyed = function (extra) {
                return Object.assign({ name: extra.name, key: extra.key }, localized ? { locale: NS } : {});
            };
            ctx.slots.inject("tool.call.toolview", function () {
                return ctx.slots.register(
                    keyed({ name: "tool.call.toolview", key: "generate_image" }),
                    function (props) { return React.createElement(ImageCard, props); });
            });

            // The settings card waits for its service in a CHILD fiber rather
            // than riding this plugin's own `inject`: a deployment without the
            // settings surface then loses the card only, not the tool view.
            var mountSettings = function (settingsCtx) {
                var binder = settingsCtx.settingsScope;
                if (!binder || typeof binder.bind !== "function") return;
                SettingsCard.scope = binder.bind({ namespace: NS });
                settingsCtx.slots.inject("settings.plugin.item", function () {
                    return settingsCtx.slots.register(
                        keyed({ name: "settings.plugin.item", key: NS }),
                        function (props) { return React.createElement(SettingsCard, props); });
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
