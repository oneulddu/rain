import { findAssetId } from "@api/assets";
import { showToast } from "@api/ui/toasts";
import { logger } from "@lib/utils/logger";
import { findByName, findByProps } from "@metro";
import { React } from "@metro/common";
import { CustomPageRenderer } from "@plugins/_core/settings/patches/shared";

import ChatTranslatorSettings from ".";

export function openChatTranslatorSettings() {
    try {
        // Like ViewRaw, open a component from chat instead of navigating to a
        // route that only exists inside Discord's settings navigator.
        const navigation = findByProps("push", "pushLazy", "pop");
        const Navigator = findByName("Navigator") ?? findByProps("Navigator")?.Navigator;
        if (typeof navigation?.push !== "function" || !Navigator) {
            throw new Error("Chat settings navigator unavailable");
        }
        const closeButton = findByProps("getRenderCloseButton")?.getRenderCloseButton
            ?? findByProps("getHeaderCloseButton")?.getHeaderCloseButton;

        const SettingsNavigator = () => (
            <Navigator
                initialRouteName="ChatTranslatorSettings"
                goBackOnBackPress
                screens={{
                    ChatTranslatorSettings: {
                        title: "ChatTranslator",
                        headerLeft: closeButton?.(() => navigation.pop()),
                        render: () => <ChatTranslatorSettings />,
                    },
                    // Language selectors inside the existing settings page use
                    // this route, so register it in the new navigator as well.
                    RAIN_CUSTOM_PAGE: {
                        render: () => <CustomPageRenderer />,
                    },
                }}
            />
        );

        navigation.push(SettingsNavigator);
    } catch (error) {
        logger.error("[ChatTranslator] Could not open settings from chat", error);
        showToast("Could not open ChatTranslator settings. Try the plugin's settings button.", findAssetId("LanguageIcon"));
    }
}
