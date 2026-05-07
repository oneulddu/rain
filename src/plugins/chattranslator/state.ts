import { waitForHydration } from "@api/storage";
import { cyrb64Hash } from "@lib/utils/cyrb64";
import { FluxDispatcher } from "@metro/common";
import { findByStoreName } from "@metro/wrappers";

import { getLanguageDisplayName } from "./lang";
import {
    useChatTranslatorCacheStore,
    useChatTranslatorSettings,
} from "./storage";
import {
    DiscordMessage,
    getAutomaticMessageSkipReason,
    getManualTranslationBlockReason,
    getMessageChannelId,
    getMessageContent,
    getReceivedAutoTranslateChannelState,
    getReceivedTranslationCacheSignatureFromValues,
    getReceivedTranslationOptionsForChannel,
    getReceivedTranslationRequestSignatureFromValues,
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
    translatedContent: string;
    view: "original" | "translation";
}

interface TranslationCacheEntry {
    cacheSignature: string;
    channelId: string;
    key: string;
    lastUsedAt: number;
    messageId?: string;
    originalContent?: string;
    requestSignature: string;
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
    manual: boolean;
    messageId: string;
    originalContent: string;
    originalContentHash: string;
    previousTranslatedContent?: string;
    requestId: number;
    requestSignature: string;
    startedAt: number;
}

const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const translatedMessages = new Map<string, TranslationRecord>();
const translationCache = new Map<string, TranslationCacheEntry>();
const pendingTranslations = new Map<string, PendingTranslation>();
const outgoingStateListeners = new Set<() => void>();
const DEFAULT_CACHE_LIMIT = 1500;
const CACHE_HIT_PERSIST_DELAY_MS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;
let runtimeActive = false;
let runtimeGeneration = 0;
let manualTranslateNextSend = false;
let persistentCacheHydrated = false;
let persistentCacheHydrationPromise: Promise<void> | null = null;
let persistentCacheGeneration = 0;
let translationCachePersistTimer: ReturnType<typeof setTimeout> | null = null;
let nextRequestId = 0;

export function setChatTranslatorRuntimeActive(active: boolean) {
    runtimeActive = active;
    runtimeGeneration++;

    if (!active) {
        pendingTranslations.clear();
        setManualTranslateNextSend(false);
    }
}

function emitOutgoingStateChange() {
    for (const listener of outgoingStateListeners) listener();
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

function dispatchMessageContentUpdate(messageId: string, channelId: string, content: string) {
    if (!runtimeActive) return;

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
}

function getCacheLimit(): number {
    const limit = Number(useChatTranslatorSettings.getState().translationCacheLimit);
    if (!Number.isFinite(limit)) return DEFAULT_CACHE_LIMIT;

    return Math.max(0, Math.floor(limit));
}

function getCacheTtlDays(): number {
    const ttlDays = Number(useChatTranslatorSettings.getState().translationCacheTtlDays);
    if (!Number.isFinite(ttlDays)) return 30;

    return Math.max(0, ttlDays);
}

function isCacheEntryExpired(entry: TranslationCacheEntry, now = Date.now()): boolean {
    const ttlDays = getCacheTtlDays();
    return ttlDays > 0 && now - entry.timestamp > ttlDays * DAY_MS;
}

function getCacheEntryUsedAt(entry: TranslationCacheEntry): number {
    return entry.lastUsedAt || entry.timestamp;
}

function makeCacheKeyParts(channelId: string, originalContent: string, sourceLang: string, targetLang: string) {
    const cacheSignature = getReceivedTranslationCacheSignatureFromValues(sourceLang, targetLang);
    const requestSignature = getReceivedTranslationRequestSignatureFromValues(sourceLang, targetLang);

    return {
        cacheKey: [
            requestSignature,
            cacheSignature,
            channelId,
            cyrb64Hash(originalContent),
        ].join(":"),
        cacheSignature,
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

function getLiveMessageContent(channelId: string, messageId: string): string {
    const liveMessage = getLiveMessage(channelId, messageId);
    return liveMessage ? getMessageContent(liveMessage) : "";
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

    return null;
}

function clearPendingTranslationForMessage(messageId: string) {
    pendingTranslations.delete(messageId);
}

function clearPendingTranslationsForChannel(channelId: string) {
    for (const [messageId, pending] of pendingTranslations) {
        if (pending.channelId === channelId) pendingTranslations.delete(messageId);
    }
}

function clearPendingTranslationsForSignature(signature: string) {
    for (const [messageId, pending] of pendingTranslations) {
        if (pending.cacheSignature === signature || pending.requestSignature === signature) {
            pendingTranslations.delete(messageId);
        }
    }
}

function loadPersistentCacheFromStore() {
    const entries = useChatTranslatorCacheStore.getState().entries ?? {};

    for (const [key, entry] of Object.entries(entries)) {
        if (!entry?.translated?.text || !entry.channelId) continue;

        translationCache.set(key, {
            cacheSignature: entry.cacheSignature,
            channelId: entry.channelId,
            key,
            lastUsedAt: entry.lastUsedAt || entry.timestamp || Date.now(),
            messageId: entry.messageId,
            originalContent: entry.originalContent,
            requestSignature: entry.requestSignature,
            sourceLang: entry.sourceLang,
            targetLang: entry.targetLang,
            timestamp: entry.timestamp || Date.now(),
            translated: entry.translated,
        });
    }

    persistentCacheHydrated = true;
    pruneTranslationCache(false);
}

function syncPersistentCacheFromStoreIfReady() {
    if (persistentCacheHydrated || !useChatTranslatorCacheStore.getState()._hasHydrated) return;
    loadPersistentCacheFromStore();
}

async function ensurePersistentCacheLoaded() {
    syncPersistentCacheFromStoreIfReady();
    if (persistentCacheHydrated) return;

    const generation = persistentCacheGeneration;
    persistentCacheHydrationPromise ??= waitForHydration(useChatTranslatorCacheStore).then(() => {
        if (generation !== persistentCacheGeneration) return;

        loadPersistentCacheFromStore();
        if (generation !== persistentCacheGeneration) return;

        persistTranslationCache();
    }).finally(() => {
        persistentCacheHydrationPromise = null;
    });

    await persistentCacheHydrationPromise;
}

function persistTranslationCache() {
    if (translationCachePersistTimer) {
        clearTimeout(translationCachePersistTimer);
        translationCachePersistTimer = null;
    }

    if (!useChatTranslatorCacheStore.getState()._hasHydrated) return;

    const entries = Object.fromEntries(
        [...translationCache.entries()].map(([key, entry]) => [key, { ...entry, key }])
    );

    useChatTranslatorCacheStore.getState().updateSettings({ entries });
}

function scheduleTranslationCachePersist() {
    if (translationCachePersistTimer || !useChatTranslatorCacheStore.getState()._hasHydrated) return;

    translationCachePersistTimer = setTimeout(() => {
        translationCachePersistTimer = null;
        persistTranslationCache();
    }, CACHE_HIT_PERSIST_DELAY_MS);
}

function getOldestCacheKey(): string | undefined {
    let oldestKey: string | undefined;
    let oldestUsedAt = Infinity;

    for (const [key, entry] of translationCache) {
        const usedAt = getCacheEntryUsedAt(entry);

        if (usedAt < oldestUsedAt) {
            oldestKey = key;
            oldestUsedAt = usedAt;
        }
    }

    return oldestKey;
}

export function pruneTranslationCache(shouldPersist = true) {
    syncPersistentCacheFromStoreIfReady();

    let changed = false;
    const removedKeys = new Set<string>();
    const now = Date.now();
    const limit = getCacheLimit();

    for (const [key, entry] of translationCache) {
        if (isCacheEntryExpired(entry, now)) {
            translationCache.delete(key);
            removedKeys.add(key);
            changed = true;
        }
    }

    while (translationCache.size > limit) {
        const oldestKey = getOldestCacheKey();
        if (!oldestKey) break;

        translationCache.delete(oldestKey);
        removedKeys.add(oldestKey);
        changed = true;
    }

    if (removedKeys.size) revertTranslatedMessagesForCacheKeys(removedKeys);
    if (changed && shouldPersist) persistTranslationCache();
}

function getCachedTranslation(key: string): TranslationCacheEntry | undefined {
    const cached = translationCache.get(key);
    if (!cached) return undefined;

    if (isCacheEntryExpired(cached)) {
        translationCache.delete(key);
        persistTranslationCache();
        return undefined;
    }

    cached.lastUsedAt = Date.now();
    translationCache.set(key, cached);
    scheduleTranslationCachePersist();
    return cached;
}

function setCachedTranslation(key: string, entry: TranslationCacheEntry) {
    if (getCacheLimit() <= 0) return;

    translationCache.set(key, entry);
    pruneTranslationCache(false);
    persistTranslationCache();
}

export function getTranslationCacheStats(signature?: string): TranslationCacheStats {
    syncPersistentCacheFromStoreIfReady();

    const now = Date.now();
    let expired = 0;
    let oldestUpdatedAt: number | undefined;
    let signatureCached = 0;

    for (const entry of translationCache.values()) {
        if (isCacheEntryExpired(entry, now)) expired++;
        if (entry.timestamp && (oldestUpdatedAt === undefined || entry.timestamp < oldestUpdatedAt)) {
            oldestUpdatedAt = entry.timestamp;
        }
        if (signature && (entry.cacheSignature === signature || entry.requestSignature === signature)) {
            signatureCached++;
        }
    }

    return {
        cached: translationCache.size,
        expired,
        limit: getCacheLimit(),
        oldestUpdatedAt,
        pending: pendingTranslations.size,
        signatureCached: signature ? signatureCached : undefined,
        translated: translatedMessages.size,
        ttlDays: getCacheTtlDays(),
    };
}

export function clearTranslationCache() {
    persistentCacheGeneration++;
    persistentCacheHydrated = true;
    persistentCacheHydrationPromise = null;
    translationCache.clear();
    pendingTranslations.clear();
    revertAllTranslatedMessages();

    const clearPersistedCache = () => useChatTranslatorCacheStore.getState().updateSettings({ entries: {} });

    if (useChatTranslatorCacheStore.getState()._hasHydrated) {
        clearPersistedCache();
    } else {
        void waitForHydration(useChatTranslatorCacheStore).then(clearPersistedCache);
    }
}

export function clearChannelTranslationCache(channelId: string) {
    const clearChannel = () => {
        syncPersistentCacheFromStoreIfReady();

        for (const [key, entry] of translationCache) {
            if (entry.channelId === channelId) translationCache.delete(key);
        }

        clearPendingTranslationsForChannel(channelId);
        revertTranslatedMessagesForChannel(channelId);
        persistTranslationCache();
    };

    if (!persistentCacheHydrated && !useChatTranslatorCacheStore.getState()._hasHydrated) {
        void ensurePersistentCacheLoaded().then(clearChannel);
        return;
    }

    clearChannel();
}

export function clearTranslationCacheForSignature(signature: string) {
    const clearSignature = () => {
        syncPersistentCacheFromStoreIfReady();

        for (const [key, entry] of translationCache) {
            if (entry.cacheSignature === signature || entry.requestSignature === signature) {
                translationCache.delete(key);
            }
        }

        clearPendingTranslationsForSignature(signature);
        revertTranslatedMessagesForSignature(signature);
        persistTranslationCache();
    };

    if (!persistentCacheHydrated && !useChatTranslatorCacheStore.getState()._hasHydrated) {
        void ensurePersistentCacheLoaded().then(clearSignature);
        return;
    }

    clearSignature();
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

    translatedMessages.delete(message.id);
    return true;
}

export function showOriginalMessage(messageId: string): TranslationOutcome {
    const record = translatedMessages.get(messageId);
    if (!record) return { ok: false, reason: "This message is not translated." };

    dispatchMessageContentUpdate(messageId, record.channelId, record.originalContent);
    record.view = "original";
    translatedMessages.set(messageId, record);
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
            matchedByMessageId = getNewerCacheEntry(matchedByMessageId, entry);
            continue;
        }

        if (!entry.messageId && matchesFormattedTranslation) {
            matchedByContent = getNewerCacheEntry(matchedByContent, entry);
        }
    }

    return matchedByMessageId ?? matchedByContent;
}

export function restoreMessageOriginalFromCache(message: DiscordMessage): TranslationOutcome {
    const messageId = message.id;
    const channelId = getMessageChannelId(message);
    const currentContent = getMessageContent(message);
    if (!messageId || !channelId || !currentContent) return { ok: false, reason: "Missing message metadata." };

    const record = translatedMessages.get(messageId);
    if (record) return showOriginalMessage(messageId);

    syncPersistentCacheFromStoreIfReady();

    const cached = findCachedOriginalForMessage(messageId, channelId, currentContent);

    if (!cached?.originalContent) return { ok: false, reason: "Original message is not available." };

    dispatchMessageContentUpdate(messageId, channelId, cached.originalContent);
    translatedMessages.set(messageId, {
        cacheKey: cached.key,
        cacheSignature: cached.cacheSignature,
        channelId,
        manual: true,
        originalContentHash: cyrb64Hash(cached.originalContent),
        originalContent: cached.originalContent,
        requestSignature: cached.requestSignature,
        sourceLanguage: cached.translated.sourceLanguage,
        targetLanguage: cached.targetLang,
        timestamp: Date.now(),
        translatedContent: currentContent,
        view: "original",
    });

    return { ok: true };
}

export function showTranslatedMessage(messageId: string): TranslationOutcome {
    const record = translatedMessages.get(messageId);
    if (!record) return { ok: false, reason: "This message is not translated." };

    dispatchMessageContentUpdate(messageId, record.channelId, record.translatedContent);
    record.view = "translation";
    translatedMessages.set(messageId, record);
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
    if (result.ok) translatedMessages.delete(messageId);
    return result;
}

export function revertAllTranslatedMessages() {
    for (const [messageId, record] of translatedMessages) {
        dispatchMessageContentUpdate(messageId, record.channelId, record.originalContent);
    }

    translatedMessages.clear();
}

export function revertTranslatedMessagesForChannel(channelId: string) {
    for (const [messageId, record] of translatedMessages) {
        if (record.channelId !== channelId) continue;

        dispatchMessageContentUpdate(messageId, record.channelId, record.originalContent);
        translatedMessages.delete(messageId);
    }
}

export function revertTranslatedMessagesForSignature(signature: string) {
    for (const [messageId, record] of translatedMessages) {
        if (record.cacheSignature !== signature && record.requestSignature !== signature) continue;

        dispatchMessageContentUpdate(messageId, record.channelId, record.originalContent);
        translatedMessages.delete(messageId);
    }
}

function revertTranslatedMessagesForCacheKeys(cacheKeys: Set<string>) {
    for (const [messageId, record] of translatedMessages) {
        if (!cacheKeys.has(record.cacheKey)) continue;

        dispatchMessageContentUpdate(messageId, record.channelId, record.originalContent);
        translatedMessages.delete(messageId);
    }
}

export function revertTranslatedMessagesWithDisabledAutoTranslate() {
    const state = useChatTranslatorSettings.getState();

    for (const [messageId, pending] of pendingTranslations) {
        const enabled = pending.channelId
            ? state.receivedChannelOverrides[pending.channelId] ?? state.autoTranslateReceived
            : state.autoTranslateReceived;

        if (!pending.manual && !enabled) pendingTranslations.delete(messageId);
    }

    for (const [messageId, record] of translatedMessages) {
        const enabled = record.channelId
            ? state.receivedChannelOverrides[record.channelId] ?? state.autoTranslateReceived
            : state.autoTranslateReceived;

        if (enabled || record.manual) continue;

        dispatchMessageContentUpdate(messageId, record.channelId, record.originalContent);
        translatedMessages.delete(messageId);
        clearPendingTranslationForMessage(messageId);
    }
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

export async function replaceMessageWithCachedTranslation(message: DiscordMessage): Promise<TranslationOutcome> {
    if (!runtimeActive) return { ok: false, reason: "ChatTranslator is not running." };

    const generation = runtimeGeneration;
    const messageId = message.id;
    const channelId = getMessageChannelId(message);
    if (!messageId || !channelId) return { ok: false, reason: "Missing message metadata." };

    const existingRecord = translatedMessages.get(messageId);
    const liveContent = getLiveMessageContent(channelId, messageId);
    const messageContent = getMessageContent(message);
    const hasLiveSourceChanged = !!(
        existingRecord
        && liveContent
        && liveContent !== existingRecord.originalContent
        && liveContent !== existingRecord.translatedContent
    );
    const originalContent = existingRecord && !hasLiveSourceChanged
        ? existingRecord.originalContent
        : liveContent || messageContent;
    if (!originalContent) return { ok: false, reason: "Skipped: empty message" };

    if (hasLiveSourceChanged) {
        translatedMessages.delete(messageId);
    }

    const skipReason = getAutomaticMessageSkipReason(message, originalContent);
    if (skipReason) return { ok: false, reason: skipReason.reason };

    switchDeepLToGoogleIfApiKeyMissing();

    const options = getReceivedTranslationOptionsForChannel(channelId);
    const { cacheKey, cacheSignature, requestSignature } = makeCacheKeyParts(channelId, originalContent, options.sourceLang, options.targetLang);
    const originalContentHash = cyrb64Hash(originalContent);

    if (
        existingRecord
        && existingRecord.originalContentHash === originalContentHash
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

    const cached = getCachedTranslation(cacheKey);
    if (!cached) return { ok: false, reason: NO_CACHED_TRANSLATION_REASON };
    if (cached.originalContent && cached.originalContent !== originalContent) {
        return { ok: false, reason: "Skipped: cached translation does not match the current message." };
    }

    const translatedContent = formatReceivedTranslation(originalContent, cached.translated, options.targetLang);
    const currentPending = pendingTranslations.get(messageId);

    if (
        currentPending
        && currentPending.channelId === channelId
        && currentPending.originalContentHash === originalContentHash
        && currentPending.cacheSignature === cacheSignature
        && currentPending.requestSignature === requestSignature
    ) {
        pendingTranslations.delete(messageId);
    }

    translatedMessages.set(messageId, {
        cacheKey,
        cacheSignature,
        channelId,
        manual: false,
        originalContentHash,
        originalContent,
        requestSignature,
        translatedContent,
        sourceLanguage: cached.translated.sourceLanguage,
        targetLanguage: options.targetLang,
        timestamp: Date.now(),
        view: "translation",
    });
    dispatchMessageContentUpdate(messageId, channelId, translatedContent);

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
    const liveContent = getLiveMessageContent(channelId, messageId);
    const messageContent = getMessageContent(message);
    const hasLiveSourceChanged = !!(
        existingRecord
        && liveContent
        && liveContent !== existingRecord.originalContent
        && liveContent !== existingRecord.translatedContent
    );
    const originalContent = existingRecord && !hasLiveSourceChanged
        ? existingRecord.originalContent
        : liveContent || messageContent;
    if (!originalContent) return { ok: false, reason: "Skipped: empty message" };

    if (hasLiveSourceChanged) {
        translatedMessages.delete(messageId);
    }

    const skipReason = manual
        ? getManualTranslationBlockReason(originalContent)
        : getAutomaticMessageSkipReason(message, originalContent);

    if (skipReason) return { ok: false, reason: skipReason.reason };

    switchDeepLToGoogleIfApiKeyMissing();

    const options = getReceivedTranslationOptionsForChannel(channelId);
    const { cacheKey, cacheSignature, requestSignature } = makeCacheKeyParts(channelId, originalContent, options.sourceLang, options.targetLang);
    const originalContentHash = cyrb64Hash(originalContent);
    const previousTranslatedContent = existingRecord?.translatedContent;
    const currentPending = pendingTranslations.get(messageId);

    if (
        currentPending
        && currentPending.channelId === channelId
        && currentPending.originalContentHash === originalContentHash
        && currentPending.cacheSignature === cacheSignature
        && currentPending.requestSignature === requestSignature
    ) {
        return { ok: false, reason: "Translation is already pending." };
    }

    if (
        !manual
        && existingRecord
        && existingRecord.originalContentHash === originalContentHash
        && existingRecord.cacheSignature === cacheSignature
        && existingRecord.requestSignature === requestSignature
        && (!liveContent || liveContent === existingRecord.translatedContent)
    ) {
        return { ok: true };
    }

    const pending: PendingTranslation = {
        cacheKey,
        cacheSignature,
        channelId,
        generation,
        manual,
        messageId,
        originalContent,
        originalContentHash,
        previousTranslatedContent,
        requestId: ++nextRequestId,
        requestSignature,
        startedAt: Date.now(),
    };

    pendingTranslations.set(messageId, pending);

    try {
        await ensurePersistentCacheLoaded();

        const staleAfterHydration = validatePendingTranslation(pending);
        if (staleAfterHydration) return { ok: false, reason: staleAfterHydration };

        const cached = getCachedTranslation(cacheKey);
        if (cached?.originalContent && cached.originalContent !== originalContent) {
            return { ok: false, reason: "Skipped: cached translation does not match the current message." };
        }

        const translated = cached?.translated ?? await translate("received", originalContent, {
            ...options,
            ignoreConfidenceRequirement,
        });

        const staleBeforeApply = validatePendingTranslation(pending);
        if (staleBeforeApply) return { ok: false, reason: staleBeforeApply };

        if (!cached) {
            const timestamp = Date.now();

            setCachedTranslation(cacheKey, {
                cacheSignature,
                channelId,
                key: cacheKey,
                lastUsedAt: timestamp,
                messageId,
                originalContent,
                requestSignature,
                sourceLang: options.sourceLang,
                targetLang: options.targetLang,
                timestamp,
                translated,
            });
        }

        const translatedContent = formatReceivedTranslation(originalContent, translated, options.targetLang);
        translatedMessages.set(messageId, {
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
            view: "translation",
        });
        dispatchMessageContentUpdate(messageId, channelId, translatedContent);

        return { ok: true, translated };
    } catch (error) {
        return { ok: false, reason: normalizeTranslationFailureReason(error) };
    } finally {
        if (pendingTranslations.get(messageId)?.requestId === pending.requestId) {
            pendingTranslations.delete(messageId);
        }
    }
}
