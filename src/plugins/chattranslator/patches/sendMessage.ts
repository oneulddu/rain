import { findAssetId } from "@api/assets";
import { instead } from "@api/patcher";
import { showToast } from "@api/ui/toasts";
import { logger } from "@lib/utils/logger";
import { findByProps } from "@metro";

import {
    consumeManualTranslateNextSend,
    isManualTranslateNextSendEnabled,
} from "../state";
import { useChatTranslatorSettings } from "../storage";
import {
    getAutomaticTranslationSkipReason,
    getManualTranslationBlockReason,
    getSentAutoTranslateChannelState,
    hasMeaningfulTextForTranslation,
    normalizeTranslationFailureReason,
    translate,
} from "../utils";

const Messages = findByProps("sendMessage", "receiveMessage");
const LanguageIcon = findAssetId("LanguageIcon");

function shouldSkipSentMessage(content: string): boolean {
    if (!content || !hasMeaningfulTextForTranslation(content)) return true;
    if (content.trim().startsWith("/")) return true;

    return !!getAutomaticTranslationSkipReason(content);
}

function getManualSentSkipReason(content: string): string | null {
    if (!content || content.trim().startsWith("/")) return "Skipped: commands are not translated";

    return getManualTranslationBlockReason(content)?.reason ?? null;
}

function getOutgoingChannelId(args: any[], payload: any): string | undefined {
    return typeof args[0] === "string"
        ? args[0]
        : payload?.channel_id ?? payload?.channelId;
}

export default function patchSendMessage() {
    if (!Messages?.sendMessage) return () => false;

    return instead("sendMessage", Messages, async (args, original) => {
        const state = useChatTranslatorSettings.getState();
        const payload = args[1];
        const content = payload?.content;
        const channelId = getOutgoingChannelId(args, payload);
        const manualRequested = isManualTranslateNextSendEnabled();

        if (typeof content !== "string") {
            return original(...args);
        }

        const manualSkipReason = manualRequested ? getManualSentSkipReason(content) : null;
        const shouldManualTranslate = manualRequested && !manualSkipReason;
        const shouldAutoTranslate = getSentAutoTranslateChannelState(channelId) && !shouldSkipSentMessage(content);

        if (manualRequested && (content.trim() || manualSkipReason)) {
            consumeManualTranslateNextSend();
        }

        if (!shouldAutoTranslate && !shouldManualTranslate) {
            if (manualSkipReason) showToast(manualSkipReason, LanguageIcon);
            return original(...args);
        }

        try {
            const translated = await translate("sent", content, { ignoreConfidenceRequirement: true });
            const translatedText = translated.text.trim();

            if (translatedText && translatedText !== content.trim()) {
                args[1] = {
                    ...payload,
                    content: translatedText,
                };

                if (state.showAutoTranslateToast || shouldManualTranslate) {
                    showToast(shouldManualTranslate ? "Translated this outgoing message" : "Translated outgoing message", LanguageIcon);
                }
            }
        } catch (error) {
            logger.error("[ChatTranslator] Failed to translate outgoing message", error);
            showToast(normalizeTranslationFailureReason(error), LanguageIcon);
        }

        return original(...args);
    });
}
