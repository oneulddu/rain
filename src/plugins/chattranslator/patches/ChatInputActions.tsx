import { findAssetId } from "@api/assets";
import { after } from "@api/patcher";
import { showToast } from "@api/ui/toasts";
import { findByDisplayName, findByName, findByTypeDisplayName } from "@metro";
import { FluxUtils, React, ReactNative } from "@metro/common";
import { findByStoreName } from "@metro/wrappers";
import type { ReactElement, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

import { openChatTranslatorSettings } from "../settings/openSettings";
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
import { showInputOptions } from "./inputOptions";
import { getRenderTarget } from "./renderTarget";

const LanguageIcon = findAssetId("LanguageIcon");
const { Image, Pressable, StyleSheet, Text, View } = ReactNative;
const SelectedChannelStore = findByStoreName("SelectedChannelStore");

function getSelectedChannelId(): string | undefined {
    return SelectedChannelStore?.getChannelId?.()
        ?? SelectedChannelStore?.getCurrentlySelectedChannelId?.();
}

function showChannelUnavailableToast() {
    showToast("Current channel is unavailable.", LanguageIcon);
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
    const openSettingsPage = () => setTimeout(openChatTranslatorSettings, 120);
    const showOptions = () => {
        const manualEnabled = isManualTranslateNextSendEnabled();
        const channelId = getSelectedChannelId();
        const channelReceivedEnabled = getReceivedAutoTranslateChannelState(channelId);
        const channelSentEnabled = getSentAutoTranslateChannelState(channelId);

        showInputOptions([
            {
                label: channelReceivedEnabled ? "Turn off received auto translate here" : "Turn on received auto translate here",
                subLabel: "Only changes this channel.",
                onPress: () => {
                    if (!channelId) {
                        showChannelUnavailableToast();
                        return;
                    }

                    showReceivedAutoTranslateToast(toggleReceivedAutoTranslateChannelState(channelId));
                },
            },
            {
                label: channelSentEnabled ? "Turn off outgoing auto translate here" : "Turn on outgoing auto translate here",
                subLabel: "Only changes this channel.",
                onPress: () => {
                    if (!channelId) {
                        showChannelUnavailableToast();
                        return;
                    }

                    showSentAutoTranslateToast(toggleSentAutoTranslateChannelState(channelId));
                },
            },
            {
                label: manualEnabled ? "Cancel one-time send translation" : "Translate next message once",
                onPress: () => {
                    const next = toggleManualTranslateNextSend();

                    showToast(next ? "Next sent message will be translated" : "Manual send translation cancelled", LanguageIcon);
                },
            },
            {
                label: "Open ChatTranslator settings",
                onPress: openSettingsPage,
            },
        ]);
    };

    return (
        <View style={{ alignSelf: "stretch", width: 40 }}>
            <Pressable
                accessibilityLabel="ChatTranslator"
                accessibilityRole="button"
                accessibilityHint="Long press for translation options"
                onPressIn={() => { ignoreNextPress.current = false; }}
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
                style={({ pressed }: { pressed: boolean }) => ({
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: pressed ? 0.6 : 1,
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: 0,
                    right: 0,
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
        </View>
    );
}

export default function patchChatInputActions() {
    const module = findByTypeDisplayName("ChatInputActions", false)
        ?? findByDisplayName("ChatInputActions", false)
        ?? findByName("ChatInputActions", false);
    const renderTarget = getRenderTarget(module);
    if (!renderTarget) return () => false;

    return after(renderTarget.key, renderTarget.target, (_, ret) => {
        // Discord returns a Fragment containing the native action row. A Fragment
        // cannot lay out children, so append inside that row without changing it.
        let inserted = false;
        function insertIntoRow(node: ReactNode): ReactNode {
            if (inserted) return node;
            if (Array.isArray(node)) return node.map(insertIntoRow);
            if (!React.isValidElement(node)) return node;

            const element = node as ReactElement<{ children?: ReactNode; style?: StyleProp<ViewStyle> }>;
            if (element.type === React.Fragment) {
                const children = insertIntoRow(element.props.children);
                return inserted ? React.cloneElement(element, null, children) : node;
            }
            if (element.type !== View || StyleSheet.flatten(element.props.style)?.flexDirection !== "row") return node;

            inserted = true;
            return React.cloneElement(
                element,
                null,
                element.props.children,
                React.createElement(ChatTranslatorInputAction, { key: "chat-translator-input-action" }),
            );
        }

        return insertIntoRow(ret);
    });
}
