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

function presenterFixture({ platform = "ios", native = true, nativeThrows = false } = {}) {
    const sheets = [], calls = [], toasts = [];
    let discordSheet;
    const ReactNative = {
        Platform: { OS: platform },
        Keyboard: { dismiss: () => calls.push("keyboard") },
        ActionSheetIOS: native ? {
            showActionSheetWithOptions: (options, select) => {
                if (nativeThrows) throw Error("native presenter unavailable");
                sheets.push({ options, select });
            },
        } : undefined,
    };
    const { showInputOptions } = load("../src/plugins/chattranslator/patches/inputOptions.ts", id => {
        if (id === "@metro/common") return { ReactNative };
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

test("iOS opens an anchored native menu without Discord's internal presenter; cancel changes nothing", () => {
    const f = presenterFixture();
    const selected = [];
    f.show(["Receive", "Send", "Once", "Settings"].map(label => ({ label, onPress: () => selected.push(label) })), 42);
    assert.equal(f.sheets.length, 1);
    const { options, select } = f.sheets[0];
    assert.deepEqual(Array.from(options.options), ["Receive", "Send", "Once", "Settings", "Cancel"]);
    assert.equal(options.anchor, 42);
    assert.equal(options.cancelButtonIndex, 4);
    select(4);
    assert.deepEqual(selected, []);
    for (let i = 0; i < 4; i++) select(i);
    assert.deepEqual(selected, ["Receive", "Send", "Once", "Settings"]);
});

test("an unavailable native presenter falls back to Discord and closes only its own menu", () => {
    const f = presenterFixture({ nativeThrows: true });
    f.enableDiscord();
    f.show([{ label: "Receive", onPress: () => f.calls.push("receive") }]);
    f.sheets[0].options[0].onPress();
    assert.deepEqual(f.calls, ["keyboard", "hide:ChatTranslatorInputOptions", "receive"]);
    assert.equal(f.toasts.length, 0);
});

test("Android resolves the Discord presenter when opening, including after an earlier lookup failed", () => {
    const f = presenterFixture({ platform: "android" });
    f.show([]);
    assert.equal(f.toasts.length, 1);
    f.enableDiscord();
    f.show([{ label: "Settings", onPress() {} }]);
    assert.equal(f.sheets.length, 1);
    assert.equal(f.sheets[0].key, "ChatTranslatorInputOptions");
    assert.deepEqual(f.calls, []);
});

test("missing presenters report a failure instead of throwing out of the gesture handler", () => {
    const f = presenterFixture({ native: false });
    assert.doesNotThrow(() => f.show([]));
    assert.match(f.toasts[0], /Could not open ChatTranslator options/);
});

function inputFixture() {
    const menus = [], actions = [], timers = [], navigation = [];
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
            findByPropsLazy: () => ({ getRootNavigationRef: () => ({ navigate: (...args) => navigation.push(args) }) }),
        };
        if (id === "@metro/common") return {
            React, ReactNative: { Image: "Image", Pressable: "Pressable", Text: "Text", View: "View" },
            FluxUtils: { useStateFromStores: (_stores, read) => read() },
            NavigationNative: { useNavigation: () => ({}) },
        };
        if (id === "../settings") return { default() {} };
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
        if (id === "./inputOptions") return { showInputOptions: (options, anchor) => menus.push({ options, anchor }) };
        if (id === "./renderTarget") return { getRenderTarget };
        throw Error(id);
    }, { setTimeout: fn => timers.push(fn) });
    install();
    const injected = patchRender([], { type: "OriginalInput" }).props.children[1];
    const press = injected.type().props;
    return { press, menus, actions, navigation, flush: () => { while (timers.length) timers.shift()(); } };
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
    assert.equal(f.menus[0].anchor, 42);
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
    assert.equal(f.navigation[0][0], "main");
    assert.equal(f.navigation[0][1].params.screen, "RAIN_CUSTOM_PAGE");
});
