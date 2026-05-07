import { logger } from "@lib/utils/logger";
import { FluxDispatcher } from "@metro/common";
import { findByStoreName } from "@metro/wrappers";

import {
    clearTranslatedMessageStateIfSourceChanged,
    NO_CACHED_TRANSLATION_REASON,
    replaceMessageWithCachedTranslation,
    RETRY_CACHED_TRANSLATION_REASON,
    revertTranslatedMessagesWithDisabledAutoTranslate,
    translateAndReplaceMessage,
} from "../state";
import { useChatTranslatorSettings } from "../storage";
import {
    DiscordMessage,
    getMessageChannelId,
    getReceivedAutoTranslateChannelState,
} from "../utils";

const UserStore = findByStoreName("UserStore");
const SelectedChannelStore = findByStoreName("SelectedChannelStore");
const MessageStore = findByStoreName("MessageStore");
const CACHED_LOADED_TRANSLATIONS_PER_TICK = 12;
const CACHED_LOADED_TRANSLATION_TICK_DELAY_MS = 16;
const CACHED_LOADED_TRANSLATION_RETRY_DELAY_MS = 80;
const LOADED_MESSAGE_TRANSLATION_DELAY_MS = 350;
const MAX_CACHED_LOADED_TRANSLATION_RETRIES = 8;
const MAX_LOADED_TRANSLATION_QUEUE_SIZE = 60;
const scheduledTranslations = new Set<ReturnType<typeof setTimeout>>();
const queuedCachedLoadedTranslationKeys = new Set<string>();
const queuedLoadedTranslationKeys = new Set<string>();
const cachedLoadedTranslationQueue: { attempts: number; key: string; message: DiscordMessage }[] = [];
const loadedTranslationBacklog: { key: string; message: DiscordMessage }[] = [];
const loadedTranslationQueue: { key: string; message: DiscordMessage }[] = [];
let selectedChannelUnsubscribe: (() => void) | null = null;
let settingsUnsubscribe: (() => void) | null = null;
let cachedLoadedTranslationQueueTimer: ReturnType<typeof setTimeout> | null = null;
let cachedLoadedTranslationQueueRunning = false;
let loadedTranslationQueueTimer: ReturnType<typeof setTimeout> | null = null;
let loadedTranslationQueueRunning = false;
let loadedCurrentChannelTimer: ReturnType<typeof setTimeout> | null = null;
let active = false;

function shouldTranslateMessage(message: DiscordMessage, event?: any): boolean {
    if (!active) return false;
    if (!message?.id) return false;
    if ((message as any).__chatTranslator || event?.__chatTranslator || event?.otherPluginBypass) return false;
    if (event?.sendMessageOptions !== undefined) return false;

    const currentUserId = UserStore?.getCurrentUser?.()?.id;
    if (currentUserId && message.author?.id === currentUserId) return false;

    const channelId = getMessageChannelId(message);
    return getReceivedAutoTranslateChannelState(channelId);
}

function scheduleTranslate(message: DiscordMessage, event?: any) {
    if (!shouldTranslateMessage(message, event)) return;

    void translateAndReplaceMessage(message, { manual: false })
        .then(logAutoTranslationResult)
        .catch(error => logger.error("[ChatTranslator] Auto translation crashed:", error));
}

function getScheduledTranslationKey(message: DiscordMessage, channelId = getMessageChannelId(message)): string | null {
    return message.id && channelId ? `${channelId}:${message.id}` : null;
}

function logAutoTranslationResult(result: Awaited<ReturnType<typeof translateAndReplaceMessage>>) {
    if (!active) return;
    if (!result.ok && result.reason && !/^Skipped:/i.test(result.reason)) {
        logger.warn("[ChatTranslator] Auto translation failed:", result.reason);
    }
}

function scheduleNextCachedLoadedQueueTick(delay = 0) {
    if (
        !active
        || cachedLoadedTranslationQueueRunning
        || cachedLoadedTranslationQueueTimer
        || !cachedLoadedTranslationQueue.length
    ) return;

    cachedLoadedTranslationQueueTimer = setTimeout(() => {
        if (cachedLoadedTranslationQueueTimer) scheduledTranslations.delete(cachedLoadedTranslationQueueTimer);
        cachedLoadedTranslationQueueTimer = null;
        void processNextCachedLoadedTranslations();
    }, delay);

    scheduledTranslations.add(cachedLoadedTranslationQueueTimer);
}

function scheduleNextLoadedQueueTick(delay = LOADED_MESSAGE_TRANSLATION_DELAY_MS) {
    if (!active || loadedTranslationQueueRunning || loadedTranslationQueueTimer || !loadedTranslationQueue.length) return;

    loadedTranslationQueueTimer = setTimeout(() => {
        if (loadedTranslationQueueTimer) scheduledTranslations.delete(loadedTranslationQueueTimer);
        loadedTranslationQueueTimer = null;
        void processNextLoadedTranslation();
    }, delay);

    scheduledTranslations.add(loadedTranslationQueueTimer);
}

async function processNextCachedLoadedTranslations() {
    if (!active || cachedLoadedTranslationQueueRunning) return;

    cachedLoadedTranslationQueueRunning = true;
    let nextDelay = CACHED_LOADED_TRANSLATION_TICK_DELAY_MS;

    try {
        for (let processed = 0; active && processed < CACHED_LOADED_TRANSLATIONS_PER_TICK; processed++) {
            const next = cachedLoadedTranslationQueue.shift();
            if (!next) break;
            let keepQueuedKey = false;

            try {
                if (!shouldTranslateMessage(next.message)) continue;

                const result = await replaceMessageWithCachedTranslation(next.message);

                if (!active) return;

                if (result.reason === NO_CACHED_TRANSLATION_REASON) {
                    scheduleLoadedMessageTranslate(next.message);
                    continue;
                }

                if (result.reason === RETRY_CACHED_TRANSLATION_REASON && next.attempts < MAX_CACHED_LOADED_TRANSLATION_RETRIES) {
                    cachedLoadedTranslationQueue.push({
                        ...next,
                        attempts: next.attempts + 1,
                    });
                    keepQueuedKey = true;
                    nextDelay = Math.max(nextDelay, CACHED_LOADED_TRANSLATION_RETRY_DELAY_MS);
                    continue;
                }

                if (result.reason === RETRY_CACHED_TRANSLATION_REASON) {
                    scheduleLoadedMessageTranslate(next.message);
                    continue;
                }

                logAutoTranslationResult(result);
            } catch (error) {
                logger.error("[ChatTranslator] Cached auto translation crashed:", error);
            } finally {
                if (!keepQueuedKey) queuedCachedLoadedTranslationKeys.delete(next.key);
            }
        }
    } finally {
        cachedLoadedTranslationQueueRunning = false;
        scheduleNextCachedLoadedQueueTick(nextDelay);
    }
}

async function processNextLoadedTranslation() {
    if (!active || loadedTranslationQueueRunning) return;

    drainLoadedTranslationBacklog(false);
    const next = loadedTranslationQueue.shift();
    if (!next) return;

    loadedTranslationQueueRunning = true;

    try {
        if (shouldTranslateMessage(next.message)) {
            logAutoTranslationResult(await translateAndReplaceMessage(next.message, { manual: false }));
        }
    } catch (error) {
        logger.error("[ChatTranslator] Auto translation crashed:", error);
    } finally {
        queuedLoadedTranslationKeys.delete(next.key);
        drainLoadedTranslationBacklog();
        loadedTranslationQueueRunning = false;
        scheduleNextLoadedQueueTick();
    }
}

function scheduleLoadedMessageTranslate(message: DiscordMessage): boolean {
    if (!shouldTranslateMessage(message)) return false;

    const channelId = getMessageChannelId(message);
    const key = getScheduledTranslationKey(message, channelId);
    if (!key || queuedLoadedTranslationKeys.has(key)) return false;

    queuedLoadedTranslationKeys.add(key);
    if (loadedTranslationQueue.length >= MAX_LOADED_TRANSLATION_QUEUE_SIZE) {
        loadedTranslationBacklog.push({ key, message });
        return true;
    }

    loadedTranslationQueue.push({ key, message });
    scheduleNextLoadedQueueTick();
    return true;
}

function drainLoadedTranslationBacklog(shouldSchedule = true) {
    while (loadedTranslationQueue.length < MAX_LOADED_TRANSLATION_QUEUE_SIZE) {
        const next = loadedTranslationBacklog.shift();
        if (!next) break;

        loadedTranslationQueue.push(next);
    }

    if (shouldSchedule) scheduleNextLoadedQueueTick();
}

function loadCachedOrScheduleLoadedMessageTranslate(message: DiscordMessage) {
    if (!shouldTranslateMessage(message)) return;

    const channelId = getMessageChannelId(message);
    const key = getScheduledTranslationKey(message, channelId);
    if (!key || queuedCachedLoadedTranslationKeys.has(key)) return;

    queuedCachedLoadedTranslationKeys.add(key);
    cachedLoadedTranslationQueue.push({ attempts: 0, key, message });
    scheduleNextCachedLoadedQueueTick();
}

function getSelectedChannelId(): string | undefined {
    return SelectedChannelStore?.getChannelId?.()
        ?? SelectedChannelStore?.getCurrentlySelectedChannelId?.();
}

function getLoadedMessages(channelId: string): DiscordMessage[] {
    const messages = MessageStore?.getMessages?.(channelId);
    if (!messages) return [];

    if (Array.isArray(messages)) return messages;
    if (Array.isArray(messages._array)) return messages._array;
    if (typeof messages.toArray === "function") return messages.toArray();

    return [];
}

function scheduleLoadedChannelTranslations(channelId = getSelectedChannelId()) {
    if (!active || !channelId || !getReceivedAutoTranslateChannelState(channelId)) return;

    const loadedMessages = getLoadedMessages(channelId);
    if (!loadedMessages.length) return;

    const seenMessageIds = new Set<string>();

    for (const message of loadedMessages as any[]) {
        if (!message?.id || seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);
        loadCachedOrScheduleLoadedMessageTranslate(
            { ...message, channel_id: message.channel_id ?? message.channelId ?? channelId },
        );
    }
}

function scheduleLoadedCurrentChannelTranslations(delay = 250) {
    if (loadedCurrentChannelTimer) {
        clearTimeout(loadedCurrentChannelTimer);
        scheduledTranslations.delete(loadedCurrentChannelTimer);
    }

    const timeout = setTimeout(() => {
        scheduledTranslations.delete(timeout);
        loadedCurrentChannelTimer = null;
        scheduleLoadedChannelTranslations();
    }, delay);

    loadedCurrentChannelTimer = timeout;
    scheduledTranslations.add(timeout);
}

function clearScheduledTranslations() {
    for (const timeout of scheduledTranslations) clearTimeout(timeout);
    scheduledTranslations.clear();
    cachedLoadedTranslationQueueTimer = null;
    loadedTranslationQueueTimer = null;
    loadedCurrentChannelTimer = null;
    cachedLoadedTranslationQueue.length = 0;
    loadedTranslationBacklog.length = 0;
    loadedTranslationQueue.length = 0;
    queuedCachedLoadedTranslationKeys.clear();
    queuedLoadedTranslationKeys.clear();
}

function onMessageCreate(event: any) {
    const message = event?.message;
    if (!message) return;

    const channelId = message.channel_id ?? message.channelId ?? event.channelId;
    scheduleTranslate({ ...message, channel_id: channelId }, event);
}

function onMessageUpdate(event: any) {
    const message = event?.message;
    if (!message || event?.__chatTranslator || event?.otherPluginBypass || message.__chatTranslator) return;

    const channelId = message.channel_id ?? message.channelId ?? event.channelId;
    const normalizedMessage = { ...message, channel_id: channelId };
    clearTranslatedMessageStateIfSourceChanged(normalizedMessage);
    scheduleTranslate(normalizedMessage, event);
}

function onLoadMessages(event: any) {
    const messages = event?.messages;
    if (!Array.isArray(messages) || !messages.length) return;

    const selectedChannelId = SelectedChannelStore?.getChannelId?.() ?? SelectedChannelStore?.getCurrentlySelectedChannelId?.();
    const seenMessageIds = new Set<string>();

    for (const message of messages as any[]) {
        if (!message?.id || seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);

        const channelId = message.channel_id ?? message.channelId ?? event.channelId ?? selectedChannelId;
        loadCachedOrScheduleLoadedMessageTranslate({ ...message, channel_id: channelId });
    }
}

function onMessageDelete(event: any) {
    const message = event?.message;
    const messageId = message?.id ?? event?.id;
    if (!messageId) return;

    const channelId = message?.channel_id ?? message?.channelId ?? event?.channelId ?? event?.channel_id;
    clearTranslatedMessageStateIfSourceChanged({ id: messageId, channel_id: channelId, content: "" });
}

function onChannelChange() {
    scheduleLoadedCurrentChannelTranslations(350);
}

function onRelevantSettingsChange(next: ReturnType<typeof useChatTranslatorSettings.getState>, prev: ReturnType<typeof useChatTranslatorSettings.getState>) {
    const selectedChannelId = getSelectedChannelId();

    if (prev.autoTranslateReceived && !next.autoTranslateReceived) {
        clearScheduledTranslations();
        revertTranslatedMessagesWithDisabledAutoTranslate();
    }

    if (!selectedChannelId) return;

    const prevChannelEnabled = prev.receivedChannelOverrides[selectedChannelId] ?? prev.autoTranslateReceived;
    const nextChannelEnabled = next.receivedChannelOverrides[selectedChannelId] ?? next.autoTranslateReceived;

    if (prevChannelEnabled && !nextChannelEnabled) {
        clearScheduledTranslations();
        revertTranslatedMessagesWithDisabledAutoTranslate();
        return;
    }

    const relevantChanged =
        next.autoTranslateReceived !== prev.autoTranslateReceived
        || next.service !== prev.service
        || next.receivedInput !== prev.receivedInput
        || next.receivedOutput !== prev.receivedOutput
        || next.googleConfidenceRequirement !== prev.googleConfidenceRequirement
        || next.deeplApiKey !== prev.deeplApiKey
        || next.azureApiKey !== prev.azureApiKey
        || next.azureRegion !== prev.azureRegion
        || next.azureEndpoint !== prev.azureEndpoint
        || next.receivedChannelOverrides[selectedChannelId] !== prev.receivedChannelOverrides[selectedChannelId]
        || next.receivedChannelInputOverrides[selectedChannelId] !== prev.receivedChannelInputOverrides[selectedChannelId]
        || next.receivedChannelOutputOverrides[selectedChannelId] !== prev.receivedChannelOutputOverrides[selectedChannelId];

    if (relevantChanged) scheduleLoadedCurrentChannelTranslations(250);
}

export default function patchReceivedMessages() {
    active = true;
    FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
    FluxDispatcher.subscribe("MESSAGE_DELETE", onMessageDelete);
    FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onLoadMessages);
    FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelChange);
    FluxDispatcher.subscribe("CHANNEL_VIEW", onChannelChange);

    selectedChannelUnsubscribe = SelectedChannelStore?.addChangeListener
        ? () => SelectedChannelStore.removeChangeListener?.(onChannelChange)
        : null;
    SelectedChannelStore?.addChangeListener?.(onChannelChange);
    settingsUnsubscribe = useChatTranslatorSettings.subscribe(onRelevantSettingsChange);
    scheduleLoadedCurrentChannelTranslations(700);

    return () => {
        active = false;
        clearScheduledTranslations();

        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onMessageUpdate);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE", onMessageDelete);
        FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", onLoadMessages);
        FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelChange);
        FluxDispatcher.unsubscribe("CHANNEL_VIEW", onChannelChange);
        selectedChannelUnsubscribe?.();
        selectedChannelUnsubscribe = null;
        settingsUnsubscribe?.();
        settingsUnsubscribe = null;
    };
}
