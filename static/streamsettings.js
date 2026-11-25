/*
 * Moonlight Web - Stream Settings (Video / Audio / Mouse)
 *
 * Adds a "Video / Audio / Mouse" settings section to the in-stream sidebar
 * (the settings tray that is opened while streaming), next to the existing
 * "Mouse Mode" / "Touch Mode" selectors.
 *
 * The web client is a minified bundle and only exposes a few settings in the
 * stream sidebar, so this file is fully self contained:
 *
 *  - Mouse options (scroll mode / local cursor sensitivity) are applied LIVE
 *    through window.app.setInputConfig(), which is the same entry point the
 *    built-in mouse/touch selectors use.
 *  - Video and audio options are part of the transport setup and can only be
 *    changed by (re)starting the stream, so they are persisted to the same
 *    localStorage key the client uses ("mlSettings") and a "Apply & Restart
 *    Stream" button reloads the page to make them take effect.
 *
 * Everything is stored under localStorage["mlSettings"], exactly like the
 * settings form on the host/app selection page, so both views stay in sync.
 */
(function () {
    "use strict";

    if (window.__mlStreamSettingsInstalled) {
        return;
    }
    window.__mlStreamSettingsInstalled = true;

    var STORAGE_KEY = "mlSettings";
    var PANEL_ID = "mlStreamSettings";

    // Defaults mirror the client's own defaults (module 948/364 in stream.js).
    var DEFAULTS = {
        bitrate: 10000,
        fps: 60,
        videoSize: "custom",
        videoSizeCustom: { width: 1920, height: 1080 },
        videoCodec: "h264",
        forceVideoElementRenderer: false,
        canvasRenderer: false,
        canvasVsync: false,
        hdr: false,
        playAudioLocal: false,
        microphone: false,
        mouseScrollMode: "highres",
        localCursorSensitivity: 1,
    };

    var TEXT = {
        en: {
            title: "Settings (Video / Audio / Mouse)",
            video: "Video",
            audio: "Audio",
            mouse: "Mouse",
            videoCodec: "Video Codec",
            auto: "Auto",
            autoExp: "Auto (Experimental)",
            av1Exp: "AV1 (Experimental)",
            bitrate: "Bitrate (Kbps)",
            fps: "Fps",
            videoSize: "Video Size",
            native: "native",
            custom: "custom",
            width: "Video Width",
            height: "Video Height",
            hdr: "Enable HDR",
            canvas: "Use Canvas Renderer",
            vsync: "Canvas VSync (reduce tearing)",
            forceVideo: "Force Video Element Renderer (WebRTC only)",
            playAudioLocal: "Play Audio Local",
            microphone: "Enable Microphone (supported hosts)",
            scrollMode: "Scroll Mode",
            highRes: "High Res",
            normal: "Normal",
            sensitivity: "Local Cursor Sensitivity",
            apply: "Apply & Restart Stream",
            pending: "Video/Audio: changes only apply after restarting the stream.",
            liveMouse: "Mouse: applied instantly.",
        },
        pt: {
            title: "Configurações (Vídeo / Áudio / Mouse)",
            video: "Vídeo",
            audio: "Áudio",
            mouse: "Mouse",
            videoCodec: "Codec de Vídeo",
            auto: "Automático",
            autoExp: "Automático (Experimental)",
            av1Exp: "AV1 (Experimental)",
            bitrate: "Taxa de bits (Kbps)",
            fps: "FPS",
            videoSize: "Resolução de Vídeo",
            native: "nativa",
            custom: "personalizada",
            width: "Largura do Vídeo",
            height: "Altura do Vídeo",
            hdr: "Ativar HDR",
            canvas: "Usar Renderizador Canvas",
            vsync: "VSync do Canvas (reduz tearing)",
            forceVideo: "Forçar Renderizador de Vídeo (somente WebRTC)",
            playAudioLocal: "Reproduzir Áudio Localmente",
            microphone: "Ativar Microfone (hosts compatíveis)",
            scrollMode: "Modo de Rolagem",
            highRes: "Alta Resolução",
            normal: "Normal",
            sensitivity: "Sensibilidade do Cursor Local",
            apply: "Aplicar e Reiniciar o Stream",
            pending: "Vídeo/Áudio: as alterações só valem depois de reiniciar o stream.",
            liveMouse: "Mouse: aplicado na hora.",
        },
    };

    var STYLE = [
        "#mlStreamSettings{margin-top:10px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.15);}",
        "#mlStreamSettings h3{font-size:1rem;margin:10px 0 4px;}",
        "#mlStreamSettings .ml-ss-toggle{display:block;width:100%;}",
        "#mlStreamSettings .ml-ss-body{max-height:60vh;overflow-y:auto;}",
        "#mlStreamSettings .ml-ss-body[hidden]{display:none;}",
        "#mlStreamSettings .input-div{margin:2px 0;}",
        "#mlStreamSettings .input-div>label{flex:1 1 auto;min-width:0;}",
        "#mlStreamSettings select,#mlStreamSettings input[type=number]",
        "{flex:0 0 auto;width:104px;max-width:104px;margin:4px 0;}",
        "#mlStreamSettings input[type=range]{flex:0 0 auto;width:110px;margin:4px 0;}",
        "#mlStreamSettings .ml-ss-hint{font-size:0.8rem;opacity:0.85;margin:6px 0;}",
        "#mlStreamSettings #mlSsApply{display:none;width:100%;}",
    ].join("");

    var lang = "en";
    var pendingRestart = false;
    var current = readSettings();

    // ---------------------------------------------------------------- storage

    function merge(target, source) {
        for (var key in source) {
            if (!Object.prototype.hasOwnProperty.call(source, key)) {
                continue;
            }
            var value = source[key];
            if (value && typeof value === "object" && !Array.isArray(value)) {
                var base = target[key];
                if (!base || typeof base !== "object" || Array.isArray(base)) {
                    base = {};
                }
                target[key] = merge(base, value);
            } else if (value !== undefined) {
                target[key] = value;
            }
        }
        return target;
    }

    function readSettings() {
        var settings = JSON.parse(JSON.stringify(DEFAULTS));
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                merge(settings, JSON.parse(raw));
            }
        } catch (err) {
            /* storage unavailable or invalid, keep defaults */
        }
        return settings;
    }

    function save(patch) {
        var stored = {};
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                stored = JSON.parse(raw);
            }
        } catch (err) {
            stored = {};
        }
        merge(stored, patch);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
        } catch (err) {
            /* storage unavailable */
        }
    }

    // ------------------------------------------------------------------ apply

    // Mouse options are hot-swappable through the same API the client uses.
    function applyMouseLive() {
        var app = window.app;
        if (!app || typeof app.setInputConfig !== "function") {
            return;
        }
        try {
            app.setInputConfig({
                mouseScrollMode: current.mouseScrollMode,
                localCursorSensitivity: current.localCursorSensitivity,
            });
        } catch (err) {
            /* stream not ready yet, value is still persisted for next start */
        }
    }

    function markPendingRestart() {
        pendingRestart = true;
        var hint = document.getElementById("mlSsPending");
        if (hint) {
            hint.hidden = false;
        }
        var button = document.getElementById("mlSsApply");
        if (button) {
            button.style.display = "block";
        }
    }

    function setVideoAudio(key, value) {
        current[key] = value;
        var patch = {};
        patch[key] = value;
        save(patch);
        markPendingRestart();
    }

    function setMouse(key, value) {
        current[key] = value;
        var patch = {};
        patch[key] = value;
        save(patch);
        applyMouseLive();
    }

    // -------------------------------------------------------------- dom utils

    function detectLanguage() {
        var container = document.querySelector(".sidebar-stream-buttons");
        if (container) {
            for (var i = 0; i < container.children.length; i++) {
                var text = (container.children[i].innerText || "").trim().toLowerCase();
                if (text.indexOf("bloquear") !== -1 || text.indexOf("teclado") !== -1) {
                    return "pt";
                }
            }
        }
        if ((navigator.language || "").toLowerCase().indexOf("pt") === 0) {
            return "pt";
        }
        return "en";
    }

    function makeRow(labelText, control) {
        var div = document.createElement("div");
        div.className = "input-div";

        var label = document.createElement("label");
        label.innerText = labelText;

        div.appendChild(label);
        div.appendChild(control);
        return div;
    }

    function makeSelect(id, value, options) {
        var select = document.createElement("select");
        select.id = id;
        for (var i = 0; i < options.length; i++) {
            var option = document.createElement("option");
            option.value = options[i].value;
            option.innerText = options[i].name;
            select.appendChild(option);
        }
        select.value = value;
        return select;
    }

    function makeNumber(id, value, onChange, step) {
        var input = document.createElement("input");
        input.type = "number";
        input.id = id;
        input.value = value;
        if (step) {
            input.step = step;
        }
        input.addEventListener("change", onChange);
        return input;
    }

    function makeCheckbox(id, checked, onChange) {
        var input = document.createElement("input");
        input.type = "checkbox";
        input.id = id;
        input.checked = !!checked;
        input.addEventListener("change", onChange);
        return input;
    }

    // ------------------------------------------------------------------- build

    function buildPanel() {
        var t = TEXT[lang];

        var panel = document.createElement("div");
        panel.id = PANEL_ID;

        var toggle = document.createElement("button");
        toggle.className = "ml-ss-toggle";
        toggle.innerText = t.title;

        var body = document.createElement("div");
        body.className = "ml-ss-body";

        toggle.addEventListener("click", function () {
            body.hidden = !body.hidden;
        });

        // ------------------------------------------------------------ video
        var videoHeader = document.createElement("h3");
        videoHeader.innerText = t.video;
        body.appendChild(videoHeader);

        var codecOptions = [
            { value: "auto", name: t.autoExp },
            { value: "h264", name: "H264" },
            { value: "h265", name: "H265" },
            { value: "av1", name: t.av1Exp },
        ];
        var codec = makeSelect("mlSsVideoCodec", current.videoCodec, codecOptions);
        codec.addEventListener("change", function () {
            setVideoAudio("videoCodec", codec.value);
        });
        body.appendChild(makeRow(t.videoCodec, codec));

        var sizeOptions = [
            { value: "720p", name: "720p" },
            { value: "1080p", name: "1080p" },
            { value: "1440p", name: "1440p" },
            { value: "4k", name: "4k" },
            { value: "native", name: t.native },
            { value: "custom", name: t.custom },
        ];
        var size = makeSelect("mlSsVideoSize", current.videoSize, sizeOptions);
        body.appendChild(makeRow(t.videoSize, size));

        var width = makeNumber("mlSsVideoWidth", current.videoSizeCustom.width, function () {
            current.videoSizeCustom.width = parseInt(width.value, 10) || 0;
            setVideoAudio("videoSizeCustom", {
                width: current.videoSizeCustom.width,
                height: current.videoSizeCustom.height,
            });
        });
        var widthRow = makeRow(t.width, width);
        body.appendChild(widthRow);

        var height = makeNumber("mlSsVideoHeight", current.videoSizeCustom.height, function () {
            current.videoSizeCustom.height = parseInt(height.value, 10) || 0;
            setVideoAudio("videoSizeCustom", {
                width: current.videoSizeCustom.width,
                height: current.videoSizeCustom.height,
            });
        });
        var heightRow = makeRow(t.height, height);
        body.appendChild(heightRow);

        function refreshCustomVisibility() {
            var show = size.value === "custom";
            widthRow.style.display = show ? "" : "none";
            heightRow.style.display = show ? "" : "none";
        }
        size.addEventListener("change", function () {
            refreshCustomVisibility();
            setVideoAudio("videoSize", size.value);
        });
        refreshCustomVisibility();

        var bitrate = makeNumber("mlSsBitrate", current.bitrate, function () {
            setVideoAudio("bitrate", parseInt(bitrate.value, 10) || 0);
        }, "100");
        body.appendChild(makeRow(t.bitrate, bitrate));

        var fps = makeNumber("mlSsFps", current.fps, function () {
            setVideoAudio("fps", parseInt(fps.value, 10) || 0);
        });
        body.appendChild(makeRow(t.fps, fps));

        var hdr = makeCheckbox("mlSsHdr", current.hdr, function () {
            setVideoAudio("hdr", hdr.checked);
        });
        body.appendChild(makeRow(t.hdr, hdr));

        var canvas = makeCheckbox("mlSsCanvas", current.canvasRenderer, function () {
            setVideoAudio("canvasRenderer", canvas.checked);
        });
        body.appendChild(makeRow(t.canvas, canvas));

        var vsync = makeCheckbox("mlSsVsync", current.canvasVsync, function () {
            setVideoAudio("canvasVsync", vsync.checked);
        });
        body.appendChild(makeRow(t.vsync, vsync));

        var forceVideo = makeCheckbox("mlSsForceVideo", current.forceVideoElementRenderer, function () {
            setVideoAudio("forceVideoElementRenderer", forceVideo.checked);
        });
        body.appendChild(makeRow(t.forceVideo, forceVideo));

        // ------------------------------------------------------------ audio
        var audioHeader = document.createElement("h3");
        audioHeader.innerText = t.audio;
        body.appendChild(audioHeader);

        var playLocal = makeCheckbox("mlSsPlayAudioLocal", current.playAudioLocal, function () {
            setVideoAudio("playAudioLocal", playLocal.checked);
        });
        body.appendChild(makeRow(t.playAudioLocal, playLocal));

        var microphone = makeCheckbox("mlSsMicrophone", current.microphone, function () {
            setVideoAudio("microphone", microphone.checked);
        });
        body.appendChild(makeRow(t.microphone, microphone));

        // ------------------------------------------------------------ mouse
        var mouseHeader = document.createElement("h3");
        mouseHeader.innerText = t.mouse;
        body.appendChild(mouseHeader);

        var scrollOptions = [
            { value: "highres", name: t.highRes },
            { value: "normal", name: t.normal },
        ];
        var scroll = makeSelect("mlSsScrollMode", current.mouseScrollMode, scrollOptions);
        scroll.addEventListener("change", function () {
            setMouse("mouseScrollMode", scroll.value);
        });
        body.appendChild(makeRow(t.scrollMode, scroll));

        var sensitivity = document.createElement("input");
        sensitivity.type = "range";
        sensitivity.id = "mlSsSensitivity";
        sensitivity.min = "0.1";
        sensitivity.max = "3";
        sensitivity.step = "0.1";
        sensitivity.value = current.localCursorSensitivity;
        sensitivity.addEventListener("change", function () {
            setMouse("localCursorSensitivity", parseFloat(sensitivity.value) || 1);
        });
        sensitivity.addEventListener("input", function () {
            sensitivity.title = sensitivity.value;
        });
        body.appendChild(makeRow(t.sensitivity, sensitivity));

        var mouseHint = document.createElement("div");
        mouseHint.className = "ml-ss-hint";
        mouseHint.innerText = t.liveMouse;
        body.appendChild(mouseHint);

        // ------------------------------------------------------------ footer
        var pendingHint = document.createElement("div");
        pendingHint.className = "ml-ss-hint";
        pendingHint.id = "mlSsPending";
        pendingHint.hidden = true;
        pendingHint.innerText = t.pending;
        body.appendChild(pendingHint);

        var applyButton = document.createElement("button");
        applyButton.id = "mlSsApply";
        applyButton.innerText = t.apply;
        applyButton.addEventListener("click", function () {
            window.location.reload();
        });
        body.appendChild(applyButton);

        if (pendingRestart) {
            pendingHint.hidden = false;
            applyButton.style.display = "block";
        }

        panel.appendChild(toggle);
        panel.appendChild(body);
        return panel;
    }

    // ------------------------------------------------------------------- scan

    function scan() {
        var sidebar = document.querySelector(".sidebar-stream");
        if (!sidebar || sidebar.querySelector("#" + PANEL_ID)) {
            return;
        }
        lang = detectLanguage();
        sidebar.appendChild(buildPanel());
    }

    function boot() {
        var style = document.createElement("style");
        style.id = "ml-stream-settings-style";
        style.appendChild(document.createTextNode(STYLE));
        document.head.appendChild(style);

        // The sidebar is created/destroyed while streaming, keep scanning.
        scan();
        window.setInterval(scan, 500);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
