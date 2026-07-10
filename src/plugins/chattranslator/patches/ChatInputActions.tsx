import { findAssetId } from "@api/assets";
import { after } from "@api/patcher";
import { showToast } from "@api/ui/toasts";
import { findByProps, findByTypeDisplayName } from "@metro";
import { FluxUtils, NavigationNative, React, ReactNative } from "@metro/common";
import { findByPropsLazy, findByStoreName } from "@metro/wrappers";

import ChatTranslatorSettings from "../settings";
import {
    isManualTranslateNextSendEnabled,
    subscribeManualTranslateNextSend,
    toggleManualTranslateNextSend,
} from "../state";
import { useChatTranslatorSettings } from "../storage";
import {
    getReceivedAutoTranslateChannelState,
    getSentAutoTranslateChannelState,
    toggleReceivedAutoTranslateChannelState,
    toggleSentAutoTranslateChannelState,
} from "../utils";

const ChatInputActions = findByTypeDisplayName("ChatInputActions");
const LanguageIcon = findAssetId("LanguageIcon");
const { Image, Pressable, Text, View } = ReactNative;
const showSimpleActionSheet = findByProps("showSimpleActionSheet")?.showSimpleActionSheet;
const hideActionSheet = findByProps("openLazy", "hideActionSheet")?.hideActionSheet;
const rootNavigationRef = findByPropsLazy("getRootNavigationRef");
const SelectedChannelStore = findByStoreName("SelectedChannelStore");

function getSelectedChannelId(): string | undefined {
    return SelectedChannelStore?.getChannelId?.()
        ?? SelectedChannelStore?.getCurrentlySelectedChannelId?.();
}

function showChannelUnavailableToast(shouldHideActionSheet = false) {
    showToast("Current channel is unavailable.", LanguageIcon);
    if (shouldHideActionSheet) hideActionSheet?.();
}

function showReceivedAutoTranslateToast(enabled: boolean) {
    showToast(
        enabled
            ? "Received auto translate enabled for this channel"
            : "Received auto translate disabled for this channel",
        LanguageIcon
    );
}

function showSentAutoTranslateToast(enabled: boolean) {
    showToast(
        enabled
            ? "Outgoing auto translate enabled for this channel"
            : "Outgoing auto translate disabled for this channel",
        LanguageIcon
    );
}

function useManualTranslateNextSend() {
    const [enabled, setEnabled] = React.useState(isManualTranslateNextSendEnabled());

    React.useEffect(() => subscribeManualTranslateNextSend(() => {
        setEnabled(isManualTranslateNextSendEnabled());
    }), []);

    return enabled;
}

function ChatTranslatorInputAction() {
    const navigation = NavigationNative.useNavigation();
    const settings = useChatTranslatorSettings();
    const manualNextSend = useManualTranslateNextSend();
    const ignoreNextPress = React.useRef(false);
    const selectedChannelId = FluxUtils?.useStateFromStores?.(
        [SelectedChannelStore],
        getSelectedChannelId
    ) ?? getSelectedChannelId();
    const channelReceivedAuto = selectedChannelId
        ? (settings.receivedChannelOverrides ?? {})[selectedChannelId] ?? settings.autoTranslateReceived
        : settings.autoTranslateReceived;
    const channelSentAuto = selectedChannelId
        ? (settings.sentChannelOverrides ?? {})[selectedChannelId] ?? settings.autoTranslate
        : settings.autoTranslate;
    const active = channelReceivedAuto || channelSentAuto || manualNextSend;
    const openSettingsPage = () => {
        hideActionSheet?.();

        setTimeout(() => {
            const rootNavigation = rootNavigationRef?.getRootNavigationRef?.();
            const pageParams = {
                title: "ChatTranslator",
                render: ChatTranslatorSettings,
            };

            if (rootNavigation?.navigate) {
                rootNavigation.navigate("main", {
                    screen: "settings",
                    params: {
                        screen: "RAIN_CUSTOM_PAGE",
                        params: pageParams,
                    },
                });
                return;
            }

            if (navigation?.navigate) {
                navigation.navigate("RAIN_CUSTOM_PAGE", pageParams);
                return;
            }

            if (navigation?.push) {
                navigation.push("RAIN_CUSTOM_PAGE", pageParams);
                return;
            }

            showToast("Could not open ChatTranslator settings.", LanguageIcon);
        }, 120);
    };
    const showOptions = () => {
        if (!showSimpleActionSheet) {
            showToast("ChatTranslator options are not available on this Discord build.", LanguageIcon);
            return;
        }

        const manualEnabled = isManualTranslateNextSendEnabled();
        const channelId = getSelectedChannelId();
        const channelReceivedEnabled = getReceivedAutoTranslateChannelState(channelId);
        const channelSentEnabled = getSentAutoTranslateChannelState(channelId);

        showSimpleActionSheet({
            key: "ChatTranslatorInputOptions",
            header: { title: "ChatTranslator" },
            options: [
                {
                    label: channelReceivedEnabled ? "Turn off received auto translate here" : "Turn on received auto translate here",
                    subLabel: "Only changes this channel.",
                    onPress: () => {
                        if (!channelId) {
                            showChannelUnavailableToast(true);
                            return;
                        }

                        showReceivedAutoTranslateToast(toggleReceivedAutoTranslateChannelState(channelId));
                        hideActionSheet?.();
                    },
                },
                {
                    label: channelSentEnabled ? "Turn off outgoing auto translate here" : "Turn on outgoing auto translate here",
                    subLabel: "Only changes this channel.",
                    onPress: () => {
                        if (!channelId) {
                            showChannelUnavailableToast(true);
                            return;
                        }

                        showSentAutoTranslateToast(toggleSentAutoTranslateChannelState(channelId));
                        hideActionSheet?.();
                    },
                },
                {
                    label: manualEnabled ? "Cancel one-time send translation" : "Translate next message once",
                    onPress: () => {
                        const next = toggleManualTranslateNextSend();

                        showToast(next ? "Next sent message will be translated" : "Manual send translation cancelled", LanguageIcon);
                        hideActionSheet?.();
                    },
                },
                {
                    label: "Open ChatTranslator settings",
                    onPress: openSettingsPage,
                },
            ],
        });
    };

    return (
        <Pressable
            accessibilityLabel="ChatTranslator"
            onPress={() => {
                if (ignoreNextPress.current) {
                    ignoreNextPress.current = false;
                    return;
                }

                const channelId = getSelectedChannelId();

                if (!channelId) {
                    showChannelUnavailableToast();
                    return;
                }

                showReceivedAutoTranslateToast(toggleReceivedAutoTranslateChannelState(channelId));
            }}
            onLongPress={() => {
                ignoreNextPress.current = true;
                showOptions();
            }}
            onPressOut={() => {
                if (ignoreNextPress.current) {
                    setTimeout(() => {
                        ignoreNextPress.current = false;
                    }, 0);
                }
            }}
            style={({ pressed }: { pressed: boolean }) => ({
                alignItems: "center",
                height: 40,
                justifyContent: "center",
                marginLeft: 4,
                opacity: pressed ? 0.6 : 1,
                width: 40,
            })}
        >
            <View
                style={{
                    alignItems: "center",
                    backgroundColor: active ? "rgba(88, 101, 242, 0.2)" : "rgba(255, 255, 255, 0.08)",
                    borderColor: manualNextSend ? "rgba(87, 242, 135, 0.9)" : active ? "rgba(88, 101, 242, 0.75)" : "rgba(255, 255, 255, 0.12)",
                    borderRadius: 18,
                    borderWidth: 1,
                    height: 36,
                    justifyContent: "center",
                    width: 36,
                }}
            >
                <Image
                    resizeMode="contain"
                    source={LanguageIcon}
                    style={{
                        height: 20,
                        opacity: active ? 1 : 0.72,
                        tintColor: active ? "#5865f2" : "#b5bac1",
                        width: 20,
                    }}
                />
                {manualNextSend && (
                    <View
                        style={{
                            alignItems: "center",
                            backgroundColor: "#57f287",
                            borderRadius: 7,
                            height: 14,
                            justifyContent: "center",
                            position: "absolute",
                            right: -2,
                            top: -2,
                            width: 18,
                        }}
                    >
                        <Text style={{ color: "#111318", fontSize: 9, fontWeight: "700" }}>1x</Text>
                    </View>
                )}
            </View>
        </Pressable>
    );
}

export default function patchChatInputActions() {
    if (!ChatInputActions?.type) return () => false;

    return after("render", ChatInputActions.type, (_, ret) => React.createElement(
        View,
        { style: { alignItems: "center", flexDirection: "row" } },
        ret,
        React.createElement(ChatTranslatorInputAction)
    ));
}
