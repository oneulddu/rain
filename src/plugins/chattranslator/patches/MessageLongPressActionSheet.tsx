import { findAssetId } from "@api/assets";
import { after, before } from "@api/patcher";
import { showToast } from "@api/ui/toasts";
import { findInReactTree } from "@lib/utils";
import { logger } from "@lib/utils/logger";
import { findByProps } from "@metro";
import { React } from "@metro/common";

import {
    clearChannelTranslationCache,
    getTranslatedMessageView,
    restoreMessageOriginalFromCache,
    toggleTranslatedMessageView,
    translateAndReplaceMessage,
} from "../state";
import {
    clearReceivedAutoTranslateChannelOverride,
    clearReceivedInputLanguageOverride,
    clearReceivedOutputLanguageOverride,
    getMessageChannelId,
    getMessageContent,
    getMessageGuildId,
    getReceivedAutoTranslateChannelState,
    hasMeaningfulTextForTranslation,
    hasReceivedAutoTranslateChannelOverride,
    isIgnoredChannel,
    isIgnoredGuild,
    isIgnoredUser,
    setIgnoredChannel,
    setIgnoredGuild,
    setIgnoredUser,
    setReceivedInputLanguageForChannel,
    setReceivedOutputLanguageForChannel,
    toggleReceivedAutoTranslateChannelState,
} from "../utils";

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow;
const showSimpleActionSheet = findByProps("showSimpleActionSheet")?.showSimpleActionSheet;
const hideActionSheet = findByProps("openLazy", "hideActionSheet")?.hideActionSheet;
const LanguageIcon = findAssetId("LanguageIcon");
const RetryIcon = findAssetId("ic_message_retry");
const ChannelIcon = findAssetId("ChannelIcon");
const UserIcon = findAssetId("ic_profile_24px");
const ServerIcon = findAssetId("ic_guild_badge");
const CheckIcon = findAssetId("Check");

function makeIcon(source: number | void) {
    if (!source || !ActionSheetRow?.Icon) return undefined;
    return <ActionSheetRow.Icon source={source} />;
}

function showMoreOptions({ authorId, channelId, guildId }: {
    authorId?: string;
    channelId?: string;
    guildId?: string;
}) {
    if (!showSimpleActionSheet) {
        showToast("More ChatTranslator options are not available on this Discord build.", LanguageIcon);
        return;
    }

    LazyActionSheet?.hideActionSheet?.();

    setTimeout(() => {
        const options = [];
        const channelHasOverride = channelId ? hasReceivedAutoTranslateChannelOverride(channelId) : false;

        if (channelId) {
            if (channelHasOverride) {
                options.push({
                    label: "Use Global Auto Setting",
                    onPress: () => {
                        clearReceivedAutoTranslateChannelOverride(channelId);
                        showToast("Channel override cleared", ChannelIcon);
                        hideActionSheet?.();
                    },
                });
            }

            options.push(
                {
                    label: isIgnoredChannel(channelId) ? "Auto Translate This Channel Again" : "Ignore This Channel",
                    onPress: () => {
                        const nextIgnored = !isIgnoredChannel(channelId);

                        setIgnoredChannel(channelId, nextIgnored);
                        showToast(nextIgnored ? "Channel ignored for auto translate" : "Channel unignored for auto translate", ChannelIcon);
                        hideActionSheet?.();
                    },
                },
                {
                    label: "Translate Channel to Korean",
                    onPress: () => {
                        setReceivedInputLanguageForChannel(channelId, "auto");
                        setReceivedOutputLanguageForChannel(channelId, "ko");
                        showToast("This channel will translate to Korean", LanguageIcon);
                        hideActionSheet?.();
                    },
                },
                {
                    label: "Use Global Languages",
                    onPress: () => {
                        clearReceivedInputLanguageOverride(channelId);
                        clearReceivedOutputLanguageOverride(channelId);
                        showToast("Channel language overrides cleared", RetryIcon);
                        hideActionSheet?.();
                    },
                },
                {
                    label: "Clear Channel Cache",
                    onPress: () => {
                        clearChannelTranslationCache(channelId);
                        showToast("Channel translation cache cleared", CheckIcon);
                        hideActionSheet?.();
                    },
                },
            );
        }

        if (guildId) {
            options.push({
                label: isIgnoredGuild(guildId) ? "Auto Translate This Server Again" : "Ignore This Server",
                onPress: () => {
                    const nextIgnored = !isIgnoredGuild(guildId);

                    setIgnoredGuild(guildId, nextIgnored);
                    showToast(nextIgnored ? "Server ignored for auto translate" : "Server unignored for auto translate", ServerIcon || ChannelIcon);
                    hideActionSheet?.();
                },
            });
        }

        if (authorId) {
            options.push({
                label: isIgnoredUser(authorId) ? "Auto Translate This User Again" : "Ignore This User",
                onPress: () => {
                    const nextIgnored = !isIgnoredUser(authorId);

                    setIgnoredUser(authorId, nextIgnored);
                    showToast(nextIgnored ? "User ignored for auto translate" : "User unignored for auto translate", UserIcon);
                    hideActionSheet?.();
                },
            });
        }

        showSimpleActionSheet({
            key: "ChatTranslatorMessageMoreOptions",
            header: { title: "ChatTranslator Options" },
            options,
        });
    }, 80);
}

export default function patchMessageLongPressActionSheet() {
    if (!LazyActionSheet?.openLazy || !ActionSheetRow) return () => false;

    return before("openLazy", LazyActionSheet, ([component, key, msg]) => {
        if (key !== "MessageLongPressActionSheet") return;

        const message = msg?.message;
        if (!message?.id) return;

        component.then((instance: any) => {
            const unpatch = after("default", instance, (_, res) => {
                React.useEffect(() => () => {
                    unpatch();
                }, []);

                const buttons = findInReactTree(
                    res,
                    x => Array.isArray(x) && x.some(c => c?.type?.name === "ActionSheetRow"),
                );
                if (!buttons || buttons.some((button: any) => String(button?.key).startsWith("chat-translator-"))) return;

                const content = getMessageContent(message);
                const canTranslate = !!content && hasMeaningfulTextForTranslation(content);
                const channelId = getMessageChannelId(message);
                const guildId = getMessageGuildId(message, channelId);
                const translatedView = getTranslatedMessageView(message.id);
                const canTryRestoreOriginal = /(?:Translated from|`[^`]+ → [^`]+`\s*$)/.test(content.trim());
                const autoEnabled = getReceivedAutoTranslateChannelState(channelId);
                const hasOverride = hasReceivedAutoTranslateChannelOverride(channelId);
                const authorId = message.author?.id;
                const chatTranslatorRows = [];

                if (translatedView || canTranslate || canTryRestoreOriginal) {
                    chatTranslatorRows.push(
                        <ActionSheetRow
                            key="chat-translator-message"
                            label={translatedView === "translation"
                                ? "Show Original"
                                : translatedView === "original"
                                    ? "Show Translation"
                                    : "Translate Message"}
                            icon={makeIcon(translatedView ? RetryIcon : LanguageIcon)}
                            onPress={async () => {
                                LazyActionSheet?.hideActionSheet?.();

                                try {
                                    if (translatedView) {
                                        const result = toggleTranslatedMessageView(message.id);
                                        showToast(result.ok
                                            ? translatedView === "translation" ? "Showing original message" : "Showing translation"
                                            : result.reason ?? "Nothing to toggle", RetryIcon);
                                        return;
                                    }

                                    if (!canTranslate && canTryRestoreOriginal) {
                                        const result = restoreMessageOriginalFromCache(message);
                                        showToast(result.ok ? "Showing original message" : result.reason ?? "Original is not available", RetryIcon);
                                        return;
                                    }

                                    const result = await translateAndReplaceMessage(message, { manual: true });
                                    showToast(result.ok ? "Translated message" : result.reason ?? "Failed to translate", LanguageIcon);
                                } catch (error) {
                                    logger.error("[ChatTranslator] Failed to translate message", error);
                                    showToast("Failed to translate message", LanguageIcon);
                                }
                            }}
                        />,
                    );
                }

                if (channelId) {
                    chatTranslatorRows.push(
                        <ActionSheetRow
                            key="chat-translator-channel-auto"
                            label={autoEnabled ? "Disable Auto Translate Here" : "Enable Auto Translate Here"}
                            subLabel={hasOverride ? "Channel override" : "Using global default"}
                            icon={makeIcon(ChannelIcon)}
                            onPress={() => {
                                LazyActionSheet?.hideActionSheet?.();
                                const next = toggleReceivedAutoTranslateChannelState(channelId);

                                showToast(next ? "Auto translate enabled for this channel" : "Auto translate disabled for this channel", ChannelIcon);
                            }}
                        />,
                    );
                }

                if (channelId || guildId || authorId) {
                    chatTranslatorRows.push(
                        <ActionSheetRow
                            key="chat-translator-more-options"
                            label="More ChatTranslator Options"
                            subLabel="Ignore, language, cache"
                            icon={makeIcon(LanguageIcon)}
                            onPress={() => {
                                showMoreOptions({ authorId, channelId, guildId });
                            }}
                        />,
                    );
                }

                buttons.unshift(...chatTranslatorRows);
            });
        });
    });
}
