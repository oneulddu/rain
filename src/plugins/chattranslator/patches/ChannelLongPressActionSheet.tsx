import { findAssetId } from "@api/assets";
import { after } from "@api/patcher";
import { showToast } from "@api/ui/toasts";
import { findInReactTree } from "@lib/utils";
import { findByName, findByProps } from "@metro";
import { ActionSheetRow } from "@metro/common/components";

import {
    clearReceivedAutoTranslateChannelOverride,
    getReceivedAutoTranslateChannelState,
    hasReceivedAutoTranslateChannelOverride,
    toggleReceivedAutoTranslateChannelState,
} from "../utils";

const ChannelLongPressActionSheet = findByName("ChannelLongPressActionSheet", false);
const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const ChannelIcon = findAssetId("ChannelIcon");
const PATCHED = Symbol.for("ChatTranslator.ChannelServerLongPressActionSheets");

interface ChannelLike {
    guild_id?: string;
    guildId?: string;
    id?: string;
    type?: number;
}

function makeIcon(source: number | void) {
    if (!source) return undefined;
    return <ActionSheetRow.Icon source={source} />;
}

function findActionGroups(tree: any) {
    return findInReactTree(
        tree,
        node => node?.[0]?.type?.name === "ActionSheetRowGroup",
    );
}

function buildChannelGroup(channel: ChannelLike) {
    const channelId = channel.id;
    if (!channelId) return null;

    const autoEnabled = getReceivedAutoTranslateChannelState(channelId);
    const hasOverride = hasReceivedAutoTranslateChannelOverride(channelId);

    return (
        <ActionSheetRow.Group key="chat-translator-channel-actions">
            <ActionSheetRow
                key="chat-translator-channel-auto"
                label={autoEnabled ? "Disable Auto Translate Here" : "Enable Auto Translate Here"}
                subLabel={hasOverride ? "Channel override" : "Using global default"}
                icon={makeIcon(ChannelIcon)}
                onPress={() => {
                    const next = toggleReceivedAutoTranslateChannelState(channelId);

                    LazyActionSheet?.hideActionSheet?.();
                    showToast(next ? "Auto translate enabled for this channel" : "Auto translate disabled for this channel", ChannelIcon);
                }}
            />
            {hasOverride && (
                <ActionSheetRow
                    key="chat-translator-channel-auto-reset"
                    label="Use Global Auto Setting"
                    icon={makeIcon(ChannelIcon)}
                    onPress={() => {
                        clearReceivedAutoTranslateChannelOverride(channelId);
                        LazyActionSheet?.hideActionSheet?.();
                        showToast("This channel now follows the global auto translate setting", ChannelIcon);
                    }}
                />
            )}
        </ActionSheetRow.Group>
    );
}

function insertGroup(component: any, group: any): boolean {
    if (!group || component?.[PATCHED]) return true;

    const actions = findActionGroups(component);
    if (!actions) return false;
    if (actions.some((action: any) => action?.key === "chat-translator-channel-actions")) return true;

    actions.unshift(group);
    try {
        component[PATCHED] = true;
    } catch {
        // Some React element shapes are not extensible on every Discord build.
    }
    return true;
}

export default function patchChannelServerLongPressActionSheets() {
    const patches: (() => void)[] = [];
    const removePatch = (unpatch: () => void) => {
        const index = patches.indexOf(unpatch);
        if (index !== -1) patches.splice(index, 1);
    };

    if (ChannelLongPressActionSheet) {
        patches.push(after("default", ChannelLongPressActionSheet, (_, ret) => {
            if (!ret || ret[PATCHED]) return;

            const channel = ret?.props?.channel as ChannelLike | undefined;
            const group = buildChannelGroup(channel ?? {});
            if (!group) return;

            let unpatchType: () => void = () => undefined;
            unpatchType = after("type", ret, (_, component) => {
                if (insertGroup(component, group)) {
                    unpatchType();
                    removePatch(unpatchType);
                }
            });
            patches.push(unpatchType);
            try {
                ret[PATCHED] = true;
            } catch {
                // Keep the row-key guard above as the fallback duplicate protection.
            }
        }));
    }

    return () => {
        for (const unpatch of patches) unpatch();
    };
}
