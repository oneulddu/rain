import { Search } from "@api/ui/components";
import { Stack, TableRadioGroup, TableRadioRow } from "@metro/common/components";
import React from "react";
import { ScrollView } from "react-native";

import { getLanguageOptions } from "../lang";
import { ChatTranslatorSettings, useChatTranslatorSettings } from "../storage";
import {
    setReceivedInputLanguageForChannel,
    setReceivedOutputLanguageForChannel,
} from "../utils";

type LanguageSettingField = "receivedInput" | "receivedOutput" | "sentInput" | "sentOutput";

export default function LanguagePage({ channelId, settingKey, includeAuto }: { channelId?: string; settingKey: LanguageSettingField; includeAuto: boolean }) {
    const service = useChatTranslatorSettings(state => state.service);
    const value = useChatTranslatorSettings(state => {
        if (channelId && settingKey === "receivedInput") {
            return (state.receivedChannelInputOverrides ?? {})[channelId] ?? state.receivedInput;
        }
        if (channelId && settingKey === "receivedOutput") {
            return (state.receivedChannelOutputOverrides ?? {})[channelId] ?? state.receivedOutput;
        }

        return (state[settingKey] as string) ?? (includeAuto ? "auto" : "en");
    });
    const [query, setQuery] = React.useState("");
    const lowerQuery = query.toLowerCase();
    const options = React.useMemo(() => getLanguageOptions(service, includeAuto).filter(option => {
        return option.label.toLowerCase().includes(lowerQuery) || option.value.toLowerCase().includes(lowerQuery);
    }), [includeAuto, lowerQuery, service]);

    const updateLanguage = (value: string) => {
        if (channelId && settingKey === "receivedInput") {
            setReceivedInputLanguageForChannel(channelId, value);
            return;
        }

        if (channelId && settingKey === "receivedOutput") {
            setReceivedOutputLanguageForChannel(channelId, value);
            return;
        }

        useChatTranslatorSettings.getState().updateSettings({ [settingKey]: value } as Partial<ChatTranslatorSettings>);
    };

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 38 }}>
            <Search
                style={{ padding: 15 }}
                placeholder="Search languages"
                onChangeText={setQuery}
                isRound={true}
            />
            <Stack style={{ paddingHorizontal: 12 }} spacing={24}>
                <TableRadioGroup
                    title="Languages"
                    value={value}
                    onChange={updateLanguage}
                >
                    {options.map(option => (
                        <TableRadioRow
                            key={option.value}
                            label={option.label}
                            subLabel={option.value}
                            value={option.value}
                        />
                    ))}
                </TableRadioGroup>
            </Stack>
        </ScrollView>
    );
}
