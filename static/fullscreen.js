/*
 * Shim de Fullscreen cross-browser.
 *
 * O app usa apenas a API padrao (Element.requestFullscreen / document.exitFullscreen /
 * document.fullscreenElement / evento "fullscreenchange"). Safari antigo e alguns
 * navegadores mobile (Opera) so expoem as variantes com prefixo (webkit, moz, ms), e
 * o iOS Safari nao tem fullscreen de elemento nenhum - por isso o botao "Tela Cheia"
 * respondia "nao suportado".
 *
 * Este script, carregado ANTES do stream.js, preenche a API padrao a partir das
 * variantes com prefixo. Quando nao existe nenhuma API de fullscreen de elemento
 * (ex.: iOS), cai para um modo "tela cheia" via CSS, que ocupa a viewport inteira.
 */
(function () {
    "use strict";

    var doc = document;
    var elProto = Element.prototype;
    var docProto = Document.prototype;

    // Se o navegador ja tem a API padrao completa, nao fazemos nada.
    if ("requestFullscreen" in elProto &&
        "exitFullscreen" in docProto &&
        "fullscreenElement" in docProto) {
        return;
    }

    function defineGetter(target, name, getter) {
        try {
            Object.defineProperty(target, name, { configurable: true, get: getter });
            return true;
        } catch (e) {
            return false;
        }
    }

    function fireFullscreenChange() {
        try {
            doc.dispatchEvent(new Event("fullscreenchange"));
        } catch (e) {
            var evt = doc.createEvent("Event");
            evt.initEvent("fullscreenchange", true, true);
            doc.dispatchEvent(evt);
        }
    }

    // --- Fallback via CSS (navegadores sem nenhuma API de fullscreen de elemento) ---
    var cssElement = null;
    var cssPrevStyle = null;

    function enterCssFullscreen(element) {
        exitCssFullscreen();

        cssElement = element;
        cssPrevStyle = {
            position: element.style.position,
            top: element.style.top,
            left: element.style.left,
            width: element.style.width,
            height: element.style.height,
            zIndex: element.style.zIndex,
            margin: element.style.margin,
            background: element.style.background
        };

        element.style.position = "fixed";
        element.style.top = "0";
        element.style.left = "0";
        element.style.width = "100vw";
        element.style.height = "100vh";
        element.style.zIndex = "2147483647";
        element.style.margin = "0";
        element.style.background = element.style.background || "#000";
        doc.documentElement.style.overflow = "hidden";

        fireFullscreenChange();
    }

    function exitCssFullscreen() {
        var element = cssElement;
        if (!element) {
            return;
        }

        if (cssPrevStyle) {
            for (var key in cssPrevStyle) {
                element.style[key] = cssPrevStyle[key];
            }
        }
        cssPrevStyle = null;
        cssElement = null;
        doc.documentElement.style.overflow = "";

        fireFullscreenChange();
    }

    // --- Element.requestFullscreen ---
    if (!("requestFullscreen" in elProto)) {
        var prefixedRequest =
            elProto.webkitRequestFullscreen ||
            elProto.webkitRequestFullScreen ||
            elProto.mozRequestFullScreen ||
            elProto.msRequestFullscreen;

        elProto.requestFullscreen = function () {
            if (prefixedRequest) {
                try {
                    var result = prefixedRequest.call(this);
                    return (result && typeof result.then === "function") ? result : Promise.resolve();
                } catch (e) {
                    return Promise.reject(e);
                }
            }

            enterCssFullscreen(this);
            return Promise.resolve();
        };
    }

    // --- Document.exitFullscreen ---
    if (!("exitFullscreen" in docProto)) {
        var prefixedExit =
            docProto.webkitExitFullscreen ||
            docProto.webkitCancelFullScreen ||
            docProto.mozCancelFullScreen ||
            docProto.msExitFullscreen;

        docProto.exitFullscreen = function () {
            if (cssElement) {
                exitCssFullscreen();
                return Promise.resolve();
            }

            if (prefixedExit) {
                try {
                    var result = prefixedExit.call(this);
                    return (result && typeof result.then === "function") ? result : Promise.resolve();
                } catch (e) {
                    return Promise.reject(e);
                }
            }

            return Promise.resolve();
        };
    }

    // --- document.fullscreenElement ---
    if (!("fullscreenElement" in docProto)) {
        defineGetter(docProto, "fullscreenElement", function () {
            return doc.webkitFullscreenElement ||
                doc.webkitCurrentFullScreenElement ||
                doc.mozFullScreenElement ||
                doc.msFullscreenElement ||
                cssElement ||
                null;
        });
    }

    // --- Traduz os eventos com prefixo para "fullscreenchange" ---
    ["webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"].forEach(function (name) {
        doc.addEventListener(name, function () {
            if (!cssElement) {
                fireFullscreenChange();
            }
        }, true);
    });
})();
