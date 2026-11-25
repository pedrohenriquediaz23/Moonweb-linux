/*
 * Moonlight Web - Stretch to Fill (Fullscreen)
 *
 * Adds a "Stretch to Fill" checkbox to the stream settings (right next to the
 * fullscreen options) that stretches the video to fill the whole screen while
 * in fullscreen, removing the black letterbox/pillarbox bars.
 *
 * The video is stretched purely with CSS (object-fit: fill), so the whole page
 * still works if this file is missing. The minified client assumes the video is
 * letterboxed ("contain") when it converts mouse/touch coordinates, so this
 * script also sets window.__mlStretchActive while the stretch is live: the
 * client was patched to skip the aspect-ratio correction in that case, keeping
 * the mouse aligned.
 */
(function () {
    "use strict";

    if (window.__mlStretchInstalled) {
        return;
    }
    window.__mlStretchInstalled = true;

    var STORAGE_KEY = "mlStretchToFill";

    var TEXT = {
        en: { label: "Stretch to Fill (Fullscreen)" },
        pt: { label: "Esticar a Tela (Tela Cheia)" },
    };

    var STYLE = [
        "html.ml-stretch-fill .video-stream{",
        "top:50% !important;left:50% !important;",
        "width:100vw !important;height:100vh !important;",
        "max-width:100vw !important;max-height:100vh !important;",
        "transform:translate(-50%,-50%) !important;}",
        "html.ml-stretch-fill video.video-stream,",
        "html.ml-stretch-fill canvas.video-stream{",
        "width:100% !important;height:100% !important;object-fit:fill !important;}",
    ].join("");

    var enabled = false;
    var lang = "en";

    try {
        enabled = localStorage.getItem(STORAGE_KEY) === "true";
    } catch (err) {
        enabled = false;
    }

    // ---------------------------------------------------------------- helpers

    function detectLanguage() {
        var container = document.querySelector(".sidebar-stream-buttons");
        if (container) {
            var children = container.children;
            for (var i = 0; i < children.length; i++) {
                var text = (children[i].innerText || "").trim().toLowerCase();
                if (text.indexOf("bloquear") !== -1) {
                    return "pt";
                }
            }
        }
        if ((navigator.language || "").toLowerCase().indexOf("pt") === 0) {
            return "pt";
        }
        return "en";
    }

    function isFullscreen() {
        return !!(document.fullscreenElement
            || document.webkitFullscreenElement
            || document.msFullscreenElement);
    }

    // The stretch only takes effect in fullscreen, which is what the option is
    // for. window.__mlStretchActive mirrors that so the input code can tell when
    // the video is no longer letterboxed.
    function apply() {
        var active = enabled && isFullscreen();
        window.__mlStretchActive = active;
        document.documentElement.classList.toggle("ml-stretch-fill", active);
    }

    function setEnabled(value) {
        enabled = !!value;
        try {
            localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
        } catch (err) { /* storage may be unavailable */ }

        var input = document.getElementById("mlStretchToFill");
        if (input && input.checked !== enabled) {
            input.checked = enabled;
        }

        apply();
    }

    // --------------------------------------------------------------- settings

    function buildRow() {
        var div = document.createElement("div");
        div.className = "input-div";

        var label = document.createElement("label");
        label.htmlFor = "mlStretchToFill";
        label.innerText = TEXT[lang].label;

        var input = document.createElement("input");
        input.type = "checkbox";
        input.id = "mlStretchToFill";
        input.checked = enabled;
        input.addEventListener("change", function () {
            setEnabled(input.checked);
        });

        div.appendChild(label);
        div.appendChild(input);
        return div;
    }

    function injectInto(settingsEl) {
        if (settingsEl.querySelector("#mlStretchToFill")) {
            return;
        }

        var row = buildRow();

        // Prefer to sit right below the fullscreen keybind option.
        var anchor = settingsEl.querySelector("#toggleFullscreenWithKeybind")
            || settingsEl.querySelector("#enterFullscreenOnStreamStart");
        var anchorDiv = anchor ? anchor.closest(".input-div") : null;

        if (anchorDiv && anchorDiv.parentNode) {
            anchorDiv.parentNode.insertBefore(row, anchorDiv.nextSibling);
        } else {
            settingsEl.appendChild(row);
        }
    }

    function scan() {
        var settingsEl = document.querySelector(".settings");
        if (settingsEl) {
            lang = detectLanguage();
            injectInto(settingsEl);
        }
    }

    function boot() {
        var style = document.createElement("style");
        style.id = "ml-stretch-style";
        style.appendChild(document.createTextNode(STYLE));
        document.head.appendChild(style);

        document.addEventListener("fullscreenchange", apply);
        document.addEventListener("webkitfullscreenchange", apply);

        // The settings dialog is created on demand, keep scanning for it.
        scan();
        window.setInterval(scan, 500);

        apply();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
