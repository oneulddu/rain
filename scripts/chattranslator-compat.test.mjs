import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";

function load(relativePath, require) {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const { code } = transformSync(source, { loader: relativePath.endsWith("tsx") ? "tsx" : "ts", format: "cjs" });
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, require, console });
    return module.exports;
}

const { getRenderTarget } = load("../src/plugins/chattranslator/patches/renderTarget.ts");

test("resolves plain, memo, forwardRef and memo-forwardRef exports", () => {
    const render = () => null;
    for (const component of [render, { type: render }, { render }, { type: { render } }]) {
        const module = { default: component };
        const result = getRenderTarget(module);
        assert.equal(result.target[result.key], render);
    }
    assert.equal(getRenderTarget(undefined), undefined);
    assert.equal(getRenderTarget({ default: {} }), undefined);
    const cycle = {};
    cycle.type = cycle;
    assert.equal(getRenderTarget({ default: cycle }), undefined);
});

function fixture({ failAt = -1, failRestore = false } = {}) {
    const loaded = [];
    const installed = new Set();
    let active = false;
    let installs = 0;
    const state = {
        setChatTranslatorRuntimeActive: value => { active = value; },
        revertAllTranslatedMessages: () => {
            if (failRestore) throw new Error("restore failed");
        },
    };
    const plugin = load("../src/plugins/chattranslator/index.ts", id => {
        if (id === "@plugins") return { definePlugin: value => value };
        if (id === "@rain/Developers") return { Contributors: { oneulffu: {} } };
        if (id === "react") return { createElement: component => component };
        loaded.push(id);
        if (id === "./state") return state;
        if (id.startsWith("./patches/")) return { default: () => {
            if (installs++ === failAt) throw new Error("Discord surface changed");
            installed.add(id);
            return () => installed.delete(id);
        } };
        throw new Error(`Unexpected early import: ${id}`);
    }).default;
    return { plugin, loaded, installed, active: () => active };
}

test("discovery does not resolve Discord surfaces or settings", () => {
    const { loaded } = fixture();
    assert.deepEqual(loaded, []);
});

test("a later installation failure rolls back earlier patches", () => {
    const f = fixture({ failAt: 2 });
    assert.throws(() => f.plugin.start(), /surface changed/);
    assert.equal(f.installed.size, 0);
    assert.equal(f.active(), false);
});

test("start is idempotent and stop removes all five patches", () => {
    const f = fixture();
    f.plugin.start();
    f.plugin.start();
    assert.equal(f.installed.size, 5);
    assert.equal(f.loaded.filter(id => id.startsWith("./patches/")).length, 5);
    f.plugin.stop();
    assert.equal(f.installed.size, 0);
    assert.equal(f.active(), false);
});

test("cleanup still runs if restoring messages fails", () => {
    const f = fixture({ failRestore: true });
    f.plugin.start();
    assert.throws(() => f.plugin.stop(), /restore failed/);
    assert.equal(f.installed.size, 0);
    assert.equal(f.active(), false);
});

function messageMenuFixture() {
    let open;
    let installed = 0;
    const errors = [];
    const patch = load("../src/plugins/chattranslator/patches/MessageLongPressActionSheet.tsx", id => {
        if (id === "@api/assets") return { findAssetId: () => 1 };
        if (id === "@metro") return { findByProps: () => ({ openLazy() {}, ActionSheetRow() {} }) };
        if (id === "@api/patcher") return {
            before: (_key, _target, callback) => { open = callback; return () => {}; },
            after: (key, target) => {
                assert.equal(typeof target[key], "function");
                installed++;
                return () => installed--;
            },
        };
        if (id === "./renderTarget") return { getRenderTarget };
        if (id === "@lib/utils/logger") return { logger: { error: (...args) => errors.push(args) } };
        return {};
    }).default;
    const stop = patch();
    return { open: component => open([component, "MessageLongPressActionSheet", { message: { id: "1" } }]), stop, installed: () => installed, errors };
}

test("message menu does not install a late patch after stop", async () => {
    const f = messageMenuFixture();
    let resolve;
    f.open(new Promise(done => { resolve = done; }));
    f.stop();
    resolve({ default() {} });
    await new Promise(done => setImmediate(done));
    assert.equal(f.installed(), 0);
});

test("message menu accepts memo exports and cleans them up", async () => {
    const f = messageMenuFixture();
    f.open(Promise.resolve({ default: { type() {} } }));
    await new Promise(done => setImmediate(done));
    assert.equal(f.installed(), 1);
    assert.equal(f.errors.length, 0);
    f.stop();
    assert.equal(f.installed(), 0);
});
