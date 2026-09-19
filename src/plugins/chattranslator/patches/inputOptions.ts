import { findAssetId } from "@api/assets";
import { showToast } from "@api/ui/toasts";
import { logger } from "@lib/utils/logger";
import { findByProps } from "@metro";
import { ReactNative } from "@metro/common";

interface InputOption {
    label: string;
    subLabel?: string;
    onPress: () => void;
}

const SHEET_KEY = "ChatTranslatorInputOptions";

export function showInputOptions(options: InputOption[], anchor?: number) {
    // The input accessory can outlive Discord's internal sheet implementation.
    // Use the native presenter on iOS and resolve the Discord fallback on demand.
    if (ReactNative.Platform.OS === "ios") {
        try {
            const sheet = ReactNative.ActionSheetIOS;
            if (typeof sheet?.showActionSheetWithOptions === "function") {
                ReactNative.Keyboard?.dismiss();
                sheet.showActionSheetWithOptions({
                    title: "ChatTranslator",
                    options: [...options.map(option => option.label), "Cancel"],
                    cancelButtonIndex: options.length,
                    anchor,
                }, index => options[index]?.onPress());
                return;
            }
        } catch (error) {
            logger.error("[ChatTranslator] Native options menu failed", error);
        }
    }

    try {
        const sheet = findByProps("showSimpleActionSheet");
        if (typeof sheet?.showSimpleActionSheet !== "function") throw new Error("Options presenter unavailable");
        sheet.showSimpleActionSheet({
            key: SHEET_KEY,
            header: { title: "ChatTranslator" },
            options: options.map(option => ({
                ...option,
                onPress: () => {
                    findByProps("openLazy", "hideActionSheet")?.hideActionSheet?.(SHEET_KEY);
                    option.onPress();
                },
            })),
        });
    } catch (error) {
        logger.error("[ChatTranslator] Options menu failed", error);
        showToast("Could not open ChatTranslator options.", findAssetId("LanguageIcon"));
    }
}
