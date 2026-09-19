import { definePlugin } from "@plugins";
import { Contributors } from "@rain/Developers";
import React from "react";

const patches: (() => unknown)[] = [];

function removePatches() {
    for (const unpatch of patches.splice(0).reverse()) {
        try { unpatch(); } catch (error) { console.error("[ChatTranslator] Cleanup failed", error); }
    }
}

export default definePlugin({
    name: "ChatTranslator",
    description: "Translate Discord messages on mobile with manual, received auto, and outgoing auto translation.",
    author: [Contributors.oneulffu],
    id: "chattranslator",
    version: "1.0.3",
    start() {
        if (patches.length) return;
        // Plugin discovery runs before Discord renders. Resolve its UI only on start.
        const { setChatTranslatorRuntimeActive } = require("./state");
        setChatTranslatorRuntimeActive(true);
        try {
            patches.push(require("./patches/ChannelLongPressActionSheet").default());
            patches.push(require("./patches/ChatInputActions").default());
            patches.push(require("./patches/MessageLongPressActionSheet").default());
            patches.push(require("./patches/receivedMessages").default());
            patches.push(require("./patches/sendMessage").default());
        } catch (error) {
            setChatTranslatorRuntimeActive(false);
            removePatches();
            throw error;
        }
    },
    stop() {
        const { revertAllTranslatedMessages, setChatTranslatorRuntimeActive } = require("./state");
        setChatTranslatorRuntimeActive(false);
        try {
            revertAllTranslatedMessages();
        } finally {
            removePatches();
        }
    },
    settings: () => React.createElement(require("./settings").default),
});
