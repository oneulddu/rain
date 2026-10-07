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
    clearReceivedLanguageOverrides,
    DiscordMessage,
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
    setReceivedLanguagesForChannel,
    toggleReceivedAutoTranslateChannelState,
} from "../utils";
import { getRenderTarget } from "./renderTarget";

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
const MAX_LAZY_ACTION_SHEET_PATCHES = 4;
type DynamicPatch = () => unknown;

interface MessageActionSheetProps {
    message?: DiscordMessage;
    msg?: { message?: DiscordMessage };
}

function safelyUnpatchDynamic(unpatch: DynamicPatch) {
    try {
        unpatch();
    } catch (error) {
        logger.warn(
            "[ChatTranslator] Failed to remove a message action-sheet patch:",
            error instanceof Error ? error.name : "UnknownError"
        );
    }
}

function makeIcon(source: number | void) {
    if (!source || !ActionSheetRow?.Icon) return undefined;
    return <ActionSheetRow.Icon source={source} />;
}

function showMoreOptions({ authorId, channelId, guildId }: {
    authorId?: string;
    channelId?: string;
    guildId?: string;
}, schedule: (callback: () => void, delay: number) => void, isActive: () => boolean) {
    if (!showSimpleActionSheet) {
        showToast("More ChatTranslator options are not available on this Discord build.", LanguageIcon);
        return;
    }

    LazyActionSheet?.hideActionSheet?.();

    schedule(() => {
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
                        setReceivedLanguagesForChannel(channelId, "auto", "ko");
                        showToast("This channel will translate to Korean", LanguageIcon);
                        hideActionSheet?.();
                    },
                },
                {
                    label: "Use Global Languages",
                    onPress: () => {
                        clearReceivedLanguageOverrides(channelId);
                        showToast("Channel language overrides cleared", RetryIcon);
                        hideActionSheet?.();
                    },
                },
                {
                    label: "Clear Channel Cache",
                    onPress: async () => {
                        const cleared = await clearChannelTranslationCache(channelId);
                        if (!isActive()) return;
                        showToast(
                            cleared ? "Channel translation cache cleared" : "Could not persist the channel cache change",
                            cleared ? CheckIcon : LanguageIcon
                        );
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

    let active = true;
    let currentMessage: DiscordMessage | null = null;
    const dynamicPatches = new Map<object, DynamicPatch>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const schedule = (callback: () => void, delay: number) => {
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (active) callback();
        }, delay);
        timers.add(timer);
    };
    const unpatchOpen = before("openLazy", LazyActionSheet, ([component, key, msg]) => {
        if (key !== "MessageLongPressActionSheet") return;

        const message = msg?.message;
        currentMessage = message?.id ? message : null;
        if (!currentMessage) return;

        void Promise.resolve(component).then((instance: any) => {
            if (!active || !instance || dynamicPatches.has(instance)) return;

            const renderTarget = getRenderTarget(instance);
            if (!renderTarget) return;

            const unpatch = after(renderTarget.key, renderTarget.target, (args, res) => {
                try {
                    const props = args[0] as MessageActionSheetProps | undefined;
                    const message = props?.message ?? props?.msg?.message ?? currentMessage;
                    if (!message?.id) return;
                    const messageId = message.id;

                    const buttons = findInReactTree(
                        res,
                        x => Array.isArray(x) && x.some(c => c?.type?.name === "ActionSheetRow"),
                    );
                    if (!buttons || buttons.some((button: any) => String(button?.key).startsWith("chat-translator-"))) return;

                    const content = getMessageContent(message);
                    const canTranslate = !!content && hasMeaningfulTextForTranslation(content);
                    const channelId = getMessageChannelId(message);
                    const guildId = getMessageGuildId(message, channelId);
                    const translatedView = getTranslatedMessageView(messageId);
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
                                            const result = toggleTranslatedMessageView(messageId);
                                            showToast(result.ok
                                                ? translatedView === "translation" ? "Showing original message" : "Showing translation"
                                                : result.reason ?? "Nothing to toggle", RetryIcon);
                                            return;
                                        }

                                        if (canTryRestoreOriginal) {
                                            const result = restoreMessageOriginalFromCache(message);
                                            if (result.ok || !canTranslate) {
                                                showToast(result.ok ? "Showing original message" : result.reason ?? "Original is not available", RetryIcon);
                                                return;
                                            }
                                        }

                                        const result = await translateAndReplaceMessage(message, { manual: true });
                                        if (!active) return;
                                        showToast(result.ok ? "Translated message" : result.reason ?? "Failed to translate", LanguageIcon);
                                    } catch (error) {
                                        if (!active) return;
                                        logger.error(
                                            "[ChatTranslator] Failed to translate message",
                                            error instanceof Error ? error.name : "UnknownError"
                                        );
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
                                    showMoreOptions({ authorId, channelId, guildId }, schedule, () => active);
                                }}
                            />,
                        );
                    }

                    buttons.unshift(...chatTranslatorRows);
                } catch (error) {
                    logger.error(
                        "[ChatTranslator] Failed to render message action-sheet controls",
                        error instanceof Error ? error.name : "UnknownError"
                    );
                }
            });
            dynamicPatches.set(instance, unpatch);
            while (dynamicPatches.size > MAX_LAZY_ACTION_SHEET_PATCHES) {
                const oldest = dynamicPatches.entries().next();
                if (oldest.done) break;

                safelyUnpatchDynamic(oldest.value[1]);
                dynamicPatches.delete(oldest.value[0]);
            }
        }).catch((error: unknown) => {
            if (active) {
                logger.warn(
                    "[ChatTranslator] Message action sheet failed to load:",
                    error instanceof Error ? error.name : "UnknownError"
                );
            }
        });
    });

    return () => {
        active = false;
        safelyUnpatchDynamic(unpatchOpen);
        currentMessage = null;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        for (const unpatch of dynamicPatches.values()) {
            safelyUnpatchDynamic(unpatch);
        }
        dynamicPatches.clear();
        return true;
    };
}
