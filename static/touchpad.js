/*
 * Moonlight Web - Touchpad (mobile)
 *
 * Adds a floating touchpad widget for touch devices. It behaves like the
 * "Trackpad" input of the Moonlight Android APK (RelativeTouchContext):
 * dragging a finger moves the host cursor relatively, a tap is a left click,
 * a two finger tap is a right click and two fingers dragging scrolls. The
 * widget also exposes dedicated left/right click buttons so drag-and-drop is
 * possible without lifting the finger.
 *
 * A toggle is added to the stream sidebar next to the "Lock Mouse" button.
 * Nothing from the minified client is patched: this talks to the running
 * stream through window.app -> app.getStream().getInput().
 *
 * Useful while testing on a desktop browser: add ?touchpad=1 to the URL to
 * force the widget to appear.
 */
(function () {
    "use strict";

    if (window.__mlTouchpadInstalled) {
        return;
    }
    window.__mlTouchpadInstalled = true;

    var forceEnabled = /[?&]touchpad=1(&|$)/.test(window.location.search);
    var isTouchDevice = forceEnabled
        || (navigator.maxTouchPoints || 0) > 0
        || "ontouchstart" in window;
    if (!isTouchDevice) {
        return;
    }

    // Tap detection, mirroring the thresholds used by the Android APK.
    var TAP_TIME_MS = 250;
    var TAP_MOVE_PX = 20;
    // Two finger scroll multiplier (the APK uses 3-5).
    var SCROLL_SPEED = 3;
    var POSITION_KEY = "mlTouchpadPosition";

    // MouseButton values from the client protocol: Left=0, Middle=1, Right=2.
    var MOUSE_LEFT = 0;
    var MOUSE_RIGHT = 2;

    var TEXT = {
        en: {
            enable: "Enable Touchpad",
            disable: "Disable Touchpad",
            title: "TOUCHPAD",
            hint: "drag to move",
        },
        pt: {
            enable: "Ativar Touchpad",
            disable: "Desativar Touchpad",
            title: "TOUCHPAD",
            hint: "arraste para mover",
        },
    };

    var STYLE = [
        "#ml-tp{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:20;",
        "width:min(92vw,520px);background:rgba(14,16,20,0.74);border:1px solid rgba(255,255,255,0.22);",
        "border-radius:14px;box-shadow:0 8px 26px rgba(0,0,0,0.45);color:rgba(255,255,255,0.92);",
        "font:600 12px/1 system-ui,'Segoe UI',sans-serif;letter-spacing:0.06em;",
        "user-select:none;-webkit-user-select:none;touch-action:none;overflow:hidden;}",
        "#ml-tp[hidden]{display:none;}",
        ".ml-tp-bar{display:flex;align-items:center;justify-content:space-between;",
        "padding:9px 12px;border-bottom:1px solid rgba(255,255,255,0.14);cursor:move;touch-action:none;}",
        ".ml-tp-close{pointer-events:auto;touch-action:none;padding:0 6px;color:rgba(255,255,255,0.6);",
        "font-size:14px;line-height:1;}",
        ".ml-tp-body{display:flex;gap:8px;padding:10px;}",
        ".ml-tp-pad{flex:1;height:150px;border-radius:10px;position:relative;",
        "background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.22);",
        "touch-action:none;-webkit-tap-highlight-color:transparent;}",
        ".ml-tp-pad.ml-tp-active{background:rgba(92,190,255,0.18);border-color:rgba(92,190,255,0.6);}",
        ".ml-tp-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;",
        "color:rgba(255,255,255,0.26);font-size:11px;letter-spacing:0.1em;pointer-events:none;}",
        ".ml-tp-btns{display:flex;flex-direction:column;gap:8px;width:62px;}",
        ".ml-tp-btn{flex:1;display:flex;align-items:center;justify-content:center;border-radius:10px;",
        "background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.28);",
        "font-size:17px;font-weight:700;touch-action:none;-webkit-tap-highlight-color:transparent;",
        "letter-spacing:0;}",
        ".ml-tp-btn.ml-tp-active{background:rgba(92,190,255,0.55);border-color:rgba(255,255,255,0.85);}",
        ".ml-tp-toggle-active{background:rgba(92,190,255,0.55) !important;}",
    ].join("");

    var panel = null;
    var pad = null;
    var toggleButton = null;
    var lang = "en";
    var enabled = false;

    var inputRef = null;

    // ---------------------------------------------------------------- helpers

    function detectLanguage() {
        var container = document.querySelector(".sidebar-stream-buttons");
        if (container) {
            var children = container.children;
            for (var i = 0; i < children.length; i++) {
                var text = (children[i].innerText || "").trim().toLowerCase();
                if (text.indexOf("bloquear") !== -1 || text.indexOf("touchpad") !== -1 && text.indexOf("ativar") !== -1) {
                    return "pt";
                }
            }
        }
        if ((navigator.language || "").toLowerCase().indexOf("pt") === 0) {
            return "pt";
        }
        return "en";
    }

    function resolveInput() {
        if (inputRef) {
            return inputRef;
        }
        var app = window.app;
        if (!app || typeof app.getStream !== "function") {
            return null;
        }
        var stream = app.getStream();
        if (!stream || typeof stream.getInput !== "function") {
            return null;
        }
        inputRef = stream.getInput();
        return inputRef;
    }

    function isStreamReady(input) {
        return !!input && !!input.controlStream;
    }

    // ------------------------------------------------------------ host input

    // Drag on the pad moves the host cursor relatively, scaled so that crossing
    // the pad moves the cursor across the whole stream (same rule the client
    // itself uses for its relative touch mode).
    function sendMove(dx, dy) {
        var input = resolveInput();
        if (!isStreamReady(input)) {
            return;
        }
        var size = input.streamSize;
        if (!size || size[0] <= 0 || size[1] <= 0) {
            return;
        }
        var rect = pad.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }
        input.sendMouseMove(dx / rect.width * size[0], dy / rect.height * size[1]);
    }

    function sendButton(pressed, button) {
        var input = resolveInput();
        if (!isStreamReady(input)) {
            return;
        }
        input.sendMouseButton(pressed, button);
    }

    // Two fingers dragging scrolls. Movement follows the fingers (natural
    // scrolling); the client maps wheel deltaY through -deltaY, so the
    // vertical sign is kept while the horizontal one is inverted.
    function sendScroll(dx, dy) {
        var input = resolveInput();
        if (!isStreamReady(input)) {
            return;
        }
        input.sendAccumulatedScroll(-dx * SCROLL_SPEED, dy * SCROLL_SPEED);
    }

    function click(button) {
        sendButton(true, button);
        sendButton(false, button);
    }

    // ------------------------------------------------------------------- pad

    var pointers = {};
    var gesture = null;

    function pointerCount() {
        var count = 0;
        for (var id in pointers) {
            if (Object.prototype.hasOwnProperty.call(pointers, id)) {
                count++;
            }
        }
        return count;
    }

    function centroid() {
        var ids = Object.keys(pointers);
        var sx = 0;
        var sy = 0;
        for (var i = 0; i < ids.length; i++) {
            sx += pointers[ids[i]].x;
            sy += pointers[ids[i]].y;
        }
        return { x: sx / ids.length, y: sy / ids.length };
    }

    function onPadDown(event) {
        event.preventDefault();
        event.stopPropagation();
        try {
            pad.setPointerCapture(event.pointerId);
        } catch (err) { /* pointer capture is best effort */ }

        pointers[event.pointerId] = { x: event.clientX, y: event.clientY };

        if (!gesture) {
            gesture = { startTime: Date.now(), travel: 0, maxPointers: 1, last: centroid() };
        } else {
            gesture.maxPointers = Math.max(gesture.maxPointers, pointerCount());
            gesture.last = centroid();
        }

        pad.classList.add("ml-tp-active");
    }

    function onPadMove(event) {
        if (!gesture || !pointers[event.pointerId]) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();

        var point = pointers[event.pointerId];
        var dx = event.clientX - point.x;
        var dy = event.clientY - point.y;
        point.x = event.clientX;
        point.y = event.clientY;
        gesture.travel += Math.abs(dx) + Math.abs(dy);

        if (pointerCount() === 1) {
            sendMove(dx, dy);
        } else {
            var center = centroid();
            sendScroll(center.x - gesture.last.x, center.y - gesture.last.y);
            gesture.last = center;
        }
    }

    function onPadUp(event) {
        if (!pointers[event.pointerId]) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        delete pointers[event.pointerId];

        if (pointerCount() > 0) {
            // Still fingers down: keep the gesture, just re-anchor the centroid.
            if (gesture) {
                gesture.last = centroid();
            }
            return;
        }

        var finished = gesture;
        gesture = null;
        pad.classList.remove("ml-tp-active");

        if (!finished || finished.travel > TAP_MOVE_PX) {
            return;
        }
        if (Date.now() - finished.startTime > TAP_TIME_MS) {
            return;
        }

        click(finished.maxPointers >= 2 ? MOUSE_RIGHT : MOUSE_LEFT);
    }

    function createPad() {
        pad.addEventListener("pointerdown", onPadDown);
        pad.addEventListener("pointermove", onPadMove);
        pad.addEventListener("pointerup", onPadUp);
        pad.addEventListener("pointercancel", onPadUp);
        pad.addEventListener("contextmenu", function (event) {
            event.preventDefault();
        });
    }

    // Keeps the widget gestures from reaching the stream's own input listeners.
    function stopPropagation(el) {
        var events = [
            "mousedown", "mouseup", "mousemove", "click", "dblclick", "contextmenu", "wheel",
            "touchstart", "touchend", "touchmove", "touchcancel",
            "pointerdown", "pointerup", "pointermove", "pointercancel",
        ];
        for (var i = 0; i < events.length; i++) {
            el.addEventListener(events[i], function (event) {
                event.stopPropagation();
            });
        }
    }

    // ---------------------------------------------------------------- widget

    function bindHoldButton(el, button) {
        var active = false;

        function press(event) {
            event.preventDefault();
            event.stopPropagation();
            active = true;
            try {
                el.setPointerCapture(event.pointerId);
            } catch (err) { /* best effort */ }
            el.classList.add("ml-tp-active");
            sendButton(true, button);
        }
        function release(event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            if (!active) {
                return;
            }
            active = false;
            el.classList.remove("ml-tp-active");
            sendButton(false, button);
        }

        el.addEventListener("pointerdown", press);
        el.addEventListener("pointerup", release);
        el.addEventListener("pointercancel", release);
        el.addEventListener("lostpointercapture", function () {
            if (active) {
                release(null);
            }
        });
    }

    function savePosition() {
        try {
            window.localStorage.setItem(POSITION_KEY, JSON.stringify({
                left: panel.offsetLeft,
                top: panel.offsetTop,
            }));
        } catch (err) { /* storage may be unavailable */ }
    }

    function restorePosition() {
        var stored = null;
        try {
            stored = JSON.parse(window.localStorage.getItem(POSITION_KEY) || "null");
        } catch (err) { /* ignore malformed value */ }
        if (!stored || typeof stored.left !== "number" || typeof stored.top !== "number") {
            return;
        }
        var left = Math.min(Math.max(stored.left, 4), Math.max(4, window.innerWidth - panel.offsetWidth - 4));
        var top = Math.min(Math.max(stored.top, 4), Math.max(4, window.innerHeight - panel.offsetHeight - 4));
        panel.style.transform = "none";
        panel.style.left = left + "px";
        panel.style.top = top + "px";
        panel.style.bottom = "auto";
    }

    function makeDraggable(handle) {
        var dragging = false;
        var offsetX = 0;
        var offsetY = 0;

        handle.addEventListener("pointerdown", function (event) {
            event.preventDefault();
            event.stopPropagation();
            var rect = panel.getBoundingClientRect();
            dragging = true;
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            panel.style.transform = "none";
            panel.style.bottom = "auto";
            panel.style.left = rect.left + "px";
            panel.style.top = rect.top + "px";
            try {
                handle.setPointerCapture(event.pointerId);
            } catch (err) { /* best effort */ }
        });

        handle.addEventListener("pointermove", function (event) {
            if (!dragging) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            var left = Math.min(
                Math.max(event.clientX - offsetX, 4),
                Math.max(4, window.innerWidth - panel.offsetWidth - 4)
            );
            var top = Math.min(
                Math.max(event.clientY - offsetY, 4),
                Math.max(4, window.innerHeight - panel.offsetHeight - 4)
            );
            panel.style.left = left + "px";
            panel.style.top = top + "px";
        });

        function end(event) {
            if (!dragging) {
                return;
            }
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            dragging = false;
            savePosition();
        }

        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    }

    function createPanel() {
        panel = document.createElement("div");
        panel.id = "ml-tp";
        panel.hidden = true;

        var bar = document.createElement("div");
        bar.className = "ml-tp-bar";

        var title = document.createElement("span");
        title.className = "ml-tp-title";
        title.innerText = TEXT[lang].title;
        bar.appendChild(title);

        var close = document.createElement("span");
        close.className = "ml-tp-close";
        close.innerText = "\u00d7";
        close.title = TEXT[lang].disable;
        close.addEventListener("click", function () {
            setEnabled(false);
        });
        bar.appendChild(close);

        var body = document.createElement("div");
        body.className = "ml-tp-body";

        pad = document.createElement("div");
        pad.className = "ml-tp-pad";

        var hint = document.createElement("div");
        hint.className = "ml-tp-hint";
        hint.innerText = TEXT[lang].hint;
        pad.appendChild(hint);

        var buttons = document.createElement("div");
        buttons.className = "ml-tp-btns";

        var left = document.createElement("div");
        left.className = "ml-tp-btn";
        left.innerText = "L";
        bindHoldButton(left, MOUSE_LEFT);

        var right = document.createElement("div");
        right.className = "ml-tp-btn";
        right.innerText = "R";
        bindHoldButton(right, MOUSE_RIGHT);

        buttons.appendChild(left);
        buttons.appendChild(right);

        body.appendChild(pad);
        body.appendChild(buttons);

        panel.appendChild(bar);
        panel.appendChild(body);

        stopPropagation(panel);
        createPad();
        makeDraggable(bar);

        document.body.appendChild(panel);
        restorePosition();
    }

    // ---------------------------------------------------------------- toggle

    function setEnabled(value) {
        if (value === enabled) {
            return;
        }
        enabled = value;

        if (toggleButton) {
            toggleButton.innerText = enabled ? TEXT[lang].disable : TEXT[lang].enable;
            toggleButton.classList.toggle("ml-tp-toggle-active", enabled);
        }
        if (panel) {
            panel.hidden = !enabled;
        }

        if (!enabled) {
            pointers = {};
            gesture = null;
        }
    }

    function installSidebarButton() {
        var container = document.querySelector(".sidebar-stream-buttons");
        if (!container) {
            return false;
        }
        if (toggleButton && container.contains(toggleButton)) {
            return true;
        }

        var children = container.children;
        var lockIndex = -1;
        for (var i = 0; i < children.length; i++) {
            var text = (children[i].innerText || "").trim().toLowerCase();
            if (text.indexOf("bloquear") !== -1 || text === "lock mouse") {
                lockIndex = i;
                break;
            }
        }
        if (lockIndex === -1) {
            lockIndex = 1;
        }

        lang = detectLanguage();

        var button = document.createElement("button");
        button.type = "button";
        button.className = "ml-tp-toggle";
        button.innerText = TEXT[lang].enable;
        button.addEventListener("click", function () {
            setEnabled(!enabled);
        });

        container.insertBefore(button, children[lockIndex + 1] || null);
        toggleButton = button;
        return true;
    }

    function boot() {
        var style = document.createElement("style");
        style.id = "ml-tp-style";
        style.appendChild(document.createTextNode(STYLE));
        document.head.appendChild(style);

        lang = detectLanguage();
        createPanel();

        if (!installSidebarButton()) {
            var timer = window.setInterval(function () {
                if (installSidebarButton()) {
                    window.clearInterval(timer);
                }
            }, 500);
            window.setTimeout(function () {
                window.clearInterval(timer);
            }, 120000);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
