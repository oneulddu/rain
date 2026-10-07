import { findAssetId } from "@api/assets";
import { instead } from "@api/patcher";
import { showToast } from "@api/ui/toasts";
import { logger } from "@lib/utils/logger";
import { findByProps } from "@metro";

import {
    makeTranslationRequestKey,
    trackTranslationExecution,
    translationRequestCoordinator,
} from "../requests";
import {
    consumeManualTranslateNextSend,
    isManualTranslateNextSendEnabled,
} from "../state";
import { useChatTranslatorSettings } from "../storage";
import {
    getAutomaticTranslationSkipReason,
    getManualTranslationBlockReason,
    getSentAutoTranslateChannelState,
    getSentTranslationRequestSignatureFromValues,
    hasMeaningfulTextForTranslation,
    isTranslationAbortError,
    normalizeTranslationFailureReason,
    switchDeepLToGoogleIfApiKeyMissing,
    translate,
} from "../utils";

const LanguageIcon = findAssetId("LanguageIcon");

function showTranslationToast(message: string) {
    try {
        showToast(message, LanguageIcon);
    } catch (error) {
        logger.error(
            "[ChatTranslator] Failed to show an outgoing translation toast",
            error instanceof Error ? error.name : "UnknownError"
        );
    }
}

function shouldSkipSentMessage(content: string): boolean {
    if (!content || !hasMeaningfulTextForTranslation(content)) return true;
    if (content.trim().startsWith("/")) return true;

    return !!getAutomaticTranslationSkipReason(content);
}

function getManualSentSkipReason(content: string): string | null {
    if (!content) return "Skipped: empty message";
    if (content.trim().startsWith("/")) return "Skipped: commands are not translated";

    return getManualTranslationBlockReason(content)?.reason ?? null;
}

interface OutgoingMessagePayload {
    channel_id?: string;
    channelId?: string;
    content?: unknown;
}

interface PendingOutgoingTranslation {
    cancel: () => void;
    cancelled: boolean;
    channelId?: string;
    content: string;
    manual: boolean;
    release: () => void;
    requestSignature: string;
}

function getOutgoingChannelId(args: unknown[], payload?: OutgoingMessagePayload): string | undefined {
    return typeof args[0] === "string"
        ? args[0]
        : payload?.channel_id ?? payload?.channelId;
}

interface InstalledSendMessagePatch {
    activate: () => () => boolean;
}

let installedSendMessagePatch: InstalledSendMessagePatch | null = null;

function installSendMessagePatch(Messages: { sendMessage: (...args: any[]) => any }): InstalledSendMessagePatch {
    let active = false;
    let disposed = false;
    let lifecycle = 0;
    let unsubscribeSettings: (() => void) | null = null;
    const pendingTranslations = new Set<PendingOutgoingTranslation>();
    const sendTails = new Map<string, Promise<void>>();

    const enqueueSend = (
        channelId: string | undefined,
        send: (markInvoked: () => void) => unknown
    ): Promise<unknown> => {
        const key = channelId || "__unknown_channel__";
        const previous = sendTails.get(key) ?? Promise.resolve();
        let resolveInvocation: () => void = () => undefined;
        const tail = new Promise<void>(resolve => {
            resolveInvocation = resolve;
        });
        let invoked = false;
        const markInvoked = () => {
            if (invoked) return;
            invoked = true;
            resolveInvocation();
        };
        const invoke = () => {
            let result: unknown;
            try {
                result = send(markInvoked);
            } catch (error) {
                markInvoked();
                throw error;
            }

            void Promise.resolve(result).then(markInvoked, markInvoked);
            return result;
        };
        const queued = previous.then(invoke, invoke);
        sendTails.set(key, tail);
        void tail.then(() => {
            if (sendTails.get(key) === tail) sendTails.delete(key);
        });
        return queued;
    };

    const cancelStaleOutgoingTranslations = () => {
        const state = useChatTranslatorSettings.getState();
        const currentSignature = getSentTranslationRequestSignatureFromValues(state.sentInput, state.sentOutput);

        for (const pending of pendingTranslations) {
            if (
                pending.requestSignature === currentSignature
                && (
                    pending.manual
                    || (
                        getSentAutoTranslateChannelState(pending.channelId)
                        && !shouldSkipSentMessage(pending.content)
                    )
                )
            ) continue;

            pending.cancelled = true;
            pending.cancel();
            pending.release();
            pendingTranslations.delete(pending);
        }
    };

    const unpatch = instead("sendMessage", Messages, (args, original) => {
        const payload = args[1] as OutgoingMessagePayload | undefined;
        const content = payload?.content;
        const channelId = getOutgoingChannelId(args, payload);
        if (!active) return enqueueSend(channelId, markInvoked => {
            markInvoked();
            return original(...args);
        });

        const requestLifecycle = lifecycle;
        const manualRequested = isManualTranslateNextSendEnabled();

        if (typeof content !== "string") {
            return enqueueSend(channelId, markInvoked => {
                markInvoked();
                return original(...args);
            });
        }

        const manualSkipReason = manualRequested ? getManualSentSkipReason(content) : null;
        const shouldManualTranslate = manualRequested && !manualSkipReason;
        const shouldAutoTranslate = getSentAutoTranslateChannelState(channelId) && !shouldSkipSentMessage(content);

        if (manualRequested && (content.trim() || manualSkipReason)) {
            consumeManualTranslateNextSend();
        }

        if (!shouldAutoTranslate && !shouldManualTranslate) {
            if (manualSkipReason) showTranslationToast(manualSkipReason);
            return enqueueSend(channelId, markInvoked => {
                markInvoked();
                return original(...args);
            });
        }

        switchDeepLToGoogleIfApiKeyMissing();
        const state = useChatTranslatorSettings.getState();
        const sourceLang = state.sentInput;
        const targetLang = state.sentOutput;
        const requestSignature = getSentTranslationRequestSignatureFromValues(sourceLang, targetLang);
        const request = translationRequestCoordinator.acquire(
            makeTranslationRequestKey("sent", requestSignature, content),
            signal => trackTranslationExecution(reportRequestCompletion => (
                translate("sent", content, {
                    ignoreConfidenceRequirement: true,
                    reportRequestCompletion,
                    signal,
                    sourceLang,
                    targetLang,
                })
            )),
            "interactive"
        );
        let cancel: () => void = () => undefined;
        const cancellation = new Promise<void>(resolve => {
            cancel = resolve;
        });
        const pending: PendingOutgoingTranslation = {
            cancel,
            cancelled: false,
            channelId,
            content,
            manual: shouldManualTranslate,
            release: request.release,
            requestSignature,
        };
        pendingTranslations.add(pending);
        let preparedTranslation: string | null = null;

        const prepare = async () => {
            try {
                const result = await Promise.race([
                    request.promise.then(translated => ({ translated })),
                    cancellation.then(() => null),
                ]);
                if (!result) return;

                const { translated } = result;
                const currentState = useChatTranslatorSettings.getState();
                const currentSignature = getSentTranslationRequestSignatureFromValues(
                    currentState.sentInput,
                    currentState.sentOutput
                );
                const stale = pending.cancelled
                    || !active
                    || lifecycle !== requestLifecycle
                    || currentSignature !== requestSignature
                    || (!shouldManualTranslate && !getSentAutoTranslateChannelState(channelId));
                if (stale) return;

                const translatedText = translated.text.trim();
                if (translatedText && translatedText !== content.trim()) {
                    preparedTranslation = translatedText;
                }
            } catch (error) {
                if (
                    !pending.cancelled
                    && active
                    && lifecycle === requestLifecycle
                    && !isTranslationAbortError(error)
                ) {
                    const reason = normalizeTranslationFailureReason(error);
                    logger.warn("[ChatTranslator] Failed to translate outgoing message:", reason);
                    showTranslationToast(reason);
                }
            } finally {
                pendingTranslations.delete(pending);
                request.release();
            }
        };
        const prepared = prepare();

        return enqueueSend(channelId, async markInvoked => {
            await prepared;

            const currentState = useChatTranslatorSettings.getState();
            const currentSignature = getSentTranslationRequestSignatureFromValues(
                currentState.sentInput,
                currentState.sentOutput
            );
            const translatedContent = preparedTranslation
                && active
                && lifecycle === requestLifecycle
                && currentSignature === requestSignature
                && (
                    shouldManualTranslate
                    || (
                        getSentAutoTranslateChannelState(channelId)
                        && !shouldSkipSentMessage(content)
                    )
                )
                ? preparedTranslation
                : null;

            if (translatedContent) {
                args[1] = {
                    ...payload,
                    content: translatedContent,
                };
            }

            markInvoked();
            const shouldShowToast = translatedContent
                && active
                && lifecycle === requestLifecycle
                && (useChatTranslatorSettings.getState().showAutoTranslateToast || shouldManualTranslate);
            const result = original(...args);
            if (shouldShowToast) {
                showTranslationToast(shouldManualTranslate ? "Translated this outgoing message" : "Translated outgoing message");
            }
            return result;
        });
    });

    const cancelPendingTranslations = () => {
        for (const pending of pendingTranslations) {
            pending.cancelled = true;
            pending.cancel();
            pending.release();
        }
        pendingTranslations.clear();
    };

    const unpatchWhenDrained = (stoppedLifecycle: number) => {
        const tails = [...sendTails.values()];
        void Promise.allSettled(tails).then(() => {
            if (active || disposed || lifecycle !== stoppedLifecycle) return;
            if (sendTails.size) {
                unpatchWhenDrained(stoppedLifecycle);
                return;
            }

            disposed = true;
            try {
                unpatch();
            } catch (error) {
                logger.error(
                    "[ChatTranslator] Failed to remove outgoing message patch",
                    error instanceof Error ? error.name : "UnknownError"
                );
            } finally {
                if (installedSendMessagePatch === runtime) installedSendMessagePatch = null;
            }
        });
    };

    const activate = () => {
        if (disposed || active) return () => false;

        active = true;
        const activeLifecycle = ++lifecycle;
        try {
            unsubscribeSettings = useChatTranslatorSettings.subscribe(cancelStaleOutgoingTranslations);
        } catch (error) {
            active = false;
            disposed = true;
            lifecycle++;
            try {
                unpatch();
            } finally {
                if (installedSendMessagePatch === runtime) installedSendMessagePatch = null;
            }
            throw error;
        }
        let stopped = false;

        return () => {
            if (stopped || !active || lifecycle !== activeLifecycle) return false;
            stopped = true;
            active = false;
            const stoppedLifecycle = ++lifecycle;
            try {
                unsubscribeSettings?.();
            } catch (error) {
                logger.error(
                    "[ChatTranslator] Failed to remove outgoing settings subscription",
                    error instanceof Error ? error.name : "UnknownError"
                );
            } finally {
                unsubscribeSettings = null;
            }
            cancelPendingTranslations();
            unpatchWhenDrained(stoppedLifecycle);
            return true;
        };
    };

    const runtime = { activate };
    return runtime;
}

export default function patchSendMessage() {
    const Messages = findByProps("sendMessage", "startEditMessage")
        ?? findByProps("sendMessage", "receiveMessage");
    if (!Messages?.sendMessage) return () => false;

    installedSendMessagePatch ??= installSendMessagePatch(Messages);
    return installedSendMessagePatch.activate();
}
