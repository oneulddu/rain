import { createPluginStore } from "@api/storage";

export type TranslationService = "google" | "deepl" | "deepl-pro" | "azure";
export type ReceivedDisplayMode = "translated" | "dual" | "compact" | "toggle";

export interface PersistedTranslationValue {
    confidence?: number;
    sourceLanguage: string;
    text: string;
}

export interface PersistedTranslationCacheEntry {
    cacheSignature: string;
    channelId: string;
    key: string;
    lastUsedAt: number;
    messageId?: string;
    originalContent?: string;
    requestSignature: string;
    sourceLang: string;
    targetLang: string;
    timestamp: number;
    translated: PersistedTranslationValue;
}

export interface ChatTranslatorCacheStorage {
    entries: Record<string, PersistedTranslationCacheEntry>;
}

export interface ChatTranslatorSettings {
    service: TranslationService;

    receivedInput: string;
    receivedOutput: string;
    sentInput: string;
    sentOutput: string;

    deeplApiKey: string;
    azureApiKey: string;
    azureRegion: string;
    azureEndpoint: string;

    autoTranslate: boolean;
    autoTranslateReceived: boolean;
    showAutoTranslateToast: boolean;

    receivedDisplayMode: ReceivedDisplayMode;
    autoTranslateMaxCharacters: number;
    autoTranslateMaxLines: number;
    skipCodeBlockMessages: boolean;
    skipAlreadyTranslatedMessages: boolean;
    skipBotMessages: boolean;
    googleConfidenceRequirement: number;
    translationCacheLimit: number;
    translationCacheTtlDays: number;

    ignoredGuilds: string;
    ignoredChannels: string;
    ignoredUsers: string;

    receivedChannelOverrides: Record<string, boolean>;
    sentChannelOverrides: Record<string, boolean>;
    receivedChannelInputOverrides: Record<string, string>;
    receivedChannelOutputOverrides: Record<string, string>;
}

export const defaultChatTranslatorSettings: ChatTranslatorSettings = {
    service: "google",

    receivedInput: "auto",
    receivedOutput: "en",
    sentInput: "auto",
    sentOutput: "en",

    deeplApiKey: "",
    azureApiKey: "",
    azureRegion: "",
    azureEndpoint: "https://api.cognitive.microsofttranslator.com",

    autoTranslate: false,
    autoTranslateReceived: false,
    showAutoTranslateToast: true,

    receivedDisplayMode: "dual",
    autoTranslateMaxCharacters: 500,
    autoTranslateMaxLines: 12,
    skipCodeBlockMessages: true,
    skipAlreadyTranslatedMessages: true,
    skipBotMessages: true,
    googleConfidenceRequirement: 0,
    translationCacheLimit: 1500,
    translationCacheTtlDays: 30,

    ignoredGuilds: "",
    ignoredChannels: "",
    ignoredUsers: "",

    receivedChannelOverrides: {},
    sentChannelOverrides: {},
    receivedChannelInputOverrides: {},
    receivedChannelOutputOverrides: {},
};

export const {
    useStore: useChatTranslatorSettings,
    settings: chatTranslatorSettings,
} = createPluginStore<ChatTranslatorSettings>("chattranslator", defaultChatTranslatorSettings);

export const {
    useStore: useChatTranslatorCacheStore,
} = createPluginStore<ChatTranslatorCacheStorage>("chattranslator-cache", { entries: {} });
