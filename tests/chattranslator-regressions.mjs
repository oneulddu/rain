import assert from "node:assert/strict";

import {
    prepareImportedPluginStorage,
    sanitizePluginStorage,
} from "../src/plugins/_core/cloudsync/lib/storageSanitizer";
import {
    createTranslationRequestCoordinator,
    isTranslationRequestCancelled,
    makeTranslationRequestKey,
    runAbortableTranslationRequest,
    trackTranslationExecution,
} from "../src/plugins/chattranslator/requests";
import {
    googleLanguageToDeepLLanguage,
    normalizeLanguageForService,
} from "../src/plugins/chattranslator/lang";
import { prepareTextForTranslation } from "../src/plugins/chattranslator/text";

const TEST_TIMEOUT_MS = 2_000;
const SUITE_TIMEOUT_MS = 10_000;

const suiteWatchdog = setTimeout(() => {
    console.error(`ChatTranslator regression checks exceeded ${SUITE_TIMEOUT_MS}ms.`);
    process.exit(1);
}, SUITE_TIMEOUT_MS);

function deferred() {
    /** @type {(reason?: unknown) => void} */
    let reject = () => undefined;
    /** @type {(value?: unknown) => void} */
    let resolve = () => undefined;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        reject = rejectPromise;
        resolve = resolvePromise;
    });

    return { promise, reject, resolve };
}

async function flushPromises() {
    for (let index = 0; index < 8; index++) await Promise.resolve();
}

/**
 * @param {string} name
 * @param {() => Promise<void>} test
 */
async function runTest(name, test) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeout;

    try {
        await Promise.race([
            test(),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${name} exceeded ${TEST_TIMEOUT_MS}ms.`)), TEST_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function testSharedRequest() {
    const coordinator = createTranslationRequestCoordinator({ maxBackgroundQueued: 4, maxConcurrent: 2 });
    const result = deferred();
    let calls = 0;
    const execute = async () => {
        calls++;
        return result.promise;
    };
    const first = coordinator.acquire("same", execute);
    const second = coordinator.acquire("same", execute);

    await flushPromises();
    assert.equal(calls, 1);
    first.release();
    assert.equal(coordinator.getStats().active, 1);

    result.resolve("translated");
    assert.equal(await first.promise, "translated");
    assert.equal(await second.promise, "translated");
    second.release();
    assert.equal(calls, 1);
}

async function testLastConsumerCancellation() {
    assert.equal(isTranslationRequestCancelled({ name: "AbortError" }), true);

    const coordinator = createTranslationRequestCoordinator({ maxBackgroundQueued: 4, maxConcurrent: 1 });
    let aborted = false;
    const handle = coordinator.acquire("cancel", signal => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
            aborted = true;
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
        }, { once: true });
    }));

    await flushPromises();
    handle.release();
    await assert.rejects(handle.promise, isTranslationRequestCancelled);
    assert.equal(aborted, true);
}

async function testQueuedCancellationBeforeExecution() {
    const coordinator = createTranslationRequestCoordinator({ maxBackgroundQueued: 4, maxConcurrent: 1 });
    const activeGate = deferred();
    const active = coordinator.acquire("active", () => activeGate.promise);
    const queued = coordinator.acquire("queued", () => Promise.resolve("must not run"));

    queued.release();
    await assert.rejects(queued.promise, isTranslationRequestCancelled);
    assert.equal(coordinator.getStats().backgroundQueued, 0);

    activeGate.resolve("done");
    assert.equal(await active.promise, "done");
    active.release();
}

async function testCancellationDoesNotDependOnProvider() {
    const coordinator = createTranslationRequestCoordinator({ maxBackgroundQueued: 4, maxConcurrent: 1 });
    const activeGate = deferred();
    const nextGate = deferred();
    let started = 0;
    const handle = coordinator.acquire("ignores-abort", async () => {
        started++;
        return activeGate.promise;
    });
    const next = coordinator.acquire("next", async () => {
        started++;
        return nextGate.promise;
    });

    await flushPromises();
    handle.release();
    await assert.rejects(handle.promise, isTranslationRequestCancelled);
    await flushPromises();
    assert.equal(coordinator.getStats().active, 1);
    assert.equal(started, 1);

    activeGate.resolve("cancelled provider finished");
    await flushPromises();
    assert.equal(started, 2);
    nextGate.resolve("next finished");
    assert.equal(await next.promise, "next finished");
    next.release();
}

async function testSameTickCancellationSkipsProvider() {
    const coordinator = createTranslationRequestCoordinator({ maxBackgroundQueued: 4, maxConcurrent: 1 });
    let calls = 0;
    const handle = coordinator.acquire("same-tick", async () => {
        calls++;
        return "must not run";
    });

    handle.release();
    await assert.rejects(handle.promise, isTranslationRequestCancelled);
    await flushPromises();
    assert.equal(calls, 0);
    assert.equal(coordinator.getStats().active, 0);
}

async function testBackgroundQueueBound() {
    const coordinator = createTranslationRequestCoordinator({ maxBackgroundQueued: 1, maxConcurrent: 1 });
    const activeGate = deferred();
    const newestGate = deferred();
    const active = coordinator.acquire("active", () => activeGate.promise);
    const replaced = coordinator.acquire("replaced", () => Promise.resolve("must not run"));
    const newest = coordinator.acquire("newest", () => newestGate.promise);

    await assert.rejects(replaced.promise, isTranslationRequestCancelled);
    assert.equal(coordinator.getStats().backgroundQueued, 1);

    activeGate.resolve("active done");
    assert.equal(await active.promise, "active done");
    await flushPromises();
    newestGate.resolve("newest done");
    assert.equal(await newest.promise, "newest done");
    active.release();
    replaced.release();
    newest.release();
}

async function testAbortAll() {
    const coordinator = createTranslationRequestCoordinator({ maxBackgroundQueued: 2, maxConcurrent: 1 });
    const activeGate = deferred();
    const active = coordinator.acquire("active", () => activeGate.promise);
    const queued = coordinator.acquire("queued", () => Promise.resolve("must not run"));

    await flushPromises();
    coordinator.abortAll();
    await Promise.all([
        assert.rejects(active.promise, isTranslationRequestCancelled),
        assert.rejects(queued.promise, isTranslationRequestCancelled),
    ]);
    await flushPromises();
    assert.equal(coordinator.getStats().active, 1);
    activeGate.resolve("provider finished");
    await flushPromises();
    assert.deepEqual(coordinator.getStats(), {
        active: 0,
        backgroundQueued: 0,
        interactiveQueued: 0,
        shared: 0,
    });
}

async function testInvalidLimitsAreNormalized() {
    const coordinator = createTranslationRequestCoordinator({ maxBackgroundQueued: 0, maxConcurrent: 0 });
    const handle = coordinator.acquire("normalized", () => Promise.resolve("done"));

    assert.equal(await handle.promise, "done");
    handle.release();
}

async function testAbortCoversWholeRequestConsumption() {
    const controller = new AbortController();
    let providerSawAbort = false;
    const request = runAbortableTranslationRequest(controller.signal, 1_000, signal => {
        signal.addEventListener("abort", () => {
            providerSawAbort = true;
        }, { once: true });
        return new Promise(() => undefined);
    });

    await flushPromises();
    controller.abort();
    await assert.rejects(request, isTranslationRequestCancelled);
    assert.equal(providerSawAbort, true);
}

async function testWholeRequestTimeout() {
    await assert.rejects(
        runAbortableTranslationRequest(undefined, 10, () => new Promise(() => undefined)),
        /timed out/i
    );
}

async function testTimeoutKeepsPhysicalExecutionSlot() {
    const coordinator = createTranslationRequestCoordinator({ maxBackgroundQueued: 2, maxConcurrent: 1 });
    const physicalGate = deferred();
    const nextGate = deferred();
    let started = 0;
    const timedOut = coordinator.acquire("timed-out", () => trackTranslationExecution(reportCompletion => (
        runAbortableTranslationRequest(undefined, 10, async () => {
            started++;
            return physicalGate.promise;
        }, reportCompletion)
    )));
    const next = coordinator.acquire("next-after-timeout", async () => {
        started++;
        return nextGate.promise;
    });

    await assert.rejects(timedOut.promise, /timed out/i);
    await flushPromises();
    assert.equal(coordinator.getStats().active, 1);
    assert.equal(started, 1);

    physicalGate.resolve("physical request ended");
    await flushPromises();
    assert.equal(started, 2);
    nextGate.resolve("next ended");
    assert.equal(await next.promise, "next ended");
    timedOut.release();
    next.release();
}

async function testQueueWaitTimeout() {
    const coordinator = createTranslationRequestCoordinator({
        maxBackgroundQueued: 2,
        maxConcurrent: 1,
        maxQueueWaitMs: 10,
    });
    const activeGate = deferred();
    const active = coordinator.acquire("active-for-queue-timeout", () => activeGate.promise);
    const queued = coordinator.acquire("queue-timeout", () => Promise.resolve("must not run"));

    await assert.rejects(queued.promise, /timed out while waiting/i);
    assert.equal(coordinator.getStats().backgroundQueued, 0);
    activeGate.resolve("active ended");
    assert.equal(await active.promise, "active ended");
    active.release();
    queued.release();
}

async function testConcurrencyLimit() {
    const coordinator = createTranslationRequestCoordinator({ maxBackgroundQueued: 4, maxConcurrent: 2 });
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;
    const handles = gates.map((gate, index) => coordinator.acquire(String(index), async () => {
        started++;
        return gate.promise;
    }));

    await flushPromises();
    assert.equal(started, 2);
    gates[0].resolve("first");
    assert.equal(await handles[0].promise, "first");
    await flushPromises();
    assert.equal(started, 3);

    gates[1].resolve("second");
    gates[2].resolve("third");
    await Promise.all(handles.slice(1).map(handle => handle.promise));
    handles.forEach(handle => handle.release());
}

async function testInteractivePriorityAndPromotion() {
    const coordinator = createTranslationRequestCoordinator({
        maxBackgroundQueued: 4,
        maxConcurrent: 1,
        maxInteractiveQueued: 4,
    });
    const activeGate = deferred();
    const backgroundGate = deferred();
    const promotedGate = deferred();
    /** @type {string[]} */
    const order = [];
    let promotedCalls = 0;
    const active = coordinator.acquire("active", async () => {
        order.push("active");
        return activeGate.promise;
    });
    const background = coordinator.acquire("background", async () => {
        order.push("background");
        return backgroundGate.promise;
    });
    const promotedBackground = coordinator.acquire("promoted", async () => {
        promotedCalls++;
        order.push("promoted");
        return promotedGate.promise;
    });
    const promotedInteractive = coordinator.acquire(
        "promoted",
        () => Promise.resolve("must share the queued request"),
        "interactive"
    );

    await flushPromises();
    assert.deepEqual(order, ["active"]);
    activeGate.resolve("active done");
    assert.equal(await active.promise, "active done");
    await flushPromises();
    assert.deepEqual(order, ["active", "promoted"]);
    assert.equal(promotedCalls, 1);

    promotedGate.resolve("promoted done");
    assert.equal(await promotedBackground.promise, "promoted done");
    assert.equal(await promotedInteractive.promise, "promoted done");
    await flushPromises();
    assert.deepEqual(order, ["active", "promoted", "background"]);

    backgroundGate.resolve("background done");
    assert.equal(await background.promise, "background done");
    active.release();
    background.release();
    promotedBackground.release();
    promotedInteractive.release();
}

async function testLanguageFallbacks() {
    assert.equal(googleLanguageToDeepLLanguage("jw", "", true), "JV");
    assert.equal(googleLanguageToDeepLLanguage("tl", "", true), "TL");
    assert.equal(normalizeLanguageForService("jw", "deepl", false), "JV");
    assert.equal(normalizeLanguageForService("tl", "deepl", false), "TL");
}

async function testCollisionResistantRequestKeys() {
    const first = makeTranslationRequestKey("received", "a\0b", "c");
    const second = makeTranslationRequestKey("received", "a", "b\0c");

    assert.notEqual(first, second);
}

async function testPreservedTextBoundaries() {
    const inlineFence = "번역할 문장 ~~~ 이 부분도 번역";
    const inlinePrepared = prepareTextForTranslation(inlineFence);
    assert.equal(inlinePrepared.text, inlineFence);
    assert.equal(inlinePrepared.hasMeaningfulText, true);

    const fenced = "앞\n~~~~js\nconst value = 1;\n~~~\nstill code\n~~~~~\n뒤";
    const fencedPrepared = prepareTextForTranslation(fenced);
    assert.equal(fencedPrepared.text.includes("const value"), false);
    assert.equal(fencedPrepared.text.includes("still code"), false);
    assert.equal(fencedPrepared.restore(fencedPrepared.text), fenced);

    const quotedFence = "> ```js\n> const greeting = \"hello\";\n> ```";
    const quotedPrepared = prepareTextForTranslation(quotedFence);
    assert.equal(quotedPrepared.text.includes("const greeting"), false);
    assert.equal(quotedPrepared.restore(quotedPrepared.text), quotedFence);

    const escapedBackticks = "\\`hello world\\` should be translated";
    const escapedPrepared = prepareTextForTranslation(escapedBackticks);
    assert.equal(escapedPrepared.text, escapedBackticks);
    assert.equal(escapedPrepared.hasMeaningfulText, true);

    const markerCollision = "⟪RAIN_CHAT_TRANSLATOR_TOKEN_0⟫ https://example.com";
    const collisionPrepared = prepareTextForTranslation(markerCollision);
    assert.equal(collisionPrepared.restore(collisionPrepared.text), markerCollision);
    assert.throws(() => collisionPrepared.restore("protected token was removed"), /protected message content/i);
    assert.throws(
        () => collisionPrepared.restore(`${collisionPrepared.text} ⟪RAIN_CHAT_TRANSLATOR_TOKEN__999⟫`),
        /protected message content/i
    );
}

async function testCloudSyncSecretHandling() {
    const incoming = JSON.stringify({
        state: {
            azureApiKey: "cloud-azure-secret",
            deeplApiKey: "cloud-deepl-secret",
            service: "azure",
        },
        version: 0,
    });
    const sanitized = JSON.parse(sanitizePluginStorage("chattranslator", incoming));
    assert.equal(sanitized.state.service, "azure");
    assert.equal("azureApiKey" in sanitized.state, false);
    assert.equal("deeplApiKey" in sanitized.state, false);

    const local = JSON.stringify({
        state: {
            azureApiKey: "local-azure-secret",
            deeplApiKey: "local-deepl-secret",
            service: "google",
        },
        version: 0,
    });
    const imported = JSON.parse(prepareImportedPluginStorage("chattranslator", incoming, local));
    assert.equal(imported.state.service, "azure");
    assert.equal(imported.state.azureApiKey, "local-azure-secret");
    assert.equal(imported.state.deeplApiKey, "local-deepl-secret");
    assert.deepEqual(
        JSON.parse(prepareImportedPluginStorage("chattranslator", "null", local)),
        JSON.parse(local)
    );

    const generic = JSON.parse(sanitizePluginStorage("another-plugin", JSON.stringify({
        state: {
            privateValue: { __no_sync: true, value: "hidden" },
            visibleValue: 1,
        },
    })));
    assert.equal("privateValue" in generic.state, false);
    assert.equal(generic.state.visibleValue, 1);
}

try {
    await runTest("shared request", testSharedRequest);
    await runTest("last consumer cancellation", testLastConsumerCancellation);
    await runTest("queued cancellation", testQueuedCancellationBeforeExecution);
    await runTest("provider-independent cancellation", testCancellationDoesNotDependOnProvider);
    await runTest("same-tick cancellation", testSameTickCancellationSkipsProvider);
    await runTest("background queue bound", testBackgroundQueueBound);
    await runTest("abort all", testAbortAll);
    await runTest("invalid limit normalization", testInvalidLimitsAreNormalized);
    await runTest("whole request abort", testAbortCoversWholeRequestConsumption);
    await runTest("whole request timeout", testWholeRequestTimeout);
    await runTest("physical execution slot after timeout", testTimeoutKeepsPhysicalExecutionSlot);
    await runTest("queue wait timeout", testQueueWaitTimeout);
    await runTest("concurrency limit", testConcurrencyLimit);
    await runTest("interactive priority and promotion", testInteractivePriorityAndPromotion);
    await runTest("language fallbacks", testLanguageFallbacks);
    await runTest("collision-resistant request keys", testCollisionResistantRequestKeys);
    await runTest("preserved text boundaries", testPreservedTextBoundaries);
    await runTest("cloud sync secret handling", testCloudSyncSecretHandling);

    console.log("ChatTranslator regression checks passed (18 groups).");
} finally {
    clearTimeout(suiteWatchdog);
}
