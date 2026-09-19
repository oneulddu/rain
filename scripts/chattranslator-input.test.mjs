import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";

function load(path, require, globals = {}) {
    const source = fs.readFileSync(new URL(path, import.meta.url), "utf8");
    const { code } = transformSync(source, { loader: path.endsWith("tsx") ? "tsx" : "ts", format: "cjs" });
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, require, console, ...globals });
    return module.exports;
}

function presenterFixture() {
    const sheets = [], calls = [], toasts = [];
    let discordSheet;
    const { showInputOptions } = load("../src/plugins/chattranslator/patches/inputOptions.ts", id => {
        if (id === "@metro") return { findByProps: prop => prop === "showSimpleActionSheet"
            ? discordSheet : { hideActionSheet: key => calls.push(`hide:${key}`) } };
        if (id === "@api/assets") return { findAssetId: () => 1 };
        if (id === "@api/ui/toasts") return { showToast: message => toasts.push(message) };
        if (id === "@lib/utils/logger") return { logger: { error() {} } };
        throw Error(id);
    });
    return {
        show: showInputOptions, sheets, calls, toasts,
        enableDiscord: () => { discordSheet = { showSimpleActionSheet: sheet => sheets.push(sheet) }; },
    };
}

test("the original Discord menu keeps its labels and subtitles and closes before running the selected action", () => {
    const f = presenterFixture();
    f.enableDiscord();
    f.show(["Receive", "Send", "Once", "Settings"].map(label => ({
        label, subLabel: "Only changes this channel.", onPress: () => f.calls.push(label),
    })));
    assert.equal(f.sheets.length, 1);
    const { options, header } = f.sheets[0];
    assert.equal(header.title, "ChatTranslator");
    assert.deepEqual(Array.from(options, option => option.label), ["Receive", "Send", "Once", "Settings"]);
    assert.equal(options[0].subLabel, "Only changes this channel.");
    assert.deepEqual(f.calls, []);
    options[3].onPress();
    assert.deepEqual(f.calls, ["hide:ChatTranslatorInputOptions", "Settings"]);
});

test("the Discord presenter is resolved when opening, including after an earlier lookup failed", () => {
    const f = presenterFixture();
    f.show([]);
    assert.equal(f.toasts.length, 1);
    f.enableDiscord();
    f.show([{ label: "Settings", onPress() {} }]);
    assert.equal(f.sheets.length, 1);
    assert.equal(f.sheets[0].key, "ChatTranslatorInputOptions");
    assert.deepEqual(f.calls, []);
});

test("missing presenters report a failure instead of throwing out of the gesture handler", () => {
    const f = presenterFixture();
    assert.doesNotThrow(() => f.show([]));
    assert.match(f.toasts[0], /Could not open ChatTranslator options/);
});

function inputFixture({ rootAvailable = true } = {}) {
    const menus = [], actions = [], timers = [], navigation = [], unhandledRoutes = [];
    const navigator = { navigate: (route, params) => {
        // Rain registers its page on the root; nested "main/settings" is unhandled.
        if (route !== "RAIN_CUSTOM_PAGE") { unhandledRoutes.push(route); return; }
        navigation.push({ route, params, rendered: params.render() });
    } };
    let patchRender;
    const React = {
        createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        useState: value => [value, () => {}],
        useEffect() {},
        useRef: value => ({ current: value }),
    };
    const selected = { getChannelId: () => "channel-1" };
    const { getRenderTarget } = load("../src/plugins/chattranslator/patches/renderTarget.ts");
    const { default: install } = load("../src/plugins/chattranslator/patches/ChatInputActions.tsx", id => {
        if (id === "@api/assets") return { findAssetId: () => 1 };
        if (id === "@api/patcher") return { after: (_key, _target, callback) => { patchRender = callback; return () => {}; } };
        if (id === "@api/ui/toasts") return { showToast() {} };
        if (id === "@metro") return { findByTypeDisplayName: () => ({ default() {} }) };
        if (id === "@metro/wrappers") return {
            findByStoreName: () => selected,
            findByPropsLazy: () => ({ getRootNavigationRef: () => rootAvailable ? navigator : undefined }),
        };
        if (id === "@metro/common") return {
            React, ReactNative: { Image: "Image", Pressable: "Pressable", Text: "Text", View: "View" },
            FluxUtils: { useStateFromStores: (_stores, read) => read() },
            NavigationNative: { useNavigation: () => navigator },
        };
        if (id === "../settings") return { __esModule: true, default: () => "ChatTranslator settings page" };
        if (id === "../storage") return { useChatTranslatorSettings: () => ({}) };
        if (id === "../state") return {
            isManualTranslateNextSendEnabled: () => false,
            toggleManualTranslateNextSend: () => { actions.push("once"); return true; },
        };
        if (id === "../utils") return {
            getReceivedAutoTranslateChannelState: () => false,
            getSentAutoTranslateChannelState: () => false,
            toggleReceivedAutoTranslateChannelState: channel => { actions.push(`received:${channel}`); return true; },
            toggleSentAutoTranslateChannelState: channel => { actions.push(`sent:${channel}`); return true; },
        };
        if (id === "./inputOptions") return { showInputOptions: options => menus.push({ options }) };
        if (id === "./renderTarget") return { getRenderTarget };
        throw Error(id);
    }, { setTimeout: fn => timers.push(fn) });
    install();
    const injected = patchRender([], { type: "OriginalInput" }).props.children[1];
    const press = injected.type().props;
    return { press, menus, actions, navigation, unhandledRoutes, flush: () => { while (timers.length) timers.shift()(); } };
}

test("long press opens four actions without toggling translation on release; the next tap still works", () => {
    const f = inputFixture();
    f.press.onPressIn();
    f.press.onLongPress({ nativeEvent: { target: 42 } });
    f.press.onPressOut?.();
    f.flush();
    f.press.onPress();
    assert.equal(f.menus.length, 1);
    assert.equal(f.menus[0].options.length, 4);
    assert.deepEqual(f.actions, []);
    f.press.onPressIn();
    f.press.onPress();
    assert.deepEqual(f.actions, ["received:channel-1"]);
});

test("each input option reaches its channel toggle, one-time translation, or settings destination", () => {
    const f = inputFixture();
    f.press.onLongPress({ nativeEvent: { target: 42 } });
    for (const option of f.menus[0].options) option.onPress();
    f.flush();
    assert.deepEqual(f.actions, ["received:channel-1", "sent:channel-1", "once"]);
    assert.deepEqual(f.unhandledRoutes, []);
    assert.equal(f.navigation.length, 1);
    assert.equal(f.navigation[0].route, "RAIN_CUSTOM_PAGE");
    assert.equal(f.navigation[0].params.title, "ChatTranslator");
    assert.equal(f.navigation[0].rendered, "ChatTranslator settings page");
});

test("settings use the same registered route when only the current navigator is available", () => {
    const f = inputFixture({ rootAvailable: false });
    f.press.onLongPress();
    f.menus[0].options[3].onPress();
    assert.equal(f.navigation.length, 0);
    f.flush();
    assert.deepEqual(f.unhandledRoutes, []);
    assert.equal(f.navigation.length, 1);
    assert.equal(f.navigation[0].rendered, "ChatTranslator settings page");
});
