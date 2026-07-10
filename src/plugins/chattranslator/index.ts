import { definePlugin } from "@plugins";
import { Contributors } from "@rain/Developers";

import patchChannelLongPressActionSheet from "./patches/ChannelLongPressActionSheet";
import patchChatInputActions from "./patches/ChatInputActions";
import patchMessageLongPressActionSheet from "./patches/MessageLongPressActionSheet";
import patchReceivedMessages from "./patches/receivedMessages";
import patchSendMessage from "./patches/sendMessage";
import Settings from "./settings";
import { revertAllTranslatedMessages, setChatTranslatorRuntimeActive } from "./state";

const patches: (() => unknown)[] = [];

export default definePlugin({
    name: "ChatTranslator",
    description: "Translate Discord messages on mobile with manual, received auto, and outgoing auto translation.",
    author: [Contributors.oneulffu],
    id: "chattranslator",
    version: "1.0.0",
    start() {
        setChatTranslatorRuntimeActive(true);
        patches.push(
            patchChannelLongPressActionSheet(),
            patchChatInputActions(),
            patchMessageLongPressActionSheet(),
            patchReceivedMessages(),
            patchSendMessage(),
        );
    },
    stop() {
        revertAllTranslatedMessages();
        setChatTranslatorRuntimeActive(false);
        for (const unpatch of patches) {
            if (typeof unpatch === "function") unpatch();
        }
        patches.length = 0;
    },
    settings: Settings,
});
