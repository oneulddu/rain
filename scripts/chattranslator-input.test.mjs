import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { cloneElement, createElement, isValidElement } from "react";

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

function settingsFixture({ available = true, navigatorByName = true, pushThrows = false } = {}) {
    const pushed = [], errors = [], toasts = [];
    let popped = 0;
    const Navigator = () => null;
    const Settings = () => "ChatTranslator settings page";
    const CustomPageRenderer = () => "Nested settings page";
    const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
    const navigation = {
        push: component => {
            assert.equal(typeof component, "function", "chat has no named settings routes");
            if (pushThrows) throw Error("presentation failed");
            pushed.push(component);
        },
        pop: () => popped++,
    };
    const { openChatTranslatorSettings } = load("../src/plugins/chattranslator/settings/openSettings.tsx", id => {
        if (id === "@api/assets") return { findAssetId: () => 1 };
        if (id === "@api/ui/toasts") return { showToast: message => toasts.push(message) };
        if (id === "@lib/utils/logger") return { logger: { error: (...args) => errors.push(args) } };
        if (id === "@metro/common") return { React };
        if (id === "@plugins/_core/settings/patches/shared") return { CustomPageRenderer };
        if (id === ".") return { __esModule: true, default: Settings };
        if (id === "@metro") return {
            findByName: name => navigatorByName && name === "Navigator" ? Navigator : undefined,
            findByProps: (...props) => {
                if (props[0] === "push") return available ? navigation : undefined;
                if (props[0] === "Navigator") return { Navigator };
                if (props[0] === "getRenderCloseButton") return { getRenderCloseButton: close => close };
                throw Error(`Unexpected navigator lookup: ${props}`);
            },
        };
        throw Error(id);
    });
    return { open: openChatTranslatorSettings, pushed, errors, toasts, Navigator, Settings, CustomPageRenderer, popped: () => popped };
}

function inputFixture() {
    const menus = [], actions = [], timers = [];
    const settings = settingsFixture();
    let patchRender;
    const React = {
        createElement,
        isValidElement,
        cloneElement,
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
        if (id === "@metro/wrappers") return { findByStoreName: () => selected };
        if (id === "@metro/common") return {
            React, ReactNative: { Image: "Image", Pressable: "Pressable", Text: "Text", View: "View" },
            FluxUtils: { useStateFromStores: (_stores, read) => read() },
        };
        if (id === "../settings/openSettings") return { openChatTranslatorSettings: settings.open };
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
    const nativeChildren = [createElement("AttachButton", { key: "attach" })];
    const nativeStyle = [{ flexDirection: "row", alignItems: "center" }, { alignSelf: "flex-end", marginBottom: 4 }];
    const onLayout = () => {};
    const original = createElement("NativeActionRow", {
        key: "native-actions", ref: { current: null },
        style: nativeStyle, onLayout, pointerEvents: "box-none",
    }, nativeChildren);
    const rendered = patchRender([], original);
    const injected = rendered.props.children[1];
    const slot = injected.type();
    const press = slot.props.children.props;
    return { press, slot, menus, actions, settings, original, rendered, patchRender, flush: () => { while (timers.length) timers.shift()(); } };
}

test("translation is inserted inside the native action row without replacing its layout or refs", () => {
    const f = inputFixture();
    assert.equal(f.rendered.type, f.original.type);
    assert.equal(f.rendered.key, f.original.key);
    assert.equal(f.rendered.props.ref, f.original.props.ref);
    assert.equal(f.rendered.props.style, f.original.props.style);
    assert.equal(f.rendered.props.onLayout, f.original.props.onLayout);
    assert.equal(f.rendered.props.pointerEvents, "box-none");
    assert.equal(f.rendered.props.children[0], f.original.props.children);
    assert.equal(f.original.props.children.length, 1);
    assert.equal(f.rendered.props.children[1].key, "chat-translator-input-action");
});

test("hidden actions stay hidden and repeated renders do not mutate or duplicate native children", () => {
    const f = inputFixture();
    assert.equal(f.patchRender([], null), null);
    assert.equal(f.patchRender([], false), false);
    const repeated = f.patchRender([], f.original);
    assert.equal(repeated.props.children.length, 2);
    assert.equal(repeated.props.children[0], f.original.props.children);
    assert.equal(f.original.props.children.length, 1);
});

test("the translation button inherits the native row height instead of increasing the composer height", () => {
    const f = inputFixture();
    assert.equal(f.slot.props.style.alignSelf, "stretch");
    assert.equal(f.slot.props.style.height, undefined);
    const buttonStyle = f.press.style({ pressed: false });
    assert.equal(buttonStyle.height, undefined);
    assert.equal(buttonStyle.position, "absolute");
    assert.deepEqual([buttonStyle.top, buttonStyle.bottom, buttonStyle.left, buttonStyle.right], [0, 0, 0, 0]);
});

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
    assert.equal(f.settings.pushed.length, 1);
    const navigator = f.settings.pushed[0]();
    assert.equal(navigator.type, f.settings.Navigator);
    const screen = navigator.props.screens[navigator.props.initialRouteName];
    assert.equal(screen.title, "ChatTranslator");
    assert.equal(screen.render().type, f.settings.Settings);
    assert.equal(screen.render().type(), "ChatTranslator settings page");
});

test("settings open from chat without named routes and register language subpages and a close action", () => {
    const f = inputFixture();
    f.press.onLongPress();
    f.menus[0].options[3].onPress();
    assert.equal(f.settings.pushed.length, 0);
    f.flush();
    assert.equal(f.settings.pushed.length, 1);
    const { screens, goBackOnBackPress } = f.settings.pushed[0]().props;
    assert.equal(goBackOnBackPress, true);
    assert.equal(screens.RAIN_CUSTOM_PAGE.render().type, f.settings.CustomPageRenderer);
    screens.ChatTranslatorSettings.headerLeft();
    assert.equal(f.settings.popped(), 1);
});

test("the settings navigator supports the property export used by other Discord builds", () => {
    const f = settingsFixture({ navigatorByName: false });
    f.open();
    assert.equal(f.pushed.length, 1);
    assert.equal(f.pushed[0]().type, f.Navigator);
});

test("settings presentation failures are visible instead of silently ignoring navigation", () => {
    for (const config of [{ available: false }, { pushThrows: true }]) {
        const f = settingsFixture(config);
        assert.doesNotThrow(() => f.open());
        assert.equal(f.pushed.length, 0);
        assert.equal(f.errors.length, 1);
        assert.match(f.toasts[0], /Could not open ChatTranslator settings/);
    }
});
