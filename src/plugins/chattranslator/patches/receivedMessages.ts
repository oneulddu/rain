import { logger } from "@lib/utils/logger";
import { FluxDispatcher } from "@metro/common";
import { findByStoreName } from "@metro/wrappers";

import {
    clearTranslatedMessageStateIfSourceChanged,
    discardMessageTranslationState,
    discardMessageTranslationStates,
    NO_CACHED_TRANSLATION_REASON,
    pruneTranslationCache,
    reconcileTranslatedMessagesWithCurrentSettings,
    refreshTranslatedMessageFormatting,
    replaceMessageWithCachedTranslation,
    RETRY_CACHED_TRANSLATION_REASON,
    translateAndReplaceMessage,
} from "../state";
import { useChatTranslatorSettings } from "../storage";
import {
    DiscordMessage,
    getAutomaticMessageSkipReason,
    getMessageChannelId,
    getMessageContent,
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
const MAX_CACHED_LOADED_TRANSLATION_QUEUE_SIZE = 300;
const MAX_LOADED_TRANSLATION_BACKLOG_SIZE = 180;
const MAX_LOADED_TRANSLATION_QUEUE_SIZE = 60;
const MAX_SCHEDULED_MESSAGE_UPDATES = 300;
const MESSAGE_UPDATE_TRANSLATION_DELAY_MS = 180;
const scheduledTranslations = new Set<ReturnType<typeof setTimeout>>();
const scheduledMessageUpdates = new Map<string, ReturnType<typeof setTimeout>>();
const queuedCachedLoadedTranslationKeys = new Map<string, symbol>();
const queuedLoadedTranslationKeys = new Map<string, symbol>();

interface QueuedLoadedTranslation {
    key: string;
    message: DiscordMessage;
    owner: symbol;
}

interface QueuedCachedLoadedTranslation extends QueuedLoadedTranslation {
    attempts: number;
}

interface MessageFluxEvent {
    __chatTranslator?: boolean;
    channel_id?: string;
    channelId?: string;
    id?: string;
    ids?: unknown;
    message?: DiscordMessage;
    messageIds?: unknown;
    messages?: DiscordMessage[];
    otherPluginBypass?: boolean;
    sendMessageOptions?: unknown;
}

const cachedLoadedTranslationQueue: QueuedCachedLoadedTranslation[] = [];
const loadedTranslationBacklog: QueuedLoadedTranslation[] = [];
const loadedTranslationQueue: QueuedLoadedTranslation[] = [];
let selectedChannelUnsubscribe: (() => void) | null = null;
let settingsUnsubscribe: (() => void) | null = null;
let cachedLoadedTranslationQueueTimer: ReturnType<typeof setTimeout> | null = null;
let cachedLoadedTranslationQueueRunning = false;
let loadedTranslationQueueTimer: ReturnType<typeof setTimeout> | null = null;
let loadedTranslationQueueRunning = false;
let loadedCurrentChannelTimer: ReturnType<typeof setTimeout> | null = null;
let active = false;
let queueGeneration = 0;

function shouldTranslateMessage(message: DiscordMessage, event?: MessageFluxEvent): boolean {
    if (!active) return false;
    if (!message?.id) return false;
    if (message.__chatTranslator || event?.__chatTranslator || event?.otherPluginBypass) return false;
    if (event?.sendMessageOptions !== undefined) return false;

    const currentUserId = UserStore?.getCurrentUser?.()?.id;
    if (currentUserId && message.author?.id === currentUserId) return false;

    const channelId = getMessageChannelId(message);
    return getReceivedAutoTranslateChannelState(channelId)
        && !getAutomaticMessageSkipReason(message, getMessageContent(message));
}

function scheduleTranslate(message: DiscordMessage, event?: MessageFluxEvent) {
    if (!shouldTranslateMessage(message, event)) return;

    const generation = queueGeneration;
    void translateAndReplaceMessage(message, { manual: false })
        .then(result => {
            if (active && generation === queueGeneration) logAutoTranslationResult(result);
        })
        .catch(error => {
            if (!active || generation !== queueGeneration) return;
            logger.error(
                "[ChatTranslator] Auto translation crashed:",
                error instanceof Error ? error.name : "UnknownError"
            );
        });
}

function getScheduledTranslationKey(message: DiscordMessage, channelId = getMessageChannelId(message)): string | null {
    return message.id && channelId ? `${channelId}:${message.id}` : null;
}

function scheduleUpdatedMessageTranslate(message: DiscordMessage) {
    const key = getScheduledTranslationKey(message);
    if (!key) return;

    const currentTimer = scheduledMessageUpdates.get(key);
    if (currentTimer) {
        clearTimeout(currentTimer);
        scheduledTranslations.delete(currentTimer);
    }

    if (!shouldTranslateMessage(message)) {
        scheduledMessageUpdates.delete(key);
        return;
    }

    if (!currentTimer && scheduledMessageUpdates.size >= MAX_SCHEDULED_MESSAGE_UPDATES) {
        const oldest = scheduledMessageUpdates.entries().next();
        if (!oldest.done) {
            clearTimeout(oldest.value[1]);
            scheduledTranslations.delete(oldest.value[1]);
            scheduledMessageUpdates.delete(oldest.value[0]);
        }
    }

    const timer = setTimeout(() => {
        scheduledTranslations.delete(timer);
        if (scheduledMessageUpdates.get(key) !== timer) return;

        scheduledMessageUpdates.delete(key);
        scheduleTranslate(message);
    }, MESSAGE_UPDATE_TRANSLATION_DELAY_MS);
    scheduledMessageUpdates.set(key, timer);
    scheduledTranslations.add(timer);
}

function logAutoTranslationResult(result: Awaited<ReturnType<typeof translateAndReplaceMessage>>) {
    if (!active) return;
    if (!result.ok && result.reason && !/^Skipped:/i.test(result.reason)) {
        logger.warn("[ChatTranslator] Auto translation failed:", result.reason);
    }
}

function releaseQueuedKey(owners: Map<string, symbol>, entry: QueuedLoadedTranslation) {
    if (owners.get(entry.key) === entry.owner) owners.delete(entry.key);
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

    const generation = queueGeneration;
    cachedLoadedTranslationQueueRunning = true;
    let nextDelay = CACHED_LOADED_TRANSLATION_TICK_DELAY_MS;

    try {
        for (
            let processed = 0;
            active && generation === queueGeneration && processed < CACHED_LOADED_TRANSLATIONS_PER_TICK;
            processed++
        ) {
            const next = cachedLoadedTranslationQueue.shift();
            if (!next) break;
            let keepQueuedKey = false;

            try {
                if (!shouldTranslateMessage(next.message)) continue;

                const result = await replaceMessageWithCachedTranslation(next.message);

                if (!active || generation !== queueGeneration) return;

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
                if (!active || generation !== queueGeneration) return;
                logger.error(
                    "[ChatTranslator] Cached auto translation crashed:",
                    error instanceof Error ? error.name : "UnknownError"
                );
            } finally {
                if (!keepQueuedKey) releaseQueuedKey(queuedCachedLoadedTranslationKeys, next);
            }
        }
    } finally {
        if (generation !== queueGeneration) return;
        cachedLoadedTranslationQueueRunning = false;
        scheduleNextCachedLoadedQueueTick(nextDelay);
    }
}

async function processNextLoadedTranslation() {
    if (!active || loadedTranslationQueueRunning) return;

    const generation = queueGeneration;
    drainLoadedTranslationBacklog(false);
    const next = loadedTranslationQueue.shift();
    if (!next) return;

    loadedTranslationQueueRunning = true;

    try {
        if (shouldTranslateMessage(next.message)) {
            const result = await translateAndReplaceMessage(next.message, { manual: false });
            if (active && generation === queueGeneration) logAutoTranslationResult(result);
        }
    } catch (error) {
        if (!active || generation !== queueGeneration) return;
        logger.error(
            "[ChatTranslator] Auto translation crashed:",
            error instanceof Error ? error.name : "UnknownError"
        );
    } finally {
        if (generation !== queueGeneration) return;
        releaseQueuedKey(queuedLoadedTranslationKeys, next);
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

    const owner = Symbol(key);
    queuedLoadedTranslationKeys.set(key, owner);
    if (loadedTranslationQueue.length >= MAX_LOADED_TRANSLATION_QUEUE_SIZE) {
        if (loadedTranslationBacklog.length >= MAX_LOADED_TRANSLATION_BACKLOG_SIZE) {
            const dropped = loadedTranslationBacklog.shift();
            if (dropped) releaseQueuedKey(queuedLoadedTranslationKeys, dropped);
        }
        loadedTranslationBacklog.push({ key, message, owner });
        return true;
    }

    loadedTranslationQueue.push({ key, message, owner });
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

    if (cachedLoadedTranslationQueue.length >= MAX_CACHED_LOADED_TRANSLATION_QUEUE_SIZE) {
        const dropped = cachedLoadedTranslationQueue.shift();
        if (dropped) releaseQueuedKey(queuedCachedLoadedTranslationKeys, dropped);
    }
    const owner = Symbol(key);
    queuedCachedLoadedTranslationKeys.set(key, owner);
    cachedLoadedTranslationQueue.push({ attempts: 0, key, message, owner });
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

    for (const message of loadedMessages) {
        if (!message?.id || seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);
        loadCachedOrScheduleLoadedMessageTranslate(
            { ...message, channel_id: message.channel_id ?? message.channelId ?? channelId },
        );
    }
}

function scheduleLoadedCurrentChannelTranslations(delay = 250) {
    if (!active) return;

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
    queueGeneration++;
    for (const timeout of scheduledTranslations) clearTimeout(timeout);
    scheduledTranslations.clear();
    cachedLoadedTranslationQueueTimer = null;
    loadedTranslationQueueTimer = null;
    loadedCurrentChannelTimer = null;
    cachedLoadedTranslationQueue.length = 0;
    loadedTranslationBacklog.length = 0;
    loadedTranslationQueue.length = 0;
    scheduledMessageUpdates.clear();
    queuedCachedLoadedTranslationKeys.clear();
    queuedLoadedTranslationKeys.clear();
    cachedLoadedTranslationQueueRunning = false;
    loadedTranslationQueueRunning = false;
}

function removeQueuedMessage(
    queue: QueuedLoadedTranslation[],
    messageId: string,
    channelId?: string
) {
    for (let index = queue.length - 1; index >= 0; index--) {
        const entry = queue[index];
        if (
            entry.message.id !== messageId
            || (channelId && getMessageChannelId(entry.message) !== channelId)
        ) continue;

        queue.splice(index, 1);
        releaseQueuedKey(queuedCachedLoadedTranslationKeys, entry);
        releaseQueuedKey(queuedLoadedTranslationKeys, entry);
    }
}

function removeScheduledMessageUpdate(messageId: string, channelId?: string) {
    for (const [key, timer] of scheduledMessageUpdates) {
        if (
            !key.endsWith(`:${messageId}`)
            || (channelId && key !== `${channelId}:${messageId}`)
        ) continue;

        clearTimeout(timer);
        scheduledTranslations.delete(timer);
        scheduledMessageUpdates.delete(key);
    }
}

function onMessageCreate(event: MessageFluxEvent) {
    const message = event?.message;
    if (!message) return;

    const channelId = message.channel_id ?? message.channelId ?? event.channelId;
    scheduleTranslate({ ...message, channel_id: channelId }, event);
}

function onMessageUpdate(event: MessageFluxEvent) {
    const message = event?.message;
    if (!message || event?.__chatTranslator || event?.otherPluginBypass || message.__chatTranslator) return;
    const hasContentPayload = Object.prototype.hasOwnProperty.call(message, "content")
        || !!message.messageSnapshots?.length
        || !!message.embeds?.some((embed: { rawDescription?: unknown; type?: string }) => (
            embed.type === "auto_moderation_message" && typeof embed.rawDescription === "string"
        ));
    if (!hasContentPayload) return;

    const channelId = message.channel_id ?? message.channelId ?? event.channelId;
    const liveMessage = channelId && message.id
        ? MessageStore?.getMessage?.(channelId, message.id)
        : null;
    const normalizedMessage = {
        ...liveMessage,
        ...message,
        author: message.author ?? liveMessage?.author,
        channel_id: channelId,
    };
    clearTranslatedMessageStateIfSourceChanged(normalizedMessage);
    scheduleUpdatedMessageTranslate(normalizedMessage);
}

function onLoadMessages(event: MessageFluxEvent) {
    const messages = event?.messages;
    if (!Array.isArray(messages) || !messages.length) return;

    const selectedChannelId = SelectedChannelStore?.getChannelId?.() ?? SelectedChannelStore?.getCurrentlySelectedChannelId?.();
    const seenMessageIds = new Set<string>();

    for (const message of messages) {
        if (!message?.id || seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);

        const channelId = message.channel_id ?? message.channelId ?? event.channelId ?? selectedChannelId;
        loadCachedOrScheduleLoadedMessageTranslate({ ...message, channel_id: channelId });
    }
}

function onMessageDelete(event: MessageFluxEvent) {
    const message = event?.message;
    const messageId = message?.id ?? event?.id;
    if (!messageId) return;

    const channelId = message?.channel_id ?? message?.channelId ?? event?.channelId ?? event?.channel_id;
    removeScheduledMessageUpdate(messageId, channelId);
    removeQueuedMessage(cachedLoadedTranslationQueue, messageId, channelId);
    removeQueuedMessage(loadedTranslationBacklog, messageId, channelId);
    removeQueuedMessage(loadedTranslationQueue, messageId, channelId);
    discardMessageTranslationState(messageId);
}

function onMessageDeleteBulk(event: MessageFluxEvent) {
    const messageIds = event?.ids ?? event?.messageIds;
    if (!Array.isArray(messageIds)) return;

    const channelId = event?.channelId ?? event?.channel_id;
    const discardedMessageIds: string[] = [];
    for (const messageId of messageIds) {
        if (typeof messageId !== "string") continue;

        removeScheduledMessageUpdate(messageId, channelId);
        removeQueuedMessage(cachedLoadedTranslationQueue, messageId, channelId);
        removeQueuedMessage(loadedTranslationBacklog, messageId, channelId);
        removeQueuedMessage(loadedTranslationQueue, messageId, channelId);
        discardedMessageIds.push(messageId);
    }

    discardMessageTranslationStates(discardedMessageIds);
}

function onChannelChange() {
    scheduleLoadedCurrentChannelTranslations(350);
}

function safelyHandleFluxEvent(
    eventName: string,
    listener: (event: MessageFluxEvent) => void
): (event: MessageFluxEvent) => void {
    return event => {
        try {
            listener(event);
        } catch (error) {
            logger.error(
                `[ChatTranslator] Failed to handle ${eventName}`,
                error instanceof Error ? error.name : "UnknownError"
            );
        }
    };
}

function onRelevantSettingsChange(next: ReturnType<typeof useChatTranslatorSettings.getState>, prev: ReturnType<typeof useChatTranslatorSettings.getState>) {
    const displayModeChanged = next.receivedDisplayMode !== prev.receivedDisplayMode;
    const cachePolicyChanged = next.translationCacheLimit !== prev.translationCacheLimit
        || next.translationCacheTtlDays !== prev.translationCacheTtlDays;
    const receivedBehaviorChanged =
        next.autoTranslateReceived !== prev.autoTranslateReceived
        || next.service !== prev.service
        || next.receivedInput !== prev.receivedInput
        || next.receivedOutput !== prev.receivedOutput
        || next.googleConfidenceRequirement !== prev.googleConfidenceRequirement
        || next.deeplApiKey !== prev.deeplApiKey
        || next.azureApiKey !== prev.azureApiKey
        || next.azureRegion !== prev.azureRegion
        || next.azureEndpoint !== prev.azureEndpoint
        || next.autoTranslateMaxCharacters !== prev.autoTranslateMaxCharacters
        || next.autoTranslateMaxLines !== prev.autoTranslateMaxLines
        || next.skipCodeBlockMessages !== prev.skipCodeBlockMessages
        || next.skipAlreadyTranslatedMessages !== prev.skipAlreadyTranslatedMessages
        || next.skipBotMessages !== prev.skipBotMessages
        || next.ignoredGuilds !== prev.ignoredGuilds
        || next.ignoredChannels !== prev.ignoredChannels
        || next.ignoredUsers !== prev.ignoredUsers
        || next.receivedChannelOverrides !== prev.receivedChannelOverrides
        || next.receivedChannelInputOverrides !== prev.receivedChannelInputOverrides
        || next.receivedChannelOutputOverrides !== prev.receivedChannelOutputOverrides;

    if (receivedBehaviorChanged) {
        clearScheduledTranslations();
        reconcileTranslatedMessagesWithCurrentSettings();
    }
    if (displayModeChanged) refreshTranslatedMessageFormatting();
    if (cachePolicyChanged) void pruneTranslationCache();
    if (!receivedBehaviorChanged) return;

    const selectedChannelId = getSelectedChannelId();
    if (selectedChannelId && getReceivedAutoTranslateChannelState(selectedChannelId)) {
        scheduleLoadedCurrentChannelTranslations(250);
    }
}

export default function patchReceivedMessages() {
    active = true;
    queueGeneration++;
    cachedLoadedTranslationQueueRunning = false;
    loadedTranslationQueueRunning = false;
    const fluxSubscriptions: [string, (event: MessageFluxEvent) => void][] = [
        ["MESSAGE_CREATE", safelyHandleFluxEvent("MESSAGE_CREATE", onMessageCreate)],
        ["MESSAGE_UPDATE", safelyHandleFluxEvent("MESSAGE_UPDATE", onMessageUpdate)],
        ["MESSAGE_DELETE", safelyHandleFluxEvent("MESSAGE_DELETE", onMessageDelete)],
        ["MESSAGE_DELETE_BULK", safelyHandleFluxEvent("MESSAGE_DELETE_BULK", onMessageDeleteBulk)],
        ["LOAD_MESSAGES_SUCCESS", safelyHandleFluxEvent("LOAD_MESSAGES_SUCCESS", onLoadMessages)],
        ["CHANNEL_SELECT", safelyHandleFluxEvent("CHANNEL_SELECT", onChannelChange)],
        ["CHANNEL_VIEW", safelyHandleFluxEvent("CHANNEL_VIEW", onChannelChange)],
    ];
    let subscribedFluxEvents = 0;
    const removeSubscriptions = () => {
        for (let index = subscribedFluxEvents - 1; index >= 0; index--) {
            const [event, listener] = fluxSubscriptions[index];
            try {
                FluxDispatcher.unsubscribe(event, listener);
            } catch (error) {
                logger.warn(
                    "[ChatTranslator] Failed to remove a message event subscription:",
                    error instanceof Error ? error.name : "UnknownError"
                );
            }
        }
        subscribedFluxEvents = 0;

        try {
            selectedChannelUnsubscribe?.();
        } catch (error) {
            logger.warn(
                "[ChatTranslator] Failed to remove the channel selection subscription:",
                error instanceof Error ? error.name : "UnknownError"
            );
        }
        selectedChannelUnsubscribe = null;
        try {
            settingsUnsubscribe?.();
        } catch (error) {
            logger.warn(
                "[ChatTranslator] Failed to remove the translation settings subscription:",
                error instanceof Error ? error.name : "UnknownError"
            );
        } finally {
            settingsUnsubscribe = null;
        }
    };

    try {
        for (const [event, listener] of fluxSubscriptions) {
            FluxDispatcher.subscribe(event, listener);
            subscribedFluxEvents++;
        }

        selectedChannelUnsubscribe = SelectedChannelStore?.addChangeListener
            ? () => SelectedChannelStore.removeChangeListener?.(onChannelChange)
            : null;
        SelectedChannelStore?.addChangeListener?.(onChannelChange);
        settingsUnsubscribe = useChatTranslatorSettings.subscribe((next, previous) => {
            try {
                onRelevantSettingsChange(next, previous);
            } catch (error) {
                logger.error(
                    "[ChatTranslator] Failed to apply a translation settings change",
                    error instanceof Error ? error.name : "UnknownError"
                );
            }
        });
        scheduleLoadedCurrentChannelTranslations(700);
    } catch (error) {
        active = false;
        clearScheduledTranslations();
        removeSubscriptions();
        throw error;
    }

    return () => {
        active = false;
        clearScheduledTranslations();
        removeSubscriptions();
    };
}
