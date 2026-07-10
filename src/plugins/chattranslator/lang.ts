import { DeepLLangs, GTranslateLangs } from "@plugins/translator/lang";

import type { ChatTranslatorSettings, TranslationService } from "./storage";

export interface LanguageOption {
    label: string;
    value: string;
}

const GOOGLE_NAME_BY_CODE: Record<string, string> = {
    auto: "Detect language",
    ...Object.fromEntries(
        Object.entries(GTranslateLangs as Record<string, string>).map(([name, code]) => [code, name])
    ),
};

const GOOGLE_CODE_SET = new Set(Object.values(GTranslateLangs as Record<string, string>));
const DEEPL_NAME_BY_CODE = Object.fromEntries(
    Object.entries(DeepLLangs as Record<string, string>).map(([name, code]) => [code.toUpperCase(), name])
) as Record<string, string>;
const DEEPL_CODE_SET = new Set([
    ...Object.values(DeepLLangs as Record<string, string>).map(code => code.toUpperCase()),
    "EN",
    "EN-US",
    "EN-GB",
    "PT",
    "PT-BR",
    "PT-PT",
    "ZH",
    "ZH-HANS",
    "ZH-HANT",
    "NB",
]);
const DEEPL_REGIONAL_SOURCE_COLLAPSE: Record<string, string> = {
    "EN-US": "EN",
    "EN-GB": "EN",
    "PT-BR": "PT",
    "PT-PT": "PT",
    "ZH-HANS": "ZH",
    "ZH-HANT": "ZH",
};

const GOOGLE_TO_DEEPL_SOURCE: Record<string, string> = {
    "zh-CN": "ZH",
    "zh-TW": "ZH",
    iw: "HE",
    no: "NB",
    jw: "JA",
    tl: "ID",
};

const GOOGLE_TO_DEEPL_TARGET: Record<string, string> = {
    ...GOOGLE_TO_DEEPL_SOURCE,
    "zh-CN": "ZH-HANS",
    "zh-TW": "ZH-HANT",
    en: "EN-US",
    pt: "PT-BR",
};

const DEEPL_TO_GOOGLE: Record<string, string> = {
    ZH: "zh-CN",
    "ZH-HANS": "zh-CN",
    "ZH-HANT": "zh-TW",
    HE: "iw",
    NO: "no",
    NB: "no",
    "EN-US": "en",
    "EN-GB": "en",
    "PT-BR": "pt",
    "PT-PT": "pt",
};

export function deeplLanguageToGoogleLanguage(language?: string | null): string {
    const raw = language?.trim();
    if (!raw) return "auto";

    const upper = raw.toUpperCase();
    if (DEEPL_TO_GOOGLE[upper]) return DEEPL_TO_GOOGLE[upper];

    const lower = raw.toLowerCase();
    if (lower === "auto") return "auto";
    if (GOOGLE_CODE_SET.has(raw)) return raw;
    if (GOOGLE_CODE_SET.has(lower)) return lower;

    const base = lower.split("-")[0];
    return GOOGLE_CODE_SET.has(base) ? base : lower;
}

export function googleLanguageToDeepLLanguage(language?: string | null, fallback = "EN", isSource = false): string {
    const raw = language?.trim();
    if (!raw || raw === "auto") return "";

    const upper = raw.toUpperCase();
    if (DEEPL_CODE_SET.has(upper)) {
        return isSource ? DEEPL_REGIONAL_SOURCE_COLLAPSE[upper] ?? upper : upper;
    }

    const mapped = (isSource ? GOOGLE_TO_DEEPL_SOURCE : GOOGLE_TO_DEEPL_TARGET)[raw] ?? raw.split("-")[0].toUpperCase();
    return DEEPL_CODE_SET.has(mapped) ? mapped : fallback;
}

export function getLanguageDisplayName(language?: string | null): string {
    if (!language) return "Unknown";

    const upper = language.trim().toUpperCase();
    if (upper === "AUTO") return "Detect language";
    if (DEEPL_NAME_BY_CODE[upper]) return DEEPL_NAME_BY_CODE[upper];

    const normalized = deeplLanguageToGoogleLanguage(language);
    return GOOGLE_NAME_BY_CODE[normalized] ?? GOOGLE_NAME_BY_CODE[normalized.toLowerCase()] ?? language;
}

export function getServiceLabel(service: TranslationService): string {
    switch (service) {
        case "deepl": return "DeepL Free";
        case "deepl-pro": return "DeepL Pro";
        case "azure": return "Azure Translator";
        default: return "Google Translate";
    }
}

function uniqueOptions(options: LanguageOption[]): LanguageOption[] {
    const seen = new Set<string>();
    return options.filter(option => {
        if (seen.has(option.value)) return false;
        seen.add(option.value);
        return true;
    });
}

function googleOptions(includeAuto: boolean): LanguageOption[] {
    const options = Object.entries(GTranslateLangs as Record<string, string>)
        .map(([label, value]) => ({ label, value }));

    return includeAuto ? [{ label: "Detect language", value: "auto" }, ...options] : options;
}

function deeplOptions(includeAuto: boolean): LanguageOption[] {
    const options = Object.entries(DeepLLangs as Record<string, string>)
        .map(([label, value]) => ({ label, value: value.toUpperCase() }));

    return uniqueOptions(includeAuto ? [{ label: "Detect language", value: "auto" }, ...options] : options);
}

export function getLanguageOptions(service: TranslationService, includeAuto: boolean): LanguageOption[] {
    return service === "deepl" || service === "deepl-pro"
        ? deeplOptions(includeAuto)
        : googleOptions(includeAuto);
}

export function normalizeLanguageForService(language: string | undefined, service: TranslationService, includeAuto: boolean): string {
    if (service === "deepl" || service === "deepl-pro") {
        const raw = language?.trim();
        const upper = raw?.toUpperCase();

        if (includeAuto && (!raw || upper === "AUTO")) return "auto";
        if (upper && DEEPL_CODE_SET.has(upper)) {
            return includeAuto ? DEEPL_REGIONAL_SOURCE_COLLAPSE[upper] ?? upper : upper;
        }

        const normalized = googleLanguageToDeepLLanguage(
            deeplLanguageToGoogleLanguage(raw),
            includeAuto ? "" : "EN-US",
            includeAuto
        );

        if (normalized && DEEPL_CODE_SET.has(normalized)) return normalized;
        return includeAuto ? "auto" : "EN-US";
    }

    const options = getLanguageOptions(service, includeAuto);
    const normalized = deeplLanguageToGoogleLanguage(language);
    if (options.some(option => option.value === normalized)) return normalized;
    return includeAuto ? "auto" : "en";
}

export function normalizeLanguageOverrideMapForService(
    overrides: Record<string, string> | undefined,
    service: TranslationService,
    includeAuto: boolean
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(overrides ?? {})
            .filter(([channelId, value]) => !!channelId && typeof value === "string")
            .map(([channelId, value]) => [channelId, normalizeLanguageForService(value, service, includeAuto)])
    );
}

export function normalizeChatTranslatorSettingsForService(
    settings: ChatTranslatorSettings,
    service: TranslationService
): Pick<
    ChatTranslatorSettings,
    "service"
    | "receivedInput"
    | "receivedOutput"
    | "sentInput"
    | "sentOutput"
    | "receivedChannelInputOverrides"
    | "receivedChannelOutputOverrides"
> {
    return {
        service,
        receivedInput: normalizeLanguageForService(settings.receivedInput, service, true),
        receivedOutput: normalizeLanguageForService(settings.receivedOutput, service, false),
        receivedChannelInputOverrides: normalizeLanguageOverrideMapForService(settings.receivedChannelInputOverrides, service, true),
        receivedChannelOutputOverrides: normalizeLanguageOverrideMapForService(settings.receivedChannelOutputOverrides, service, false),
        sentInput: normalizeLanguageForService(settings.sentInput, service, true),
        sentOutput: normalizeLanguageForService(settings.sentOutput, service, false),
    };
}
