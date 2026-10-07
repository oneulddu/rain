import {
    hasPluginStoreHydrationFailed,
    rehydratePluginStore,
    waitForHydration,
    waitForStorageWrites,
    writeStorageFile,
} from "@api/storage";
import { cyrb64Hash } from "@lib/utils/cyrb64";
import { logger } from "@lib/utils/logger";
import { FluxDispatcher } from "@metro/common";
import { findByStoreName } from "@metro/wrappers";

import { getLanguageDisplayName } from "./lang";
import {
    makeTranslationRequestKey,
    trackTranslationExecution,
    translationRequestCoordinator,
} from "./requests";
import {
    useChatTranslatorCacheStore,
    useChatTranslatorSettings,
} from "./storage";
import {
    DiscordMessage,
    getAutomaticMessageSkipReason,
    getGoogleConfidenceSkipReason,
    getManualTranslationBlockReason,
    getMessageChannelId,
    getMessageContent,
    getReceivedAutoTranslateChannelState,
    getReceivedTranslationCacheSignatureFromValues,
    getReceivedTranslationNetworkSignatureFromValues,
    getReceivedTranslationOptionsForChannel,
    getReceivedTranslationRequestSignatureFromValues,
    isTranslationAbortError,
    normalizeTranslationFailureReason,
    switchDeepLToGoogleIfApiKeyMissing,
    translate,
    TranslationValue,
} from "./utils";

interface TranslationRecord {
    cacheKey: string;
    cacheSignature: string;
    channelId: string;
    manual: boolean;
    originalContentHash: string;
    originalContent: string;
    requestSignature: string;
    sourceLanguage: string;
    targetLanguage: string;
    timestamp: number;
    translated: TranslationValue;
    translatedContent: string;
    view: "original" | "translation";
}

interface TranslationCacheEntry {
    cacheSignature: string;
    channelId: string;
    key: string;
    lastUsedAt: number;
    messageId?: string;
    networkSignature: string;
    originalContent?: string;
    sourceLang: string;
    targetLang: string;
    timestamp: number;
    translated: TranslationValue;
}

export interface TranslationOutcome {
    ok: boolean;
    reason?: string;
    translated?: TranslationValue;
}

export interface TranslationCacheStats {
    cached: number;
    expired: number;
    limit: number;
    oldestUpdatedAt?: number;
    pending: number;
    signatureCached?: number;
    translated: number;
    ttlDays: number;
}

export const NO_CACHED_TRANSLATION_REASON = "Skipped: no cached translation.";
export const RETRY_CACHED_TRANSLATION_REASON = "Skipped: cached translation is waiting for the message store.";

interface PendingTranslation {
    cacheKey: string;
    cacheSignature: string;
    channelId: string;
    generation: number;
    ignoreConfidenceRequirement: boolean;
    manual: boolean;
    messageId: string;
    originalContent: string;
    originalContentHash: string;
    previousTranslatedContent?: string;
    requestId: number;
    requestSignature: string;
    releaseRequest?: () => void;
    startedAt: number;
}

const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const translatedMessages = new Map<string, TranslationRecord>();
const translationCache = new Map<string, TranslationCacheEntry>();
const pendingTranslations = new Map<string, PendingTranslation>();
const outgoingStateListeners = new Set<() => void>();
const translationStateListeners = new Set<() => void>();
const DEFAULT_CACHE_LIMIT = 1500;
export const MAX_TRANSLATION_CACHE_LIMIT = 5000;
const MAX_PENDING_TRANSLATIONS = 300;
const MAX_TRANSLATED_MESSAGE_RECORDS = 2000;
const CACHE_PERSIST_DELAY_MS = 1000;
const CACHE_EXPIRY_PRUNE_INTERVAL_MS = 60000;
const CACHE_HIT_PERSIST_INTERVAL_MS = 5 * 60 * 1000;
const ACTUAL_CACHE_HYDRATION_WAIT_MS = 30000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_PLUGIN_NAME = "chattranslator-cache";
const CACHE_STORAGE_PATH = `plugins/${CACHE_PLUGIN_NAME}.json`;
let runtimeActive = false;
let runtimeGeneration = 0;
let manualTranslateNextSend = false;
let persistentCacheHydrated = false;
let persistentCacheHydrationPromise: Promise<void> | null = null;
let persistentCacheGeneration = 0;
let latePersistentCacheUnsubscribe: (() => void) | null = null;
let actualPersistentCacheHydrationWait: {
    promise: Promise<boolean>;
} | null = null;
let translationCachePersistTimer: ReturnType<typeof setTimeout> | null = null;
let translationCacheRevision = 0;
let lastCacheExpiryPruneAt = 0;
let lastCacheHitPersistAt = 0;
let nextRequestId = 0;
let translationStateBatchDepth = 0;
let translationStateChangePending = false;
let translationStateVersion = 0;
let cachedCacheStats: {
    minute: number;
    revision: number;
    signature?: string;
    stats: Omit<TranslationCacheStats, "pending" | "translated">;
} | null = null;

function notifyTranslationStateChange() {
    translationStateVersion++;
    for (const listener of translationStateListeners) {
        try {
            listener();
        } catch (error) {
            logger.error(
                "[ChatTranslator] Translation state listener failed",
                error instanceof Error ? error.name : "UnknownError"
            );
        }
    }
}

function emitTranslationStateChange() {
    if (translationStateBatchDepth > 0) {
        translationStateChangePending = true;
        return;
    }

    notifyTranslationStateChange();
}

function emitTranslationCacheChange() {
    translationCacheRevision++;
    emitTranslationStateChange();
}

function clearLatePersistentCacheSubscription() {
    const cleanup = latePersistentCacheUnsubscribe;
    if (!cleanup) return;

    try {
        cleanup();
    } catch (error) {
        logger.warn(
            "[ChatTranslator] Failed to remove a cache hydration subscription:",
            error instanceof Error ? error.name : "UnknownError"
        );
    } finally {
        if (latePersistentCacheUnsubscribe === cleanup) {
            latePersistentCacheUnsubscribe = null;
        }
    }
}

function batchTranslationStateChanges<T>(callback: () => T): T {
    translationStateBatchDepth++;

    try {
        return callback();
    } finally {
        translationStateBatchDepth--;
        if (translationStateBatchDepth === 0 && translationStateChangePending) {
            translationStateChangePending = false;
            notifyTranslationStateChange();
        }
    }
}

export function subscribeTranslationState(listener: () => void): () => void {
    translationStateListeners.add(listener);
    return () => translationStateListeners.delete(listener);
}

export function getTranslationStateVersion(): number {
    return translationStateVersion;
}

export function setChatTranslatorRuntimeActive(active: boolean) {
    runtimeActive = active;
    runtimeGeneration++;

    if (active) {
        const generation = runtimeGeneration;
        void ensurePersistentCacheLoaded().then(() => {
            if (runtimeActive && generation === runtimeGeneration) void pruneTranslationCache();
        });
    } else {
        cancelAllPendingTranslations();
        translationRequestCoordinator.abortAll();
        persistentCacheGeneration++;
        clearLatePersistentCacheSubscription();
        if (translationCachePersistTimer) void persistTranslationCache();
        setManualTranslateNextSend(false);
    }

    emitTranslationStateChange();
}

function emitOutgoingStateChange() {
    for (const listener of outgoingStateListeners) {
        try {
            listener();
        } catch (error) {
            logger.error(
                "[ChatTranslator] Outgoing state listener failed",
                error instanceof Error ? error.name : "UnknownError"
            );
        }
    }
}

export function subscribeManualTranslateNextSend(listener: () => void): () => void {
    outgoingStateListeners.add(listener);
    return () => outgoingStateListeners.delete(listener);
}

export function isManualTranslateNextSendEnabled(): boolean {
    return manualTranslateNextSend;
}

export function setManualTranslateNextSend(enabled: boolean) {
    if (manualTranslateNextSend === enabled) return;
    manualTranslateNextSend = enabled;
    emitOutgoingStateChange();
}

export function toggleManualTranslateNextSend(): boolean {
    setManualTranslateNextSend(!manualTranslateNextSend);
    return manualTranslateNextSend;
}

export function consumeManualTranslateNextSend(): boolean {
    if (!manualTranslateNextSend) return false;

    setManualTranslateNextSend(false);
    return true;
}

function dispatchMessageContentUpdate(messageId: string, channelId: string, content: string): boolean {
    if (!runtimeActive) return false;

    try {
        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            message: {
                id: messageId,
                channel_id: channelId,
                channelId,
                guild_id: ChannelStore?.getChannel?.(channelId)?.guild_id,
                content,
                __chatTranslator: true,
            },
            log_edit: false,
            otherPluginBypass: true,
            __chatTranslator: true,
        });
        return true;
    } catch (error) {
        logger.error(
            "[ChatTranslator] Failed to update message content",
            error instanceof Error ? error.name : "UnknownError"
        );
        return false;
    }
}

function getCacheLimit(): number {
    const limit = Number(useChatTranslatorSettings.getState().translationCacheLimit);
    if (!Number.isFinite(limit)) return DEFAULT_CACHE_LIMIT;

    return Math.min(MAX_TRANSLATION_CACHE_LIMIT, Math.max(0, Math.floor(limit)));
}

function getCacheTtlDays(): number {
    const ttlDays = Number(useChatTranslatorSettings.getState().translationCacheTtlDays);
    if (!Number.isFinite(ttlDays)) return 30;

    return Math.max(0, ttlDays);
}

function isCacheEntryExpired(
    entry: TranslationCacheEntry,
    now = Date.now(),
    ttlDays = getCacheTtlDays()
): boolean {
    return ttlDays > 0 && now - entry.timestamp > ttlDays * DAY_MS;
}

function getCacheEntryUsedAt(entry: TranslationCacheEntry): number {
    return entry.lastUsedAt || entry.timestamp;
}

function reorderTranslationCacheByUsage() {
    const entries = [...translationCache.entries()]
        .sort(([, left], [, right]) => getCacheEntryUsedAt(left) - getCacheEntryUsedAt(right));

    translationCache.clear();
    for (const [key, entry] of entries) translationCache.set(key, entry);
}

function makeCacheStorageKey(
    networkSignature: string,
    cacheSignature: string,
    channelId: string,
    originalContent: string
): string {
    return `v3:${cyrb64Hash(JSON.stringify([
        networkSignature,
        cacheSignature,
        channelId,
        originalContent,
    ]))}`;
}

function makeCacheKeyParts(channelId: string, originalContent: string, sourceLang: string, targetLang: string) {
    const cacheSignature = getReceivedTranslationCacheSignatureFromValues(sourceLang, targetLang);
    const networkSignature = getReceivedTranslationNetworkSignatureFromValues(sourceLang, targetLang);
    const requestSignature = getReceivedTranslationRequestSignatureFromValues(sourceLang, targetLang);

    return {
        cacheKey: makeCacheStorageKey(
            networkSignature,
            cacheSignature,
            channelId,
            originalContent
        ),
        cacheSignature,
        networkSignature,
        requestSignature,
    };
}

function looksLikeFormattedTranslation(content: string, originalContent: string, translated: TranslationValue, targetLang: string): boolean {
    const normalizedContent = content.trim();
    const normalizedOriginal = originalContent.trim();
    const translatedText = translated.text.trim();
    if (!translatedText) return false;

    const source = translated.sourceLanguage || "Auto";
    const target = getLanguageDisplayName(targetLang);

    return normalizedContent === `${translatedText} \`(${source} → ${target})\``
        || normalizedContent === `${translatedText}\n-# Translated from ${source}`
        || normalizedContent === `${normalizedOriginal}\n> ${translatedText} \`(${source} → ${target})\``;
}

function getLiveMessage(channelId: string, messageId: string): DiscordMessage | null {
    const liveMessage = MessageStore?.getMessage?.(channelId, messageId);
    return liveMessage ?? null;
}

function safelyRestoreOriginalContent(messageId: string, record: TranslationRecord): boolean {
    const liveMessage = getLiveMessage(record.channelId, messageId);
    if (!liveMessage) return false;

    const liveContent = getMessageContent(liveMessage);
    if (liveContent === record.originalContent) return true;
    if (liveContent !== record.translatedContent) return false;

    return dispatchMessageContentUpdate(messageId, record.channelId, record.originalContent);
}

function deleteTranslatedMessageRecord(messageId: string): boolean {
    const deleted = translatedMessages.delete(messageId);
    if (deleted) emitTranslationStateChange();
    return deleted;
}

function pruneTranslatedMessageRecords() {
    if (translatedMessages.size < MAX_TRANSLATED_MESSAGE_RECORDS) return;

    let changed = false;
    for (const [messageId, record] of translatedMessages) {
        if (getLiveMessage(record.channelId, messageId)) continue;

        translatedMessages.delete(messageId);
        changed = true;
    }

    while (translatedMessages.size >= MAX_TRANSLATED_MESSAGE_RECORDS) {
        const oldest = translatedMessages.entries().next();
        if (oldest.done) break;

        safelyRestoreOriginalContent(oldest.value[0], oldest.value[1]);
        translatedMessages.delete(oldest.value[0]);
        changed = true;
    }

    if (changed) emitTranslationStateChange();
}

function setTranslatedMessageRecord(messageId: string, record: TranslationRecord) {
    if (translatedMessages.has(messageId)) translatedMessages.delete(messageId);
    else pruneTranslatedMessageRecords();

    translatedMessages.set(messageId, record);
    emitTranslationStateChange();
}

function hasExplicitContentPayload(message: DiscordMessage): boolean {
    return Object.prototype.hasOwnProperty.call(message, "content")
        || !!message.messageSnapshots?.length
        || !!message.embeds?.some(embed => embed.type === "auto_moderation_message" && typeof embed.rawDescription === "string");
}

function isExpectedLiveContentForPending(pending: PendingTranslation, liveContent: string): boolean {
    return liveContent === pending.originalContent
        || liveContent === pending.previousTranslatedContent;
}

function validatePendingTranslation(pending: PendingTranslation): string | null {
    if (!runtimeActive || pending.generation !== runtimeGeneration) {
        return "ChatTranslator stopped before translation finished.";
    }

    const currentPending = pendingTranslations.get(pending.messageId);
    if (
        !currentPending
        || currentPending.requestId !== pending.requestId
        || currentPending.requestSignature !== pending.requestSignature
        || currentPending.cacheSignature !== pending.cacheSignature
        || currentPending.originalContentHash !== pending.originalContentHash
        || currentPending.originalContent !== pending.originalContent
    ) {
        return "Skipped: a newer translation request replaced this one.";
    }

    const options = getReceivedTranslationOptionsForChannel(pending.channelId);
    const { cacheSignature, requestSignature } = makeCacheKeyParts(
        pending.channelId,
        pending.originalContent,
        options.sourceLang,
        options.targetLang
    );

    if (cacheSignature !== pending.cacheSignature || requestSignature !== pending.requestSignature) {
        return "Skipped: translation settings changed before this request finished.";
    }

    if (!pending.manual && !getReceivedAutoTranslateChannelState(pending.channelId)) {
        return "Skipped: auto translate was disabled before this request finished.";
    }

    const liveMessage = getLiveMessage(pending.channelId, pending.messageId);
    if (!liveMessage) return "Skipped: message is no longer available.";

    const liveContent = getMessageContent(liveMessage);
    if (!isExpectedLiveContentForPending(pending, liveContent)) {
        return "Skipped: message changed before translation finished.";
    }

    if (!pending.manual) {
        const skipReason = getAutomaticMessageSkipReason(liveMessage, pending.originalContent);
        if (skipReason) return skipReason.reason;
    }

    return null;
}

function clearPendingTranslationForMessage(messageId: string) {
    const pending = pendingTranslations.get(messageId);
    if (!pending) return;

    pendingTranslations.delete(messageId);
    const releaseRequest = pending.releaseRequest;
    pending.releaseRequest = undefined;
    releaseRequest?.();
    emitTranslationStateChange();
}

function clearPendingTranslationsForChannel(channelId: string) {
    batchTranslationStateChanges(() => {
        const messageIds: string[] = [];

        for (const [messageId, pending] of pendingTranslations) {
            if (pending.channelId === channelId) messageIds.push(messageId);
        }

        for (const messageId of messageIds) clearPendingTranslationForMessage(messageId);
    });
}

function clearPendingTranslationsForSignature(signature: string) {
    batchTranslationStateChanges(() => {
        const messageIds: string[] = [];

        for (const [messageId, pending] of pendingTranslations) {
            if (pending.cacheSignature === signature || pending.requestSignature === signature) {
                messageIds.push(messageId);
            }
        }

        for (const messageId of messageIds) clearPendingTranslationForMessage(messageId);
    });
}

function cancelAllPendingTranslations() {
    batchTranslationStateChanges(() => {
        for (const messageId of [...pendingTranslations.keys()]) {
            clearPendingTranslationForMessage(messageId);
        }
    });
}

function makeRoomForPendingTranslation(manual: boolean): boolean {
    while (pendingTranslations.size >= MAX_PENDING_TRANSLATIONS) {
        let candidate: string | undefined;

        for (const [messageId, pending] of pendingTranslations) {
            if (!pending.manual) {
                candidate = messageId;
                break;
            }
        }

        if (!candidate) {
            if (!manual) return false;
            candidate = pendingTranslations.keys().next().value;
        }
        if (!candidate) return false;

        clearPendingTranslationForMessage(candidate);
    }

    return true;
}

export function cancelInvalidPendingTranslations() {
    batchTranslationStateChanges(() => {
        for (const [messageId, pending] of [...pendingTranslations]) {
            if (validatePendingTranslation(pending)) clearPendingTranslationForMessage(messageId);
        }
    });
}

function loadPersistentCacheFromStore() {
    if (!useChatTranslatorCacheStore.getState()._hasHydrated) return;

    batchTranslationStateChanges(() => {
        const entries = useChatTranslatorCacheStore.getState().entries ?? {};
        let changed = false;

        for (const entry of Object.values(entries)) {
            if (
                typeof entry?.translated?.text !== "string"
                || !entry.translated.text.trim()
                || typeof entry.translated.sourceLanguage !== "string"
                || (
                    entry.translated.confidence !== undefined
                    && (
                        typeof entry.translated.confidence !== "number"
                        || !Number.isFinite(entry.translated.confidence)
                    )
                )
                || typeof entry.channelId !== "string"
                || !entry.channelId
                || typeof entry.cacheSignature !== "string"
                || typeof entry.originalContent !== "string"
                || typeof entry.networkSignature !== "string"
                || typeof entry.sourceLang !== "string"
                || typeof entry.targetLang !== "string"
            ) continue;

            const key = makeCacheStorageKey(
                entry.networkSignature,
                entry.cacheSignature,
                entry.channelId,
                entry.originalContent
            );
            const candidate: TranslationCacheEntry = {
                cacheSignature: entry.cacheSignature,
                channelId: entry.channelId,
                key,
                lastUsedAt: Number.isFinite(entry.lastUsedAt)
                    ? entry.lastUsedAt
                    : Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
                messageId: typeof entry.messageId === "string" ? entry.messageId : undefined,
                networkSignature: entry.networkSignature,
                originalContent: entry.originalContent,
                sourceLang: entry.sourceLang,
                targetLang: entry.targetLang,
                timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
                translated: entry.translated,
            };
            const current = translationCache.get(key);

            if (!current || getCacheEntryUsedAt(candidate) > getCacheEntryUsedAt(current)) {
                translationCache.set(key, candidate);
                changed = true;
            }
        }

        persistentCacheHydrated = true;
        reorderTranslationCacheByUsage();
        pruneTranslationCacheInternal();
        if (changed) emitTranslationCacheChange();
        scheduleTranslationCachePersist();
    });
}

function syncPersistentCacheFromStoreIfReady() {
    if (persistentCacheHydrated || !useChatTranslatorCacheStore.getState()._hasHydrated) return;
    loadPersistentCacheFromStore();
}

async function ensurePersistentCacheLoaded() {
    syncPersistentCacheFromStoreIfReady();
    if (persistentCacheHydrated || latePersistentCacheUnsubscribe) return;

    const generation = persistentCacheGeneration;
    persistentCacheHydrationPromise ??= waitForHydration(useChatTranslatorCacheStore).then(() => {
        if (generation !== persistentCacheGeneration) return;

        if (!useChatTranslatorCacheStore.getState()._hasHydrated) {
            let cleanup = () => undefined;
            const unsubscribe = useChatTranslatorCacheStore.subscribe(state => {
                if (!state._hasHydrated) return;

                clearLatePersistentCacheSubscription();
                if (generation !== persistentCacheGeneration) return;

                loadPersistentCacheFromStore();
                void persistTranslationCache();
            });
            const timeout = setTimeout(() => {
                if (latePersistentCacheUnsubscribe === cleanup) {
                    clearLatePersistentCacheSubscription();
                }
            }, ACTUAL_CACHE_HYDRATION_WAIT_MS);
            cleanup = () => {
                clearTimeout(timeout);
                try {
                    unsubscribe();
                } finally {
                    if (latePersistentCacheUnsubscribe === cleanup) {
                        latePersistentCacheUnsubscribe = null;
                    }
                }
            };
            latePersistentCacheUnsubscribe = cleanup;
            if (useChatTranslatorCacheStore.getState()._hasHydrated) {
                clearLatePersistentCacheSubscription();
                loadPersistentCacheFromStore();
                void persistTranslationCache();
            }
            return;
        }

        loadPersistentCacheFromStore();
        if (generation !== persistentCacheGeneration) return;

        void persistTranslationCache();
    }).catch(error => {
        logger.error(
            "[ChatTranslator] Failed to hydrate the translation cache",
            error instanceof Error ? error.name : "UnknownError"
        );
    }).finally(() => {
        persistentCacheHydrationPromise = null;
    });

    await persistentCacheHydrationPromise;
}

async function waitForActualPersistentCacheHydration(): Promise<boolean> {
    if (useChatTranslatorCacheStore.getState()._hasHydrated) {
        syncPersistentCacheFromStoreIfReady();
        return true;
    }

    if (!actualPersistentCacheHydrationWait) {
        let cleanup = () => undefined;
        let finish: (hydrated: boolean) => void = () => undefined;
        let settled = false;
        const promise = new Promise<boolean>(resolve => {
            finish = hydrated => {
                if (settled) return;
                settled = true;
                resolve(hydrated);
            };
        });
        const unsubscribe = useChatTranslatorCacheStore.subscribe(state => {
            if (!state._hasHydrated) return;

            cleanup();
            finish(true);
        });
        const timeout = setTimeout(() => {
            cleanup();
            finish(false);
        }, ACTUAL_CACHE_HYDRATION_WAIT_MS);
        cleanup = () => {
            clearTimeout(timeout);
            unsubscribe();
            if (actualPersistentCacheHydrationWait?.promise === promise) {
                actualPersistentCacheHydrationWait = null;
            }
        };

        actualPersistentCacheHydrationWait = {
            promise,
        };
    }

    const hydrated = await actualPersistentCacheHydrationWait.promise;
    if (hydrated) syncPersistentCacheFromStoreIfReady();
    return hydrated;
}

async function ensurePersistentCacheReadyForMutation(): Promise<boolean> {
    if (useChatTranslatorCacheStore.getState()._hasHydrated) {
        syncPersistentCacheFromStoreIfReady();
        return true;
    }

    if (hasPluginStoreHydrationFailed(CACHE_PLUGIN_NAME)) {
        try {
            await rehydratePluginStore(CACHE_PLUGIN_NAME);
        } catch {
            return false;
        }
    }

    return waitForActualPersistentCacheHydration();
}

async function recoverEmptyPersistentCache(): Promise<boolean> {
    try {
        await writeStorageFile(CACHE_STORAGE_PATH, JSON.stringify({
            state: {
                entries: {},
            },
            version: 0,
        }));
        await rehydratePluginStore(CACHE_PLUGIN_NAME);
        persistentCacheHydrated = true;
        return true;
    } catch (error) {
        logger.error(
            "[ChatTranslator] Failed to recover translation cache storage",
            error instanceof Error ? error.name : "UnknownError"
        );
        return false;
    }
}

async function persistTranslationCache(): Promise<boolean> {
    if (translationCachePersistTimer) {
        clearTimeout(translationCachePersistTimer);
        translationCachePersistTimer = null;
    }

    if (!useChatTranslatorCacheStore.getState()._hasHydrated) return false;

    try {
        const entries = Object.fromEntries(translationCache.entries());
        useChatTranslatorCacheStore.getState().updateSettings({ entries });
        await Promise.resolve();
        await waitForStorageWrites(CACHE_STORAGE_PATH);
        lastCacheHitPersistAt = Date.now();
        return true;
    } catch (error) {
        logger.error(
            "[ChatTranslator] Failed to persist translation cache",
            error instanceof Error ? error.name : "UnknownError"
        );
        return false;
    }
}

function scheduleTranslationCachePersist() {
    if (translationCachePersistTimer || !useChatTranslatorCacheStore.getState()._hasHydrated) return;

    translationCachePersistTimer = setTimeout(() => {
        translationCachePersistTimer = null;
        void persistTranslationCache();
    }, CACHE_PERSIST_DELAY_MS);
}

function pruneTranslationCacheInternal(removeExpired = true): boolean {
    syncPersistentCacheFromStoreIfReady();

    let changed = false;
    const now = Date.now();
    const limit = getCacheLimit();
    const ttlDays = getCacheTtlDays();

    if (removeExpired) {
        lastCacheExpiryPruneAt = now;
        for (const [key, entry] of translationCache) {
            if (isCacheEntryExpired(entry, now, ttlDays)) {
                translationCache.delete(key);
                changed = true;
            }
        }
    }

    while (translationCache.size > limit) {
        const oldestEntry = translationCache.entries().next();
        if (oldestEntry.done) break;

        const [key] = oldestEntry.value;
        translationCache.delete(key);
        changed = true;
    }

    if (changed) emitTranslationCacheChange();
    return changed;
}

export async function pruneTranslationCache(shouldPersist = true): Promise<boolean> {
    if (shouldPersist && !await ensurePersistentCacheReadyForMutation()) return false;

    const changed = batchTranslationStateChanges(() => pruneTranslationCacheInternal());
    return changed && shouldPersist ? persistTranslationCache() : true;
}

function getCachedTranslation(key: string): TranslationCacheEntry | undefined {
    const cached = translationCache.get(key);
    if (!cached) return undefined;

    if (isCacheEntryExpired(cached)) {
        translationCache.delete(key);
        emitTranslationCacheChange();
        scheduleTranslationCachePersist();
        return undefined;
    }

    const now = Date.now();
    cached.lastUsedAt = now;
    translationCache.delete(key);
    translationCache.set(key, cached);
    if (now - lastCacheHitPersistAt >= CACHE_HIT_PERSIST_INTERVAL_MS) {
        lastCacheHitPersistAt = now;
        scheduleTranslationCachePersist();
    }
    return cached;
}

function discardCachedTranslation(key: string) {
    if (!translationCache.delete(key)) return;

    emitTranslationCacheChange();
    scheduleTranslationCachePersist();
}

function cachedTranslationMatches(
    cached: TranslationCacheEntry,
    expected: {
        cacheSignature: string;
        channelId: string;
        networkSignature: string;
        originalContent: string;
        sourceLang: string;
        targetLang: string;
    }
): boolean {
    return cached.cacheSignature === expected.cacheSignature
        && cached.channelId === expected.channelId
        && cached.networkSignature === expected.networkSignature
        && cached.originalContent === expected.originalContent
        && cached.sourceLang === expected.sourceLang
        && cached.targetLang === expected.targetLang;
}

function setCachedTranslation(key: string, entry: TranslationCacheEntry) {
    if (getCacheLimit() <= 0) return;

    batchTranslationStateChanges(() => {
        translationCache.delete(key);
        translationCache.set(key, entry);
        pruneTranslationCacheInternal(
            Date.now() - lastCacheExpiryPruneAt >= CACHE_EXPIRY_PRUNE_INTERVAL_MS
        );
        emitTranslationCacheChange();
        scheduleTranslationCachePersist();
    });
}

export function getTranslationCacheStats(signature?: string): TranslationCacheStats {
    syncPersistentCacheFromStoreIfReady();
    if (!persistentCacheHydrated) void ensurePersistentCacheLoaded();

    const now = Date.now();
    const limit = getCacheLimit();
    const ttlDays = getCacheTtlDays();
    const minute = Math.floor(now / 60000);

    if (
        !cachedCacheStats
        || cachedCacheStats.minute !== minute
        || cachedCacheStats.revision !== translationCacheRevision
        || cachedCacheStats.signature !== signature
        || cachedCacheStats.stats.limit !== limit
        || cachedCacheStats.stats.ttlDays !== ttlDays
    ) {
        let expired = 0;
        let oldestUpdatedAt: number | undefined;
        let signatureCached = 0;

        for (const entry of translationCache.values()) {
            if (isCacheEntryExpired(entry, now, ttlDays)) expired++;
            if (entry.timestamp && (oldestUpdatedAt === undefined || entry.timestamp < oldestUpdatedAt)) {
                oldestUpdatedAt = entry.timestamp;
            }
            if (signature && (entry.cacheSignature === signature || entry.networkSignature === signature)) {
                signatureCached++;
            }
        }

        cachedCacheStats = {
            minute,
            revision: translationCacheRevision,
            signature,
            stats: {
                cached: translationCache.size,
                expired,
                limit,
                oldestUpdatedAt,
                signatureCached: signature ? signatureCached : undefined,
                ttlDays,
            },
        };
    }

    return {
        ...cachedCacheStats.stats,
        pending: pendingTranslations.size,
        translated: translatedMessages.size,
    };
}

export async function clearTranslationCache(): Promise<boolean> {
    const cacheReady = await ensurePersistentCacheReadyForMutation();
    if (!cacheReady) {
        if (!hasPluginStoreHydrationFailed(CACHE_PLUGIN_NAME)) return false;
        if (!await recoverEmptyPersistentCache()) return false;
    }

    batchTranslationStateChanges(() => {
        persistentCacheGeneration++;
        clearLatePersistentCacheSubscription();
        persistentCacheHydrated = true;
        persistentCacheHydrationPromise = null;
        translationCache.clear();
        cancelAllPendingTranslations();
        revertAllTranslatedMessages();
        emitTranslationCacheChange();
    });

    if (translationCachePersistTimer) {
        clearTimeout(translationCachePersistTimer);
        translationCachePersistTimer = null;
    }

    return cacheReady ? persistTranslationCache() : true;
}

export async function clearChannelTranslationCache(channelId: string): Promise<boolean> {
    if (!await ensurePersistentCacheReadyForMutation()) return false;

    batchTranslationStateChanges(() => {
        syncPersistentCacheFromStoreIfReady();
        let changed = false;

        for (const [key, entry] of translationCache) {
            if (entry.channelId === channelId) {
                translationCache.delete(key);
                changed = true;
            }
        }

        clearPendingTranslationsForChannel(channelId);
        revertTranslatedMessagesForChannel(channelId);
        if (changed) emitTranslationCacheChange();
    });

    return persistTranslationCache();
}

export async function clearTranslationCacheForSignature(signature: string): Promise<boolean> {
    if (!await ensurePersistentCacheReadyForMutation()) return false;

    batchTranslationStateChanges(() => {
        syncPersistentCacheFromStoreIfReady();
        let changed = false;

        for (const [key, entry] of translationCache) {
            if (entry.cacheSignature === signature || entry.networkSignature === signature) {
                translationCache.delete(key);
                changed = true;
            }
        }

        clearPendingTranslationsForSignature(signature);
        revertTranslatedMessagesForSignature(signature);
        if (changed) emitTranslationCacheChange();
    });

    return persistTranslationCache();
}

export function getTranslatedMessageView(messageId?: string | null): "original" | "translation" | null {
    if (!messageId) return null;
    return translatedMessages.get(messageId)?.view ?? null;
}

export function isTranslatedMessage(messageId?: string | null): boolean {
    return getTranslatedMessageView(messageId) === "translation";
}

export function clearTranslatedMessageStateIfSourceChanged(message: DiscordMessage): boolean {
    if (!message.id) return false;

    let changed = false;
    const nextContent = getMessageContent(message);
    const hasContentPayload = hasExplicitContentPayload(message);
    const pending = pendingTranslations.get(message.id);

    if (
        pending
        && hasContentPayload
        && nextContent !== pending.originalContent
        && nextContent !== pending.previousTranslatedContent
    ) {
        clearPendingTranslationForMessage(message.id);
        changed = true;
    }

    const record = translatedMessages.get(message.id);
    if (!record) return changed;

    if (!hasContentPayload && !nextContent) return changed;

    if (nextContent === record.originalContent || nextContent === record.translatedContent) {
        return changed;
    }

    deleteTranslatedMessageRecord(message.id);
    return true;
}

export function showOriginalMessage(messageId: string): TranslationOutcome {
    const record = translatedMessages.get(messageId);
    if (!record) return { ok: false, reason: "This message is not translated." };

    if (!safelyRestoreOriginalContent(messageId, record)) {
        deleteTranslatedMessageRecord(messageId);
        return { ok: false, reason: "The message changed or is no longer available." };
    }

    record.view = "original";
    translatedMessages.set(messageId, record);
    emitTranslationStateChange();
    return { ok: true };
}

function getNewerCacheEntry(
    current: TranslationCacheEntry | undefined,
    candidate: TranslationCacheEntry
): TranslationCacheEntry {
    return !current || getCacheEntryUsedAt(candidate) > getCacheEntryUsedAt(current)
        ? candidate
        : current;
}

function findCachedOriginalForMessage(messageId: string, channelId: string, currentContent: string): TranslationCacheEntry | undefined {
    let matchedByMessageId: TranslationCacheEntry | undefined;
    let matchedByContent: TranslationCacheEntry | undefined;
    let messageIdMatchIsAmbiguous = false;
    let contentMatchIsAmbiguous = false;

    for (const entry of translationCache.values()) {
        const translatedText = entry.translated.text.trim();

        if (
            entry.channelId !== channelId
            || !entry.originalContent
            || !translatedText
        ) continue;

        const matchesFormattedTranslation = looksLikeFormattedTranslation(
            currentContent,
            entry.originalContent,
            entry.translated,
            entry.targetLang
        );

        if (entry.messageId === messageId && matchesFormattedTranslation) {
            if (matchedByMessageId?.originalContent !== undefined
                && matchedByMessageId.originalContent !== entry.originalContent) {
                messageIdMatchIsAmbiguous = true;
            }
            matchedByMessageId = getNewerCacheEntry(matchedByMessageId, entry);
            continue;
        }

        if (!entry.messageId && matchesFormattedTranslation) {
            if (matchedByContent?.originalContent !== undefined
                && matchedByContent.originalContent !== entry.originalContent) {
                contentMatchIsAmbiguous = true;
            }
            matchedByContent = getNewerCacheEntry(matchedByContent, entry);
        }
    }

    if (matchedByMessageId) return messageIdMatchIsAmbiguous ? undefined : matchedByMessageId;
    return contentMatchIsAmbiguous ? undefined : matchedByContent;
}

export function restoreMessageOriginalFromCache(message: DiscordMessage): TranslationOutcome {
    const messageId = message.id;
    const channelId = getMessageChannelId(message);
    if (!messageId || !channelId) return { ok: false, reason: "Missing message metadata." };

    const record = translatedMessages.get(messageId);
    if (record) return showOriginalMessage(messageId);

    const liveMessage = getLiveMessage(channelId, messageId);
    const currentContent = liveMessage ? getMessageContent(liveMessage) : "";
    if (!currentContent) return { ok: false, reason: "The message changed or is no longer available." };

    syncPersistentCacheFromStoreIfReady();

    const cached = findCachedOriginalForMessage(messageId, channelId, currentContent);

    if (!cached?.originalContent) return { ok: false, reason: "Original message is not available." };
    if (!dispatchMessageContentUpdate(messageId, channelId, cached.originalContent)) {
        return { ok: false, reason: "Failed to restore the original message." };
    }

    setTranslatedMessageRecord(messageId, {
        cacheKey: cached.key,
        cacheSignature: cached.cacheSignature,
        channelId,
        manual: true,
        originalContentHash: cyrb64Hash(cached.originalContent),
        originalContent: cached.originalContent,
        requestSignature: getReceivedTranslationRequestSignatureFromValues(cached.sourceLang, cached.targetLang),
        sourceLanguage: cached.translated.sourceLanguage,
        targetLanguage: cached.targetLang,
        timestamp: Date.now(),
        translated: cached.translated,
        translatedContent: currentContent,
        view: "original",
    });

    return { ok: true };
}

export function showTranslatedMessage(messageId: string): TranslationOutcome {
    const record = translatedMessages.get(messageId);
    if (!record) return { ok: false, reason: "This message is not translated." };

    const liveMessage = getLiveMessage(record.channelId, messageId);
    const liveContent = liveMessage ? getMessageContent(liveMessage) : "";
    if (!liveMessage || (liveContent !== record.originalContent && liveContent !== record.translatedContent)) {
        deleteTranslatedMessageRecord(messageId);
        return { ok: false, reason: "The message changed or is no longer available." };
    }

    if (!dispatchMessageContentUpdate(messageId, record.channelId, record.translatedContent)) {
        return { ok: false, reason: "Failed to show the translated message." };
    }

    record.view = "translation";
    translatedMessages.set(messageId, record);
    emitTranslationStateChange();
    return { ok: true };
}

export function toggleTranslatedMessageView(messageId: string): TranslationOutcome {
    const record = translatedMessages.get(messageId);
    if (!record) return { ok: false, reason: "This message is not translated." };

    return record.view === "translation"
        ? showOriginalMessage(messageId)
        : showTranslatedMessage(messageId);
}

export function revertTranslatedMessage(messageId: string): TranslationOutcome {
    const result = showOriginalMessage(messageId);
    if (result.ok) deleteTranslatedMessageRecord(messageId);
    return result;
}

export function revertAllTranslatedMessages() {
    batchTranslationStateChanges(() => {
        for (const [messageId, record] of translatedMessages) {
            safelyRestoreOriginalContent(messageId, record);
        }

        const changed = translatedMessages.size > 0;
        translatedMessages.clear();
        if (changed) emitTranslationStateChange();
    });
}

export function revertTranslatedMessagesForChannel(channelId: string) {
    batchTranslationStateChanges(() => {
        for (const [messageId, record] of translatedMessages) {
            if (record.channelId !== channelId) continue;

            safelyRestoreOriginalContent(messageId, record);
            translatedMessages.delete(messageId);
            emitTranslationStateChange();
        }
    });
}

export function revertTranslatedMessagesForSignature(signature: string) {
    batchTranslationStateChanges(() => {
        for (const [messageId, record] of translatedMessages) {
            if (record.cacheSignature !== signature && record.requestSignature !== signature) continue;

            safelyRestoreOriginalContent(messageId, record);
            translatedMessages.delete(messageId);
            emitTranslationStateChange();
        }
    });
}

export function revertTranslatedMessagesWithDisabledAutoTranslate() {
    batchTranslationStateChanges(() => {
        const state = useChatTranslatorSettings.getState();

        for (const [messageId, pending] of pendingTranslations) {
            const enabled = pending.channelId
                ? state.receivedChannelOverrides[pending.channelId] ?? state.autoTranslateReceived
                : state.autoTranslateReceived;

            if (!pending.manual && !enabled) clearPendingTranslationForMessage(messageId);
        }

        for (const [messageId, record] of translatedMessages) {
            const enabled = record.channelId
                ? state.receivedChannelOverrides[record.channelId] ?? state.autoTranslateReceived
                : state.autoTranslateReceived;

            if (enabled || record.manual) continue;

            safelyRestoreOriginalContent(messageId, record);
            deleteTranslatedMessageRecord(messageId);
            clearPendingTranslationForMessage(messageId);
        }
    });
}

function formatReceivedTranslation(originalContent: string, translated: TranslationValue, targetLang: string): string {
    const state = useChatTranslatorSettings.getState();
    const translatedText = translated.text.trim();
    const source = translated.sourceLanguage || "Auto";
    const target = getLanguageDisplayName(targetLang);

    switch (state.receivedDisplayMode) {
        case "translated":
        case "toggle":
            return `${translatedText} \`(${source} → ${target})\``;
        case "compact":
            return `${translatedText}\n-# Translated from ${source}`;
        default:
            return `${originalContent}\n> ${translatedText} \`(${source} → ${target})\``;
    }
}

export function discardMessageTranslationState(messageId: string) {
    discardMessageTranslationStates([messageId]);
}

export function discardMessageTranslationStates(messageIds: Iterable<string>) {
    batchTranslationStateChanges(() => {
        for (const messageId of messageIds) {
            clearPendingTranslationForMessage(messageId);
            deleteTranslatedMessageRecord(messageId);
        }
    });
}

export function refreshTranslatedMessageFormatting() {
    batchTranslationStateChanges(() => {
        for (const [messageId, record] of translatedMessages) {
            const liveMessage = getLiveMessage(record.channelId, messageId);
            if (!liveMessage) {
                deleteTranslatedMessageRecord(messageId);
                continue;
            }

            const liveContent = getMessageContent(liveMessage);
            if (liveContent !== record.originalContent && liveContent !== record.translatedContent) {
                deleteTranslatedMessageRecord(messageId);
                continue;
            }

            const translatedContent = formatReceivedTranslation(
                record.originalContent,
                record.translated,
                record.targetLanguage
            );
            if (translatedContent === record.translatedContent) continue;

            if (
                record.view === "translation"
                && !dispatchMessageContentUpdate(messageId, record.channelId, translatedContent)
            ) continue;

            record.translatedContent = translatedContent;
            translatedMessages.set(messageId, record);
            emitTranslationStateChange();
        }
    });
}

export function reconcileTranslatedMessagesWithCurrentSettings() {
    batchTranslationStateChanges(() => {
        cancelInvalidPendingTranslations();

        for (const [messageId, record] of translatedMessages) {
            if (record.manual) continue;

            const liveMessage = getLiveMessage(record.channelId, messageId);
            if (!liveMessage) {
                deleteTranslatedMessageRecord(messageId);
                continue;
            }

            const options = getReceivedTranslationOptionsForChannel(record.channelId);
            const { cacheSignature, requestSignature } = makeCacheKeyParts(
                record.channelId,
                record.originalContent,
                options.sourceLang,
                options.targetLang
            );
            const shouldRevert = !getReceivedAutoTranslateChannelState(record.channelId)
                || cacheSignature !== record.cacheSignature
                || requestSignature !== record.requestSignature
                || !!getAutomaticMessageSkipReason(liveMessage, record.originalContent);

            if (!shouldRevert) continue;

            safelyRestoreOriginalContent(messageId, record);
            deleteTranslatedMessageRecord(messageId);
        }
    });
}

export async function replaceMessageWithCachedTranslation(message: DiscordMessage): Promise<TranslationOutcome> {
    if (!runtimeActive) return { ok: false, reason: "ChatTranslator is not running." };

    const generation = runtimeGeneration;
    const messageId = message.id;
    const channelId = getMessageChannelId(message);
    if (!messageId || !channelId) return { ok: false, reason: "Missing message metadata." };

    const existingRecord = translatedMessages.get(messageId);
    const initialLiveMessage = getLiveMessage(channelId, messageId);
    const liveContent = initialLiveMessage ? getMessageContent(initialLiveMessage) : "";
    const messageContent = getMessageContent(message);
    const hasLiveSourceChanged = !!(
        existingRecord
        && initialLiveMessage
        && liveContent !== existingRecord.originalContent
        && liveContent !== existingRecord.translatedContent
    );
    const originalContent = existingRecord && !hasLiveSourceChanged
        ? existingRecord.originalContent
        : initialLiveMessage ? liveContent : messageContent;
    if (!originalContent) return { ok: false, reason: "Skipped: empty message" };

    if (hasLiveSourceChanged) {
        deleteTranslatedMessageRecord(messageId);
    }

    const skipReason = getAutomaticMessageSkipReason(message, originalContent);
    if (skipReason) return { ok: false, reason: skipReason.reason };

    switchDeepLToGoogleIfApiKeyMissing();

    const options = getReceivedTranslationOptionsForChannel(channelId);
    const { cacheKey, cacheSignature, networkSignature, requestSignature } = makeCacheKeyParts(
        channelId,
        originalContent,
        options.sourceLang,
        options.targetLang
    );
    const originalContentHash = cyrb64Hash(originalContent);

    if (
        existingRecord
        && existingRecord.originalContentHash === originalContentHash
        && existingRecord.originalContent === originalContent
        && existingRecord.cacheSignature === cacheSignature
        && existingRecord.requestSignature === requestSignature
        && (!liveContent || liveContent === existingRecord.translatedContent)
    ) {
        return { ok: true };
    }

    await ensurePersistentCacheLoaded();

    if (!runtimeActive || generation !== runtimeGeneration) {
        return { ok: false, reason: "ChatTranslator stopped before cached translation loaded." };
    }

    if (!getReceivedAutoTranslateChannelState(channelId)) {
        return { ok: false, reason: "Skipped: auto translate was disabled before cached translation loaded." };
    }

    const liveMessage = getLiveMessage(channelId, messageId);
    if (!liveMessage) return { ok: false, reason: RETRY_CACHED_TRANSLATION_REASON };

    const currentLiveContent = getMessageContent(liveMessage);
    if (currentLiveContent && currentLiveContent !== originalContent && currentLiveContent !== existingRecord?.translatedContent) {
        return { ok: false, reason: "Skipped: message changed before cached translation loaded." };
    }
    const currentSkipReason = getAutomaticMessageSkipReason(liveMessage, originalContent);
    if (currentSkipReason) return { ok: false, reason: currentSkipReason.reason };

    const currentOptions = getReceivedTranslationOptionsForChannel(channelId);
    const currentKeyParts = makeCacheKeyParts(
        channelId,
        originalContent,
        currentOptions.sourceLang,
        currentOptions.targetLang
    );
    if (
        currentKeyParts.cacheSignature !== cacheSignature
        || currentKeyParts.requestSignature !== requestSignature
    ) {
        return { ok: false, reason: "Skipped: translation settings changed before cached translation loaded." };
    }

    const cached = getCachedTranslation(cacheKey);
    if (!cached) return { ok: false, reason: NO_CACHED_TRANSLATION_REASON };
    if (!cachedTranslationMatches(cached, {
        cacheSignature,
        channelId,
        networkSignature,
        originalContent,
        sourceLang: currentOptions.sourceLang,
        targetLang: currentOptions.targetLang,
    })) {
        discardCachedTranslation(cacheKey);
        return { ok: false, reason: NO_CACHED_TRANSLATION_REASON };
    }
    const confidenceSkipReason = getGoogleConfidenceSkipReason(cached.translated);
    if (confidenceSkipReason) return { ok: false, reason: confidenceSkipReason };

    const translatedContent = formatReceivedTranslation(originalContent, cached.translated, currentOptions.targetLang);
    const currentPending = pendingTranslations.get(messageId);

    if (
        currentPending
        && currentPending.channelId === channelId
        && currentPending.originalContentHash === originalContentHash
        && currentPending.originalContent === originalContent
        && currentPending.cacheSignature === cacheSignature
        && currentPending.requestSignature === requestSignature
    ) {
        clearPendingTranslationForMessage(messageId);
    }

    if (!dispatchMessageContentUpdate(messageId, channelId, translatedContent)) {
        return { ok: false, reason: "Failed to show the cached translation." };
    }

    setTranslatedMessageRecord(messageId, {
        cacheKey,
        cacheSignature,
        channelId,
        manual: false,
        originalContentHash,
        originalContent,
        requestSignature,
        translatedContent,
        sourceLanguage: cached.translated.sourceLanguage,
        targetLanguage: currentOptions.targetLang,
        timestamp: Date.now(),
        translated: cached.translated,
        view: "translation",
    });
    return { ok: true, translated: cached.translated };
}

export async function translateAndReplaceMessage(
    message: DiscordMessage,
    { manual = false, ignoreConfidenceRequirement = manual }: { manual?: boolean; ignoreConfidenceRequirement?: boolean } = {}
): Promise<TranslationOutcome> {
    if (!runtimeActive) return { ok: false, reason: "ChatTranslator is not running." };

    const generation = runtimeGeneration;
    const messageId = message.id;
    const channelId = getMessageChannelId(message);
    if (!messageId || !channelId) return { ok: false, reason: "Missing message metadata." };

    const existingRecord = translatedMessages.get(messageId);
    const liveMessage = getLiveMessage(channelId, messageId);
    const liveContent = liveMessage ? getMessageContent(liveMessage) : "";
    const messageContent = getMessageContent(message);
    const hasLiveSourceChanged = !!(
        existingRecord
        && liveMessage
        && liveContent !== existingRecord.originalContent
        && liveContent !== existingRecord.translatedContent
    );
    const originalContent = existingRecord && !hasLiveSourceChanged
        ? existingRecord.originalContent
        : liveMessage ? liveContent : messageContent;
    if (!originalContent) return { ok: false, reason: "Skipped: empty message" };

    if (hasLiveSourceChanged) {
        deleteTranslatedMessageRecord(messageId);
    }

    const sourceMessage = liveMessage
        ? { ...liveMessage, ...message, channel_id: channelId }
        : message;
    const skipReason = manual
        ? getManualTranslationBlockReason(originalContent)
        : getAutomaticMessageSkipReason(sourceMessage, originalContent);

    if (skipReason) return { ok: false, reason: skipReason.reason };

    switchDeepLToGoogleIfApiKeyMissing();

    const options = getReceivedTranslationOptionsForChannel(channelId);
    const { cacheKey, cacheSignature, networkSignature, requestSignature } = makeCacheKeyParts(
        channelId,
        originalContent,
        options.sourceLang,
        options.targetLang
    );
    const originalContentHash = cyrb64Hash(originalContent);
    const previousTranslatedContent = existingRecord?.translatedContent;
    const currentPending = pendingTranslations.get(messageId);

    if (
        currentPending
        && currentPending.channelId === channelId
        && currentPending.originalContentHash === originalContentHash
        && currentPending.originalContent === originalContent
        && currentPending.cacheSignature === cacheSignature
        && currentPending.requestSignature === requestSignature
    ) {
        const shouldReplaceWithManualRequest = manual && (
            !currentPending.manual
            || currentPending.ignoreConfidenceRequirement !== ignoreConfidenceRequirement
        );
        if (!shouldReplaceWithManualRequest) {
            return { ok: false, reason: "Skipped: translation is already pending." };
        }

        clearPendingTranslationForMessage(messageId);
    }

    if (pendingTranslations.has(messageId)) clearPendingTranslationForMessage(messageId);

    if (
        !manual
        && existingRecord
        && existingRecord.originalContentHash === originalContentHash
        && existingRecord.originalContent === originalContent
        && existingRecord.cacheSignature === cacheSignature
        && existingRecord.requestSignature === requestSignature
        && (!liveContent || liveContent === existingRecord.translatedContent)
    ) {
        return { ok: true };
    }

    const pending = batchTranslationStateChanges<PendingTranslation | null>(() => {
        if (!makeRoomForPendingTranslation(manual)) return null;

        const nextPending: PendingTranslation = {
            cacheKey,
            cacheSignature,
            channelId,
            generation,
            ignoreConfidenceRequirement,
            manual,
            messageId,
            originalContent,
            originalContentHash,
            previousTranslatedContent,
            requestId: ++nextRequestId,
            requestSignature,
            startedAt: Date.now(),
        };
        pendingTranslations.set(messageId, nextPending);
        emitTranslationStateChange();
        return nextPending;
    });
    if (!pending) return { ok: false, reason: "Skipped: translation queue is busy." };

    try {
        await ensurePersistentCacheLoaded();

        const staleAfterHydration = validatePendingTranslation(pending);
        if (staleAfterHydration) return { ok: false, reason: staleAfterHydration };

        let cached = getCachedTranslation(cacheKey);
        if (cached && !cachedTranslationMatches(cached, {
            cacheSignature,
            channelId,
            networkSignature,
            originalContent,
            sourceLang: options.sourceLang,
            targetLang: options.targetLang,
        })) {
            discardCachedTranslation(cacheKey);
            cached = undefined;
        }
        let translated: TranslationValue;
        if (cached) {
            translated = cached.translated;
        } else {
            const request = translationRequestCoordinator.acquire(
                makeTranslationRequestKey(
                    "received",
                    networkSignature,
                    originalContent
                ),
                signal => trackTranslationExecution(reportRequestCompletion => (
                    translate("received", originalContent, {
                        ...options,
                        ignoreConfidenceRequirement,
                        reportRequestCompletion,
                        signal,
                    })
                )),
                manual ? "interactive" : "background"
            );
            pending.releaseRequest = request.release;
            translated = await request.promise;
        }

        const staleBeforeApply = validatePendingTranslation(pending);
        if (staleBeforeApply) return { ok: false, reason: staleBeforeApply };

        const confidenceSkipReason = getGoogleConfidenceSkipReason(translated, ignoreConfidenceRequirement);
        if (confidenceSkipReason) return { ok: false, reason: confidenceSkipReason };

        if (!cached) {
            const timestamp = Date.now();

            setCachedTranslation(cacheKey, {
                cacheSignature,
                channelId,
                key: cacheKey,
                lastUsedAt: timestamp,
                messageId,
                networkSignature,
                originalContent,
                sourceLang: options.sourceLang,
                targetLang: options.targetLang,
                timestamp,
                translated,
            });
        }

        const translatedContent = formatReceivedTranslation(originalContent, translated, options.targetLang);
        if (!dispatchMessageContentUpdate(messageId, channelId, translatedContent)) {
            return { ok: false, reason: "Failed to show the translated message." };
        }

        setTranslatedMessageRecord(messageId, {
            cacheKey,
            cacheSignature,
            channelId,
            manual,
            originalContentHash,
            originalContent,
            requestSignature,
            translatedContent,
            sourceLanguage: translated.sourceLanguage,
            targetLanguage: options.targetLang,
            timestamp: Date.now(),
            translated,
            view: "translation",
        });
        return { ok: true, translated };
    } catch (error) {
        if (isTranslationAbortError(error)) {
            return { ok: false, reason: "Skipped: translation request was cancelled." };
        }
        return { ok: false, reason: normalizeTranslationFailureReason(error) };
    } finally {
        const releaseRequest = pending.releaseRequest;
        pending.releaseRequest = undefined;
        releaseRequest?.();
        if (pendingTranslations.get(messageId)?.requestId === pending.requestId) {
            pendingTranslations.delete(messageId);
            emitTranslationStateChange();
        }
    }
}
