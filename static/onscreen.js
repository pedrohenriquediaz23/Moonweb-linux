/*
 * Moonlight Web - On-Screen (Virtual) Controls
 *
 * Adds an "On-Screen Controls" toggle to the stream sidebar (right next to the
 * "Lock Mouse" button) and renders a touch/mouse gamepad overlay on top of the
 * video. The overlay is modeled after the virtual controller shipped in the
 * Moonlight Android APK (same default layout: left stick / LT-LB / D-Pad on the
 * left, face buttons / RB-RT / right stick on the right, BACK / GUIDE / START
 * at the bottom center).
 *
 * The overlay talks to the running stream through the app instance that the web
 * client exposes as `window.app` -> app.getStream().getInput(). No minified
 * client code is patched, this file is fully self contained.
 */
(function () {
    "use strict";

    if (window.__mlOnScreenControlsInstalled) {
        return;
    }
    window.__mlOnScreenControlsInstalled = true;

    var requestFrame = window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : function (cb) { return window.setTimeout(cb, 16); };
    var cancelFrame = window.cancelAnimationFrame
        ? window.cancelAnimationFrame.bind(window)
        : function (id) { window.clearTimeout(id); };

    // Buttons understood by the Moonlight controller protocol (see ControllerButtons).
    var BUTTON_NAMES = [
        "a", "b", "x", "y", "up", "down", "left", "right",
        "lb", "rb", "play", "back", "lsClk", "rsClk", "special",
        "paddle1", "paddle2", "paddle3", "paddle4", "touchpad", "misc",
    ];

    var TEXT = {
        en: {
            enable: "On-Screen Controls",
            disable: "Hide On-Screen Controls",
        },
        pt: {
            enable: "Ativar Controles na Tela",
            disable: "Desativar Controles na Tela",
        },
    };

    // Default Android APK layout, expressed on the same 128x72 grid the APK
    // uses for its on-screen controls. The right hand controls are anchored to
    // the right edge so they stay put on aspect ratios wider than 16:9.
    var LAYOUT = [
        { id: "lt", type: "trigger", target: "left", x: 1, y: 31, w: 12, h: 9, label: "LT", anchor: "left" },
        { id: "lb", type: "button", target: "lb", x: 24, y: 31, w: 12, h: 9, label: "LB", anchor: "left" },
        { id: "lstick", type: "stick", target: "leftStick", x: 6, y: 4, w: 26, h: 26, anchor: "left" },
        { id: "dpad", type: "dpad", x: 4, y: 41, w: 30, h: 30, anchor: "left" },
        { id: "back", type: "button", target: "back", x: 34, y: 64, w: 12, h: 7, label: "BACK", anchor: "left" },
        { id: "y", type: "button", target: "y", x: 106, y: 1, w: 10, h: 10, label: "Y", anchor: "right", round: true },
        { id: "x", type: "button", target: "x", x: 96, y: 11, w: 10, h: 10, label: "X", anchor: "right", round: true },
        { id: "b", type: "button", target: "b", x: 116, y: 11, w: 10, h: 10, label: "B", anchor: "right", round: true },
        { id: "a", type: "button", target: "a", x: 106, y: 21, w: 10, h: 10, label: "A", anchor: "right", round: true },
        { id: "rb", type: "button", target: "rb", x: 92, y: 31, w: 12, h: 9, label: "RB", anchor: "right" },
        { id: "rt", type: "trigger", target: "right", x: 115, y: 31, w: 12, h: 9, label: "RT", anchor: "right" },
        { id: "rstick", type: "stick", target: "rightStick", x: 98, y: 42, w: 26, h: 26, anchor: "right" },
        { id: "start", type: "button", target: "play", x: 83, y: 64, w: 12, h: 7, label: "START", anchor: "right" },
        { id: "guide", type: "button", target: "special", x: 49, y: 64, w: 12, h: 7, label: "GUIDE", anchor: "right" },
    ];

    var STYLE = [
        "#ml-osc{position:fixed;inset:0;z-index:0;pointer-events:none;--u:calc(100vh / 72);--w:calc(100vh * 16 / 9);}",
        "#ml-osc[hidden]{display:none;}",
        ".ml-osc-el{position:absolute;pointer-events:auto;touch-action:none;box-sizing:border-box;",
        "display:flex;align-items:center;justify-content:center;user-select:none;-webkit-user-select:none;",
        "-webkit-tap-highlight-color:transparent;}",
        ".ml-osc-btn{background:rgba(18,20,26,0.42);border:calc(var(--u) * 0.35) solid rgba(255,255,255,0.5);",
        "border-radius:calc(var(--u) * 1.6);color:rgba(255,255,255,0.92);",
        "font:600 calc(var(--u) * 2.6)/1 system-ui,'Segoe UI',sans-serif;letter-spacing:0.02em;",
        "box-shadow:0 calc(var(--u) * 0.4) calc(var(--u) * 1.2) rgba(0,0,0,0.35);}",
        ".ml-osc-btn.ml-osc-round{border-radius:50%;font-size:calc(var(--u) * 3.2);}",
        ".ml-osc-btn.ml-osc-active{background:rgba(92,190,255,0.62);border-color:rgba(255,255,255,0.9);}",
        ".ml-osc-stick{background:rgba(18,20,26,0.3);border:calc(var(--u) * 0.35) solid rgba(255,255,255,0.45);",
        "border-radius:50%;box-shadow:0 calc(var(--u) * 0.4) calc(var(--u) * 1.2) rgba(0,0,0,0.3);}",
        ".ml-osc-stick.ml-osc-active{background:rgba(92,190,255,0.28);}",
        ".ml-osc-knob{position:absolute;left:50%;top:50%;width:46%;height:46%;border-radius:50%;",
        "background:rgba(240,244,255,0.78);box-shadow:0 calc(var(--u) * 0.3) calc(var(--u) * 0.9) rgba(0,0,0,0.4);",
        "transform:translate(-50%,-50%);pointer-events:none;}",
        ".ml-osc-dir{position:absolute;pointer-events:auto;touch-action:none;",
        "display:flex;align-items:center;justify-content:center;background:rgba(18,20,26,0.42);",
        "border:calc(var(--u) * 0.35) solid rgba(255,255,255,0.5);box-sizing:border-box;",
        "color:rgba(255,255,255,0.85);font:600 calc(var(--u) * 2.4)/1 system-ui,'Segoe UI',sans-serif;",
        "-webkit-tap-highlight-color:transparent;}",
        ".ml-osc-dir.ml-osc-active{background:rgba(92,190,255,0.62);}",
        ".ml-osc-toggle-active{background:rgba(92,190,255,0.55) !important;}",
    ].join("");

    var state = {
        buttons: {},
        leftTrigger: 0,
        rightTrigger: 0,
        leftStick: { x: 0, y: 0 },
        rightStick: { x: 0, y: 0 },
    };
    for (var b = 0; b < BUTTON_NAMES.length; b++) {
        state.buttons[BUTTON_NAMES[b]] = false;
    }

    var root = null;
    var toggleButton = null;
    var lang = "en";
    var enabled = false;

    var inputRef = null;
    var controllerId = -1;
    var loopHandle = null;
    var lastState = null;

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

    function buildState() {
        var flags = {};
        for (var i = 0; i < BUTTON_NAMES.length; i++) {
            flags[BUTTON_NAMES[i]] = !!state.buttons[BUTTON_NAMES[i]];
        }
        return {
            buttonFlags: flags,
            leftTrigger: state.leftTrigger,
            rightTrigger: state.rightTrigger,
            leftStickX: state.leftStick.x,
            leftStickY: state.leftStick.y,
            rightStickX: state.rightStick.x,
            rightStickY: state.rightStick.y,
        };
    }

    function statesEqual(a, b) {
        for (var i = 0; i < BUTTON_NAMES.length; i++) {
            var name = BUTTON_NAMES[i];
            if (!!a.buttonFlags[name] !== !!b.buttonFlags[name]) {
                return false;
            }
        }
        return a.leftTrigger === b.leftTrigger
            && a.rightTrigger === b.rightTrigger
            && a.leftStickX === b.leftStickX
            && a.leftStickY === b.leftStickY
            && a.rightStickX === b.rightStickX
            && a.rightStickY === b.rightStickY;
    }

    function resetState() {
        for (var i = 0; i < BUTTON_NAMES.length; i++) {
            state.buttons[BUTTON_NAMES[i]] = false;
        }
        state.leftTrigger = 0;
        state.rightTrigger = 0;
        state.leftStick.x = 0;
        state.leftStick.y = 0;
        state.rightStick.x = 0;
        state.rightStick.y = 0;
        lastState = null;
    }

    // ------------------------------------------------------------ controller

    function pickControllerId(input) {
        var used = {};
        var slots = input.gamepads;
        if (slots) {
            for (var i = 0; i < slots.length; i++) {
                if (slots[i]) {
                    used[i] = true;
                }
            }
        }
        var id = 0;
        while (used[id]) {
            id++;
        }
        return id;
    }

    function addController() {
        var input = resolveInput();
        if (!input || !isStreamReady(input) || controllerId >= 0) {
            return;
        }
        controllerId = pickControllerId(input);
        input.sendControllerAdd(controllerId, {
            a: true, b: true, x: true, y: true,
            up: true, down: true, left: true, right: true,
            lb: true, rb: true, play: true, back: true,
            lsClk: true, rsClk: true, special: true,
            paddle1: false, paddle2: false, paddle3: false, paddle4: false,
            touchpad: false, misc: false,
        }, {
            analogTriggers: false,
            rumble: false,
            triggerRumble: false,
            touchpad: false,
            accel: false,
            gyro: false,
            batteryState: false,
            rgbLed: false,
            dualTouchpad: false,
        });
    }

    function removeController() {
        var input = inputRef || resolveInput();
        if (input && controllerId >= 0 && typeof input.sendControllerRemove === "function") {
            input.sendControllerRemove(controllerId);
        }
        controllerId = -1;
    }

    function pushState() {
        var input = resolveInput();
        if (!input || !isStreamReady(input)) {
            return;
        }
        if (controllerId < 0) {
            addController();
            if (controllerId < 0) {
                return;
            }
        }
        var next = buildState();
        if (lastState && statesEqual(next, lastState)) {
            return;
        }
        lastState = next;
        input.sendController(controllerId, next);
    }

    function startLoop() {
        if (loopHandle !== null) {
            return;
        }
        var step = function () {
            loopHandle = requestFrame(step);
            try {
                pushState();
            } catch (err) {
                console.warn("[OnScreenControls] failed to send controller state", err);
            }
        };
        loopHandle = requestFrame(step);
    }

    function stopLoop() {
        if (loopHandle !== null) {
            cancelFrame(loopHandle);
            loopHandle = null;
        }
    }

    // ---------------------------------------------------------------- overlay

    function place(el, item) {
        if (item.anchor === "right") {
            el.style.right = "calc(var(--w) - var(--u) * " + (item.x + item.w) + ")";
        } else {
            el.style.left = "calc(var(--u) * " + item.x + ")";
        }
        el.style.top = "calc(var(--u) * " + item.y + ")";
        el.style.width = "calc(var(--u) * " + item.w + ")";
        el.style.height = "calc(var(--u) * " + item.h + ")";
    }

    function bindPressable(el, onPress, onRelease) {
        var activePointer = null;

        function press(event) {
            event.preventDefault();
            event.stopPropagation();
            activePointer = event.pointerId;
            try {
                el.setPointerCapture(event.pointerId);
            } catch (err) { /* pointer capture is best effort */ }
            el.classList.add("ml-osc-active");
            onPress();
        }
        function release(event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            activePointer = null;
            el.classList.remove("ml-osc-active");
            onRelease();
        }

        el.addEventListener("pointerdown", press);
        el.addEventListener("pointerup", release);
        el.addEventListener("pointercancel", release);
        el.addEventListener("lostpointercapture", function () {
            if (activePointer !== null) {
                release(null);
            }
        });
    }

    function createStick(item) {
        var el = document.createElement("div");
        el.className = "ml-osc-el ml-osc-stick ml-osc-" + item.id;
        place(el, item);

        var knob = document.createElement("div");
        knob.className = "ml-osc-knob";
        el.appendChild(knob);

        var stick = state[item.target];
        var activePointer = null;

        function apply(clientX, clientY) {
            var rect = el.getBoundingClientRect();
            var centerX = rect.left + rect.width / 2;
            var centerY = rect.top + rect.height / 2;
            var dx = (clientX - centerX) / (rect.width / 2);
            var dy = (clientY - centerY) / (rect.height / 2);
            var length = Math.sqrt(dx * dx + dy * dy);
            if (length > 1) {
                dx /= length;
                dy /= length;
            }
            stick.x = dx;
            stick.y = dy;
            knob.style.transform = "translate(-50%,-50%) translate(" + (dx * 58) + "%," + (dy * 58) + "%)";
        }
        function release(event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            activePointer = null;
            stick.x = 0;
            stick.y = 0;
            knob.style.transform = "translate(-50%,-50%)";
            el.classList.remove("ml-osc-active");
        }

        el.addEventListener("pointerdown", function (event) {
            event.preventDefault();
            event.stopPropagation();
            activePointer = event.pointerId;
            try {
                el.setPointerCapture(event.pointerId);
            } catch (err) { /* best effort */ }
            el.classList.add("ml-osc-active");
            apply(event.clientX, event.clientY);
        });
        el.addEventListener("pointermove", function (event) {
            if (activePointer === null || event.pointerId !== activePointer) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            apply(event.clientX, event.clientY);
        });
        el.addEventListener("pointerup", release);
        el.addEventListener("pointercancel", release);
        el.addEventListener("lostpointercapture", function () {
            if (activePointer !== null) {
                release(null);
            }
        });

        return el;
    }

    function createButton(item) {
        var el = document.createElement("div");
        el.className = "ml-osc-el ml-osc-btn" + (item.round ? " ml-osc-round" : "");
        place(el, item);
        el.innerText = item.label;

        if (item.type === "trigger") {
            var triggerKey = item.target === "left" ? "leftTrigger" : "rightTrigger";
            bindPressable(el, function () {
                state[triggerKey] = 1;
            }, function () {
                state[triggerKey] = 0;
            });
        } else {
            var buttonKey = item.target;
            bindPressable(el, function () {
                state.buttons[buttonKey] = true;
            }, function () {
                state.buttons[buttonKey] = false;
            });
        }

        return el;
    }

    function createDpad(item) {
        var el = document.createElement("div");
        el.className = "ml-osc-el ml-osc-dpad";
        place(el, item);
        el.style.background = "none";
        el.style.border = "none";
        el.style.boxShadow = "none";

        var unit = "calc(var(--u) * 10)";
        var directions = [
            { name: "up", left: unit, top: "0" },
            { name: "down", left: unit, top: "calc(var(--u) * 20)" },
            { name: "left", left: "0", top: unit },
            { name: "right", left: "calc(var(--u) * 20)", top: unit },
        ];

        for (var i = 0; i < directions.length; i++) {
            (function (dir) {
                var button = document.createElement("div");
                button.className = "ml-osc-dir";
                button.style.left = dir.left;
                button.style.top = dir.top;
                button.style.width = unit;
                button.style.height = unit;
                button.style.borderRadius = "calc(var(--u) * 1.4)";

                bindPressable(button, function () {
                    state.buttons[dir.name] = true;
                }, function () {
                    state.buttons[dir.name] = false;
                });

                el.appendChild(button);
            })(directions[i]);
        }

        return el;
    }

    function createOverlay() {
        root = document.createElement("div");
        root.id = "ml-osc";
        root.hidden = true;

        stopPropagation(root);

        for (var i = 0; i < LAYOUT.length; i++) {
            var item = LAYOUT[i];
            if (item.type === "stick") {
                root.appendChild(createStick(item));
            } else if (item.type === "dpad") {
                root.appendChild(createDpad(item));
            } else {
                root.appendChild(createButton(item));
            }
        }

        document.body.appendChild(root);
    }

    // Keep the events from reaching the stream's own input listeners.
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

    // ----------------------------------------------------------------- toggle

    function setEnabled(value) {
        if (value === enabled) {
            return;
        }
        enabled = value;

        if (toggleButton) {
            toggleButton.innerText = enabled ? TEXT[lang].disable : TEXT[lang].enable;
            toggleButton.classList.toggle("ml-osc-toggle-active", enabled);
        }
        if (root) {
            root.hidden = !enabled;
        }

        if (enabled) {
            resolveInput();
            addController();
            startLoop();
        } else {
            stopLoop();
            removeController();
            resetState();
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
            // The Lock Mouse button is always the second sidebar button.
            lockIndex = 1;
        }

        lang = detectLanguage();

        var button = document.createElement("button");
        button.type = "button";
        button.className = "ml-osc-toggle";
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
        style.id = "ml-osc-style";
        style.appendChild(document.createTextNode(STYLE));
        document.head.appendChild(style);

        createOverlay();

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
