import { findAssetId } from "@api/assets";
import { showToast } from "@api/ui/toasts";
import { findByProps, findByStoreName } from "@metro";
import { FluxUtils, NavigationNative } from "@metro/common";
import { Stack, TableRadioGroup, TableRadioRow, TableRow, TableRowGroup, TableSwitchRow, TextInput } from "@metro/common/components";
import React from "react";
import { ScrollView, Text, View } from "react-native";

import {
    getLanguageDisplayName,
    getServiceLabel,
    normalizeChatTranslatorSettingsForService,
} from "../lang";
import {
    clearChannelTranslationCache,
    clearTranslationCache,
    clearTranslationCacheForSignature,
    getTranslationCacheStats,
    getTranslationStateVersion,
    MAX_TRANSLATION_CACHE_LIMIT,
    pruneTranslationCache,
    revertAllTranslatedMessages,
    subscribeTranslationState,
} from "../state";
import { ChatTranslatorSettings, defaultChatTranslatorSettings, TranslationService, useChatTranslatorSettings } from "../storage";
import {
    clearReceivedAutoTranslateChannelOverride,
    clearReceivedLanguageOverrides,
    clearSentAutoTranslateChannelOverride,
    getDeeplUsage,
    getReceivedAutoTranslateChannelState,
    getReceivedTranslationCacheSignatureFromValues,
    getReceivedTranslationOptionsForChannel,
    getSentAutoTranslateChannelState,
    hasReceivedAutoTranslateChannelOverride,
    hasSentAutoTranslateChannelOverride,
    normalizeTranslationFailureReason,
    setReceivedAutoTranslateChannelState,
    setReceivedLanguagesForChannel,
    setSentAutoTranslateChannelState,
    testAzureConnection,
} from "../utils";
import LanguagePage from "./LanguagePage";

const showSimpleActionSheet = findByProps("showSimpleActionSheet")?.showSimpleActionSheet;
const hideActionSheet = findByProps("openLazy", "hideActionSheet")?.hideActionSheet;
const SelectedChannelStore = findByStoreName("SelectedChannelStore");
const ChannelStore = findByStoreName("ChannelStore");

const SERVICES: { label: string; value: TranslationService }[] = [
    { label: "Google Translate", value: "google" },
    { label: "DeepL Free", value: "deepl" },
    { label: "DeepL Pro", value: "deepl-pro" },
    { label: "Azure Translator", value: "azure" },
];

function updateSettings(update: Partial<ChatTranslatorSettings>) {
    useChatTranslatorSettings.getState().updateSettings(update);
}

function TextInputRow({
    label,
    value,
    placeholder,
    description,
    onChange,
    onBlur,
    keyboardType,
}: {
    label: string;
    value: string;
    placeholder?: string;
    description?: string;
    onChange: (value: string) => void;
    onBlur?: () => void;
    keyboardType?: "numeric" | "email-address" | "phone-pad";
}) {
    return (
        <TableRow
            label={label}
            subLabel={
                <View style={{ marginTop: 8 }}>
                    <TextInput
                        placeholder={placeholder}
                        value={value}
                        onChange={onChange}
                        onBlur={onBlur}
                        isClearable
                        keyboardType={keyboardType}
                    />
                    {!!description && (
                        <Text style={{ color: "#b5bac1", fontSize: 12, marginTop: 6 }}>
                            {description}
                        </Text>
                    )}
                </View>
            }
        />
    );
}

function NumericInputRow({
    description,
    label,
    max = Number.POSITIVE_INFINITY,
    onChange,
    placeholder,
    value,
}: {
    description?: string;
    label: string;
    max?: number;
    onChange: (value: number) => void;
    placeholder?: string;
    value: number;
}) {
    const [draft, setDraft] = React.useState(String(value));

    React.useEffect(() => {
        setDraft(String(value));
    }, [value]);

    const updateDraft = (nextDraft: string) => {
        if (!nextDraft.trim()) {
            setDraft("");
            onChange(0);
            return;
        }

        const parsed = Number(nextDraft);
        if (!Number.isFinite(parsed)) {
            setDraft(nextDraft);
            return;
        }

        const nextValue = Math.min(max, Math.max(0, parsed));
        setDraft(String(nextValue));
        onChange(nextValue);
    };

    return (
        <TextInputRow
            description={description}
            keyboardType="numeric"
            label={label}
            onBlur={() => setDraft(String(value))}
            onChange={updateDraft}
            placeholder={placeholder}
            value={draft}
        />
    );
}

export default function ChatTranslatorSettings() {
    const navigation = NavigationNative.useNavigation();
    const settings = useChatTranslatorSettings();
    const [deeplUsageText, setDeeplUsageText] = React.useState("");
    const [deeplUsageLoading, setDeeplUsageLoading] = React.useState(false);
    const [azureTestText, setAzureTestText] = React.useState("");
    const [azureTestLoading, setAzureTestLoading] = React.useState(false);
    const deeplUsageController = React.useRef<AbortController | null>(null);
    const azureTestController = React.useRef<AbortController | null>(null);
    const mounted = React.useRef(true);
    const translationStateVersion = React.useSyncExternalStore(
        subscribeTranslationState,
        getTranslationStateVersion,
        getTranslationStateVersion
    );
    const selectedChannelId = FluxUtils?.useStateFromStores?.(
        [SelectedChannelStore],
        () => SelectedChannelStore?.getChannelId?.() ?? SelectedChannelStore?.getCurrentlySelectedChannelId?.()
    );
    const selectedChannel = FluxUtils?.useStateFromStores?.(
        [ChannelStore],
        () => selectedChannelId ? ChannelStore?.getChannel?.(selectedChannelId) : null,
        [selectedChannelId]
    ) ?? (selectedChannelId ? ChannelStore?.getChannel?.(selectedChannelId) : null);
    const channelAutoEnabled = getReceivedAutoTranslateChannelState(selectedChannelId);
    const channelHasOverride = hasReceivedAutoTranslateChannelOverride(selectedChannelId);
    const channelSentAutoEnabled = getSentAutoTranslateChannelState(selectedChannelId);
    const channelSentHasOverride = hasSentAutoTranslateChannelOverride(selectedChannelId);
    const channelLanguages = getReceivedTranslationOptionsForChannel(selectedChannelId);
    const currentCacheSignature = getReceivedTranslationCacheSignatureFromValues(channelLanguages.sourceLang, channelLanguages.targetLang);
    const cacheStats = React.useMemo(
        () => getTranslationCacheStats(currentCacheSignature),
        [
            currentCacheSignature,
            settings.translationCacheLimit,
            settings.translationCacheTtlDays,
            translationStateVersion,
        ]
    );

    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    React.useEffect(() => {
        deeplUsageController.current?.abort();
        deeplUsageController.current = null;
        setDeeplUsageLoading(false);
        setDeeplUsageText("");

        return () => {
            deeplUsageController.current?.abort();
            deeplUsageController.current = null;
        };
    }, [settings.deeplApiKey, settings.service]);

    React.useEffect(() => {
        azureTestController.current?.abort();
        azureTestController.current = null;
        setAzureTestLoading(false);
        setAzureTestText("");

        return () => {
            azureTestController.current?.abort();
            azureTestController.current = null;
        };
    }, [settings.azureApiKey, settings.azureEndpoint, settings.azureRegion, settings.service]);

    const openLanguagePage = (title: string, settingKey: "receivedInput" | "receivedOutput" | "sentInput" | "sentOutput", includeAuto: boolean, channelId?: string) => {
        navigation.push("RAIN_CUSTOM_PAGE", {
            title,
            render: () => <LanguagePage channelId={channelId} settingKey={settingKey} includeAuto={includeAuto} />,
        });
    };

    const showServiceSheet = () => {
        if (!showSimpleActionSheet) {
            showToast("Service picker is not available on this Discord build.", findAssetId("LanguageIcon"));
            return;
        }

        showSimpleActionSheet({
            key: "ChatTranslatorServiceSelect",
            header: { title: "Select Translation Service" },
            options: SERVICES.map(service => ({
                label: service.label,
                onPress: () => {
                    const next = service.value;
                    updateSettings(normalizeChatTranslatorSettingsForService(settings, next));
                    hideActionSheet?.();
                },
            })),
        });
    };

    const checkDeeplUsage = async () => {
        if (deeplUsageController.current) return;

        const controller = new AbortController();
        deeplUsageController.current = controller;
        setDeeplUsageLoading(true);
        setDeeplUsageText("Checking DeepL usage...");

        try {
            const usage = await getDeeplUsage(controller.signal);
            if (controller.signal.aborted || deeplUsageController.current !== controller) return;

            const used = usage.character_count ?? usage.api_key_character_count ?? 0;
            const limit = usage.character_limit ?? usage.api_key_character_limit ?? 0;
            const text = limit > 0
                ? `${used.toLocaleString()} / ${limit.toLocaleString()} characters used`
                : `${used.toLocaleString()} characters used`;

            setDeeplUsageText(text);
            showToast(text, findAssetId("Check"));
        } catch (error) {
            if (controller.signal.aborted || deeplUsageController.current !== controller) return;

            const text = normalizeTranslationFailureReason(error);
            setDeeplUsageText(text);
            showToast(text, findAssetId("LanguageIcon"));
        } finally {
            if (deeplUsageController.current === controller) {
                deeplUsageController.current = null;
                setDeeplUsageLoading(false);
            }
        }
    };

    const runAzureConnectionTest = async () => {
        if (azureTestController.current) return;

        const controller = new AbortController();
        azureTestController.current = controller;
        setAzureTestLoading(true);
        setAzureTestText("Testing Azure connection...");

        try {
            const result = await testAzureConnection(controller.signal);
            if (controller.signal.aborted || azureTestController.current !== controller) return;

            const text = `Azure OK · ${result.sourceLanguage || "Auto"} → English`;

            setAzureTestText(text);
            showToast(text, findAssetId("Check"));
        } catch (error) {
            if (controller.signal.aborted || azureTestController.current !== controller) return;

            const text = normalizeTranslationFailureReason(error);
            setAzureTestText(text);
            showToast(text, findAssetId("LanguageIcon"));
        } finally {
            if (azureTestController.current === controller) {
                azureTestController.current = null;
                setAzureTestLoading(false);
            }
        }
    };

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 38 }}>
            <Stack style={{ paddingVertical: 24, paddingHorizontal: 12 }} spacing={24}>
                <TableRowGroup title="Translation Service">
                    <TableRow
                        label="Service"
                        subLabel={getServiceLabel(settings.service)}
                        icon={<TableRow.Icon source={findAssetId("LanguageIcon")} />}
                        trailing={() => <TableRow.Arrow />}
                        onPress={showServiceSheet}
                    />
                    {(settings.service === "deepl" || settings.service === "deepl-pro") && (
                        <>
                            <TextInputRow
                                label="DeepL API Key"
                                value={settings.deeplApiKey}
                                placeholder="DeepL authentication key"
                                onChange={value => updateSettings({ deeplApiKey: value })}
                            />
                            <TableRow
                                label={deeplUsageLoading ? "Checking DeepL usage..." : "Check DeepL usage"}
                                subLabel={deeplUsageText || "Shows this API key's character usage."}
                                trailing={() => <TableRow.Arrow />}
                                onPress={checkDeeplUsage}
                            />
                        </>
                    )}
                    {settings.service === "azure" && (
                        <>
                            <TextInputRow
                                label="Azure API Key"
                                value={settings.azureApiKey}
                                placeholder="Azure Translator key"
                                onChange={value => updateSettings({ azureApiKey: value })}
                            />
                            <TextInputRow
                                label="Azure Region"
                                value={settings.azureRegion}
                                placeholder="e.g. koreacentral"
                                onChange={value => updateSettings({ azureRegion: value })}
                            />
                            <TextInputRow
                                label="Azure Endpoint"
                                value={settings.azureEndpoint}
                                placeholder="https://api.cognitive.microsofttranslator.com"
                                onChange={value => updateSettings({ azureEndpoint: value })}
                            />
                            <TableRow
                                label={azureTestLoading ? "Testing Azure connection..." : "Test Azure connection"}
                                subLabel={azureTestText || "Sends a small test translation with the current Azure settings."}
                                trailing={() => <TableRow.Arrow />}
                                onPress={runAzureConnectionTest}
                            />
                        </>
                    )}
                </TableRowGroup>

                <TableRowGroup title="Received Messages">
                    <TableSwitchRow
                        icon={<TableRow.Icon source={findAssetId("ic_chat_bubble_32px")} />}
                        label="Auto translate received messages"
                        subLabel="Translates new and recently loaded chat messages."
                        value={settings.autoTranslateReceived}
                        onValueChange={(value: boolean) => updateSettings({ autoTranslateReceived: value })}
                    />
                    <TableRow
                        label="Translate from"
                        subLabel={getLanguageDisplayName(settings.receivedInput)}
                        trailing={() => <TableRow.Arrow />}
                        onPress={() => openLanguagePage("Received: Translate from", "receivedInput", true)}
                    />
                    <TableRow
                        label="Translate to"
                        subLabel={getLanguageDisplayName(settings.receivedOutput)}
                        trailing={() => <TableRow.Arrow />}
                        onPress={() => openLanguagePage("Received: Translate to", "receivedOutput", false)}
                    />
                    <TableRadioGroup
                        title="Display Mode"
                        value={settings.receivedDisplayMode}
                        onChange={(value: string) => updateSettings({ receivedDisplayMode: value as ChatTranslatorSettings["receivedDisplayMode"] })}
                    >
                        <TableRadioRow label="Translated + original" subLabel="Adds translation under the original." value="dual" />
                        <TableRadioRow label="Translated only" subLabel="Shows translation with a source note." value="translated" />
                        <TableRadioRow label="Toggle from action sheet" subLabel="Long-press to switch original/translation." value="toggle" />
                        <TableRadioRow label="Compact" subLabel="Shows translation with a small source note." value="compact" />
                    </TableRadioGroup>
                </TableRowGroup>

                <TableRowGroup title="Outgoing Messages">
                    <TableSwitchRow
                        icon={<TableRow.Icon source={findAssetId("ic_message_edit")} />}
                        label="Translate before sending"
                        subLabel="Translates your text before Discord sends it."
                        value={settings.autoTranslate}
                        onValueChange={(value: boolean) => updateSettings({ autoTranslate: value })}
                    />
                    <TableSwitchRow
                        label="Show sent translation toast"
                        value={settings.showAutoTranslateToast}
                        onValueChange={(value: boolean) => updateSettings({ showAutoTranslateToast: value })}
                    />
                    <TableRow
                        label="Translate from"
                        subLabel={getLanguageDisplayName(settings.sentInput)}
                        trailing={() => <TableRow.Arrow />}
                        onPress={() => openLanguagePage("Outgoing: Translate from", "sentInput", true)}
                    />
                    <TableRow
                        label="Translate to"
                        subLabel={getLanguageDisplayName(settings.sentOutput)}
                        trailing={() => <TableRow.Arrow />}
                        onPress={() => openLanguagePage("Outgoing: Translate to", "sentOutput", false)}
                    />
                </TableRowGroup>

                {selectedChannelId && (
                    <TableRowGroup title="Current Channel">
                        <TableSwitchRow
                            label={`Received auto translate ${selectedChannel?.name ? `in #${selectedChannel.name}` : "here"}`}
                            subLabel={channelHasOverride ? "Channel override on" : `Global received default: ${settings.autoTranslateReceived ? "on" : "off"}`}
                            value={channelAutoEnabled}
                            onValueChange={(value: boolean) => {
                                setReceivedAutoTranslateChannelState(selectedChannelId, value);
                            }}
                        />
                        {channelHasOverride && (
                            <TableRow
                                label="Use global auto setting"
                                trailing={() => <TableRow.Arrow />}
                                onPress={() => {
                                    clearReceivedAutoTranslateChannelOverride(selectedChannelId);
                                }}
                            />
                        )}
                        <TableSwitchRow
                            label="Outgoing auto translate here"
                            subLabel={channelSentHasOverride ? "Channel override on" : `Global outgoing default: ${settings.autoTranslate ? "on" : "off"}`}
                            value={channelSentAutoEnabled}
                            onValueChange={(value: boolean) => {
                                setSentAutoTranslateChannelState(selectedChannelId, value);
                            }}
                        />
                        {channelSentHasOverride && (
                            <TableRow
                                label="Use global outgoing setting"
                                trailing={() => <TableRow.Arrow />}
                                onPress={() => {
                                    clearSentAutoTranslateChannelOverride(selectedChannelId);
                                }}
                            />
                        )}
                        <TableRow
                            label="Channel translate from"
                            subLabel={getLanguageDisplayName(channelLanguages.sourceLang)}
                            trailing={() => <TableRow.Arrow />}
                            onPress={() => openLanguagePage("This channel: Translate from", "receivedInput", true, selectedChannelId)}
                        />
                        <TableRow
                            label="Channel translate to"
                            subLabel={getLanguageDisplayName(channelLanguages.targetLang)}
                            trailing={() => <TableRow.Arrow />}
                            onPress={() => openLanguagePage("This channel: Translate to", "receivedOutput", false, selectedChannelId)}
                        />
                        <TableRow
                            label="Translate channel to Korean"
                            subLabel="Auto-detect and translate received messages to Korean."
                            trailing={() => <TableRow.Arrow />}
                            onPress={() => {
                                setReceivedLanguagesForChannel(selectedChannelId, "auto", "ko");
                                showToast("This channel will translate to Korean", findAssetId("Check"));
                            }}
                        />
                        <TableRow
                            label="Use global languages"
                            trailing={() => <TableRow.Arrow />}
                            onPress={() => {
                                clearReceivedLanguageOverrides(selectedChannelId);
                                showToast("Channel language overrides cleared", findAssetId("Check"));
                            }}
                        />
                        <TableRow
                            label="Clear channel cache"
                            trailing={() => <TableRow.Arrow />}
                            onPress={async () => {
                                const cleared = await clearChannelTranslationCache(selectedChannelId);
                                if (mounted.current) {
                                    showToast(
                                        cleared ? "Channel translation cache cleared" : "Could not persist the channel cache change",
                                        findAssetId(cleared ? "Check" : "LanguageIcon")
                                    );
                                }
                            }}
                        />
                    </TableRowGroup>
                )}

                <TableRowGroup title="Auto Translate Filters">
                    <NumericInputRow
                        label="Max characters"
                        value={settings.autoTranslateMaxCharacters}
                        placeholder="0 = no character limit"
                        description="0 means no character limit."
                        onChange={value => updateSettings({ autoTranslateMaxCharacters: value })}
                    />
                    <NumericInputRow
                        label="Max lines"
                        value={settings.autoTranslateMaxLines}
                        placeholder="0 = no line limit"
                        description="0 means no line limit."
                        onChange={value => updateSettings({ autoTranslateMaxLines: value })}
                    />
                    <NumericInputRow
                        label="Google confidence requirement"
                        value={settings.googleConfidenceRequirement}
                        placeholder="0 = do not check confidence"
                        description="0 turns this check off."
                        onChange={value => updateSettings({ googleConfidenceRequirement: value })}
                    />
                    <TableSwitchRow
                        label="Skip code block messages"
                        value={settings.skipCodeBlockMessages}
                        onValueChange={(value: boolean) => updateSettings({ skipCodeBlockMessages: value })}
                    />
                    <TableSwitchRow
                        label="Skip already translated messages"
                        value={settings.skipAlreadyTranslatedMessages}
                        onValueChange={(value: boolean) => updateSettings({ skipAlreadyTranslatedMessages: value })}
                    />
                    <TableSwitchRow
                        label="Skip bot messages"
                        value={settings.skipBotMessages}
                        onValueChange={(value: boolean) => updateSettings({ skipBotMessages: value })}
                    />
                </TableRowGroup>

                <TableRowGroup title="Ignore Lists">
                    <TextInputRow
                        label="Ignored server IDs"
                        value={settings.ignoredGuilds}
                        placeholder="Comma-separated server IDs"
                        onChange={value => updateSettings({ ignoredGuilds: value })}
                    />
                    <TextInputRow
                        label="Ignored channel IDs"
                        value={settings.ignoredChannels}
                        placeholder="Comma-separated channel IDs"
                        onChange={value => updateSettings({ ignoredChannels: value })}
                    />
                    <TextInputRow
                        label="Ignored user IDs"
                        value={settings.ignoredUsers}
                        placeholder="Comma-separated user IDs"
                        onChange={value => updateSettings({ ignoredUsers: value })}
                    />
                </TableRowGroup>

                <TableRowGroup title="Cache">
                    <TableRow
                        label="Stats"
                        subLabel={`${cacheStats.cached}/${cacheStats.limit} cached · ${cacheStats.signatureCached ?? 0} match current languages · ${cacheStats.expired} expired · ${cacheStats.translated} translated · ${cacheStats.pending} pending`}
                    />
                    <NumericInputRow
                        label="Max persistent cache entries"
                        value={settings.translationCacheLimit ?? defaultChatTranslatorSettings.translationCacheLimit}
                        placeholder="0 = do not keep persistent cache"
                        description={`0 disables persistent cache. Values above ${MAX_TRANSLATION_CACHE_LIMIT.toLocaleString()} are capped.`}
                        max={MAX_TRANSLATION_CACHE_LIMIT}
                        onChange={value => updateSettings({ translationCacheLimit: value })}
                    />
                    <NumericInputRow
                        label="Cache TTL days"
                        value={settings.translationCacheTtlDays ?? defaultChatTranslatorSettings.translationCacheTtlDays}
                        placeholder="0 = cache never expires"
                        description="0 means cached translations never expire by age."
                        onChange={value => updateSettings({ translationCacheTtlDays: value })}
                    />
                    <TableRow
                        label="Clear current language cache"
                        subLabel={`Deletes cached translations for ${getLanguageDisplayName(channelLanguages.sourceLang)} → ${getLanguageDisplayName(channelLanguages.targetLang)}. Visible matching translations are reverted.`}
                        trailing={() => <TableRow.Arrow />}
                        onPress={async () => {
                            const cleared = await clearTranslationCacheForSignature(currentCacheSignature);
                            if (mounted.current) {
                                showToast(
                                    cleared ? "Current language translation cache cleared" : "Could not persist the language cache change",
                                    findAssetId(cleared ? "Check" : "LanguageIcon")
                                );
                            }
                        }}
                    />
                    <TableRow
                        label="Clean expired cache"
                        subLabel="Deletes only cache entries older than the TTL above."
                        trailing={() => <TableRow.Arrow />}
                        onPress={async () => {
                            const cleaned = await pruneTranslationCache();
                            if (mounted.current) {
                                showToast(
                                    cleaned ? "Expired translation cache cleaned" : "Could not persist the cache cleanup",
                                    findAssetId(cleaned ? "Check" : "LanguageIcon")
                                );
                            }
                        }}
                    />
                    <TableRow
                        label="Clear translation cache"
                        subLabel="Deletes every cached translation and reverts visible translated messages."
                        trailing={() => <TableRow.Arrow />}
                        onPress={async () => {
                            const cleared = await clearTranslationCache();
                            if (mounted.current) {
                                showToast(
                                    cleared ? "Translation cache cleared" : "Could not clear and persist the translation cache",
                                    findAssetId(cleared ? "Check" : "LanguageIcon")
                                );
                            }
                        }}
                    />
                    <TableRow
                        label="Revert translated visible messages"
                        trailing={() => <TableRow.Arrow />}
                        onPress={() => {
                            revertAllTranslatedMessages();
                            showToast("Visible translations reverted", findAssetId("Check"));
                        }}
                    />
                </TableRowGroup>
            </Stack>
        </ScrollView>
    );
}
