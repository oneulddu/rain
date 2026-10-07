// @ts-nocheck -- Runtime fixtures intentionally replace native Discord modules.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function fixture(t, initialFiles = {}) {
    const files = new Map(Object.entries(initialFiles));
    const writes = [], events = [], messages = new Map(), timers = new Set();
    const native = {
        fileExists: async name => files.has(name),
        readFile: async name => files.get(name),
        writeFile: async (name, value) => { writes.push([name, value]); files.set(name, value); },
    };
    const stubs = {
        "@api/native/fs": native,
        "@api/assets": { findAssetId: () => 1 },
        "@api/ui/toasts": { showToast() {} },
        "@lib/utils/logger": { logger: { error() {}, warn() {}, log() {} } },
        "@metro/common": { FluxDispatcher: { dispatch: event => {
            events.push(event);
            if (event.type === "MESSAGE_UPDATE") {
                const previous = messages.get(event.message.id);
                messages.set(event.message.id, { ...previous, ...event.message });
            }
        } } },
        "@metro/wrappers": { findByStoreName: name => name === "MessageStore"
            ? { getMessage: (_channel, id) => messages.get(id) }
            : { getChannel: () => ({ guild_id: "guild" }) } },
        "@metro": { findByStoreName: () => ({ getChannel: () => ({ guild_id: "guild" }) }) },
    };
    const cache = new Map();
    function load(name, parent = root) {
        if (Object.hasOwn(stubs, name)) return stubs[name];
        const alias = { "@api/": "src/api/", "@lib/": "src/lib/", "@plugins/": "src/plugins/" };
        let candidate = name.startsWith(".") ? path.resolve(parent, name) : null;
        for (const [prefix, replacement] of Object.entries(alias)) {
            if (name.startsWith(prefix)) candidate = path.join(root, replacement, name.slice(prefix.length));
        }
        if (!candidate) return require(name);
        const filename = [candidate, `${candidate}.ts`, `${candidate}.tsx`, path.join(candidate, "index.ts")]
            .find(file => fs.existsSync(file) && fs.statSync(file).isFile());
        if (!filename) throw new Error(`Missing fixture module ${name}`);
        if (cache.has(filename)) return cache.get(filename).exports;
        const module = { exports: {} };
        cache.set(filename, module);
        const { code } = transformSync(fs.readFileSync(filename, "utf8"), {
            loader: filename.endsWith("tsx") ? "tsx" : "ts", format: "cjs",
        });
        Function("require", "module", "exports", "setTimeout", "clearTimeout", "console", code)(
            id => load(id, path.dirname(filename)), module, module.exports,
            (callback, delay) => {
                const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
                timers.add(timer);
                return timer;
            },
            timer => { clearTimeout(timer); timers.delete(timer); },
            { error() {}, warn() {}, log() {} },
        );
        return module.exports;
    }
    t.after(() => { for (const timer of timers) clearTimeout(timer); });
    return { files, writes, events, messages, native, stubs, load };
}

test("storage serializes reads, writes and read-modify-writes without losing a local key", async t => {
    const f = fixture(t, { "settings.json": "old" });
    const storage = f.load("@api/storage");
    const gate = deferred();
    const write = f.native.writeFile;
    f.native.writeFile = async (name, value) => { if (value === "local-key") await gate.promise; await write(name, value); };
    const first = storage.writeStorageFile("settings.json", "local-key");
    const update = storage.updateStorageFile("settings.json", value => `import-with-${value}`);
    const read = storage.readStorageFile("settings.json");
    await flush();
    assert.equal(f.files.get("settings.json"), "old");
    gate.resolve();
    await Promise.all([first, update]);
    assert.equal(await read, "import-with-local-key");
});

test("failed hydration cannot overwrite saved settings and a later rehydrate recovers", async t => {
    const saved = JSON.stringify({ state: { secret: "keep" }, version: 0 });
    const f = fixture(t, { "plugins/test.json": saved });
    const read = f.native.readFile;
    f.native.readFile = async () => { throw new Error("unavailable"); };
    const storage = f.load("@api/storage");
    const { useStore } = storage.createPluginStore("test", { secret: "default" });
    await flush();
    assert.equal(storage.hasPluginStoreHydrationFailed("test"), true);
    useStore.getState().updateSettings({ secret: "must not overwrite" });
    await flush();
    assert.equal(f.files.get("plugins/test.json"), saved);
    f.native.readFile = read;
    await storage.rehydratePluginStore("test");
    await storage.waitForStorageWrites("plugins/test.json");
    assert.equal(useStore.getState().secret, "keep");
    assert.equal(useStore.getState()._hasHydrated, true);
    assert.equal(storage.hasPluginStoreHydrationFailed("test"), false);
    assert.equal("_hasHydrated" in JSON.parse(f.files.get("plugins/test.json")).state, false);
});

test("cloud import retains device secrets and refreshes an already loaded store", async t => {
    const f = fixture(t, { "plugins/chattranslator.json": JSON.stringify({
        state: { azureApiKey: "device-key", service: "google" }, version: 0,
    }) });
    const storage = f.load("@api/storage");
    const { prepareImportedPluginStorage } = f.load("./src/plugins/_core/cloudsync/lib/storageSanitizer");
    const { useStore } = storage.createPluginStore("chattranslator", { azureApiKey: "", service: "google" });
    await flush();
    await storage.updateStorageFile("plugins/chattranslator.json", local => prepareImportedPluginStorage(
        "chattranslator", JSON.stringify({ state: { azureApiKey: "cloud-key", service: "azure" }, version: 0 }), local,
    ));
    await storage.rehydratePluginStore("chattranslator");
    assert.equal(useStore.getState().azureApiKey, "device-key");
    assert.equal(useStore.getState().service, "azure");
});

test("cache updates do not trigger cloud sync and failed writes remain observable", async t => {
    const f = fixture(t);
    const storage = f.load("@api/storage");
    const { useStore } = storage.createPluginStore("cache", { entries: {} }, { emitSettingUpdated: false });
    await flush();
    f.native.writeFile = async () => { throw new Error("disk full"); };
    useStore.getState().updateSettings({ entries: { one: "value" } });
    await assert.rejects(storage.waitForStorageWrites("plugins/cache.json"), /disk full/);
    assert.equal(f.events.length, 0);
});

async function translatorFixture(t) {
    const f = fixture(t);
    const storage = f.load("./src/plugins/chattranslator/storage");
    await flush();
    storage.useChatTranslatorSettings.getState().updateSettings({ autoTranslate: true, autoTranslateReceived: true });
    const utils = f.load("./src/plugins/chattranslator/utils");
    const requests = f.load("./src/plugins/chattranslator/requests");
    const providers = [];
    f.stubs["../utils"] = f.stubs["./utils"] = { ...utils, translate: (_kind, text) => {
        const gate = deferred();
        providers.push({ ...gate, text });
        return gate.promise;
    } };
    t.after(async () => {
        requests.translationRequestCoordinator.abortAll();
        for (const provider of providers) provider.resolve({ text: "finished", sourceLanguage: "English" });
        await flush();
    });
    return { ...f, storage, providers };
}

async function sendFixture(t) {
    const f = await translatorFixture(t);
    const sent = [];
    const messages = { sendMessage: (channel, payload) => { sent.push([channel, payload.content]); return payload.content; } };
    f.stubs["@metro"].findByProps = () => messages;
    f.stubs["@api/patcher"] = { instead: (key, target, callback) => {
        const original = target[key];
        target[key] = (...args) => callback(args, original);
        return () => { target[key] = original; };
    } };
    f.stubs["../state"] = { consumeManualTranslateNextSend: () => false, isManualTranslateNextSendEnabled: () => false };
    const install = f.load("./src/plugins/chattranslator/patches/sendMessage").default;
    const stop = install();
    t.after(stop);
    return { ...f, sent, messages, install, stop };
}

test("outgoing translations preserve channel order while another channel can send", async t => {
    const f = await sendFixture(t);
    const first = f.messages.sendMessage("one", { content: "first" });
    const second = f.messages.sendMessage("one", { content: "second" });
    const third = f.messages.sendMessage("two", { content: "third" });
    await flush();
    f.providers[1].resolve({ text: "둘", sourceLanguage: "English" });
    f.providers[2].resolve({ text: "셋", sourceLanguage: "English" });
    await flush();
    assert.deepEqual(f.sent, [["two", "셋"]]);
    f.providers[0].resolve({ text: "하나", sourceLanguage: "English" });
    await Promise.all([first, second, third]);
    assert.deepEqual(f.sent, [["two", "셋"], ["one", "하나"], ["one", "둘"]]);
});

test("stop and immediate restart send pending originals once without stale translations", async t => {
    const f = await sendFixture(t);
    const first = f.messages.sendMessage("one", { content: "first" });
    const second = f.messages.sendMessage("one", { content: "second" });
    await flush();
    f.stop();
    const stopAgain = f.install();
    t.after(stopAgain);
    const third = f.messages.sendMessage("one", { content: "third" });
    await flush();
    f.providers[2].resolve({ text: "셋", sourceLanguage: "English" });
    await Promise.all([first, second, third]);
    assert.deepEqual(f.sent, [["one", "first"], ["one", "second"], ["one", "셋"]]);
});

test("provider failure falls back to the original without sending twice", async t => {
    const f = await sendFixture(t);
    const result = f.messages.sendMessage("one", { content: "original" });
    await flush();
    f.providers[0].reject(new Error("timeout"));
    assert.equal(await result, "original");
    assert.deepEqual(f.sent, [["one", "original"]]);
});

test("editing a received message during translation prevents stale replacement", async t => {
    const f = await translatorFixture(t);
    const state = f.load("./src/plugins/chattranslator/state");
    state.setChatTranslatorRuntimeActive(true);
    t.after(() => state.setChatTranslatorRuntimeActive(false));
    const message = { id: "1", channel_id: "one", content: "original", author: { id: "user" } };
    f.messages.set(message.id, message);
    const result = state.translateAndReplaceMessage(message);
    await flush();
    f.messages.set(message.id, { ...message, content: "edited" });
    f.providers[0].resolve({ text: "옛 번역", sourceLanguage: "English" });
    assert.equal((await result).ok, false);
    assert.equal(f.messages.get(message.id).content, "edited");
    assert.equal(f.events.some(event => event.type === "MESSAGE_UPDATE"), false);
});

test("received cache reuses a result and restoring originals preserves subsequent edits", async t => {
    const f = await translatorFixture(t);
    const state = f.load("./src/plugins/chattranslator/state");
    state.setChatTranslatorRuntimeActive(true);
    t.after(() => state.setChatTranslatorRuntimeActive(false));
    const first = { id: "1", channel_id: "one", content: "hello", author: { id: "user" } };
    const second = { ...first, id: "2" };
    f.messages.set(first.id, first);
    f.messages.set(second.id, second);
    const result = state.translateAndReplaceMessage(first);
    await flush();
    f.providers[0].resolve({ text: "안녕", sourceLanguage: "English" });
    assert.equal((await result).ok, true);
    assert.equal((await state.replaceMessageWithCachedTranslation(second)).ok, true);
    assert.equal(f.providers.length, 1);
    f.messages.set(second.id, { ...second, content: "new edit" });
    state.revertAllTranslatedMessages();
    assert.equal(f.messages.get(first.id).content, "hello");
    assert.equal(f.messages.get(second.id).content, "new edit");
});
