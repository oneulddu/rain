import { findAssetId } from "@api/assets";
import { showToast } from "@api/ui/toasts";
import { logger } from "@lib/utils/logger";
import { findByProps } from "@metro";

interface InputOption {
    label: string;
    subLabel?: string;
    onPress: () => void;
}

const SHEET_KEY = "ChatTranslatorInputOptions";

export function showInputOptions(options: InputOption[]) {
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
