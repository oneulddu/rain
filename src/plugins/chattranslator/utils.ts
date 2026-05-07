import { findAssetId } from "@api/assets";
import { showToast } from "@api/ui/toasts";
import { cyrb64Hash } from "@lib/utils/cyrb64";
import { logger } from "@lib/utils/logger";
import { findByStoreName } from "@metro";

import {
    deeplLanguageToGoogleLanguage,
    getLanguageDisplayName,
    googleLanguageToDeepLLanguage,
    normalizeChatTranslatorSettingsForService,
    normalizeLanguageForService,
} from "./lang";
import { TranslationService, useChatTranslatorSettings } from "./storage";

export interface DiscordMessage {
    id?: string;
    channel_id?: string;
    channelId?: string;
    guild_id?: string;
    guildId?: string;
    content?: string;
    author?: {
        id?: string;
        bot?: boolean;
    };
    messageSnapshots?: { message?: { content?: string } }[];
    embeds?: { type?: string; rawDescription?: string }[];
}

export interface TranslationValue {
    confidence?: number;
    sourceLanguage: string;
    text: string;
}

export interface ReceivedTranslationOptions {
    ignoreConfidenceRequirement?: boolean;
    sourceLang?: string;
    targetLang?: string;
}

export interface TranslationSkipResult {
    reason: string;
    canTranslateManually: boolean;
}

interface GoogleTranslateResponse {
    confidence?: number;
    sentences?: { trans?: string }[];
    src?: string;
    ld_result?: {
        srclangs?: string[];
        srclangs_confidences?: number[];
    };
}

interface DeepLTranslateResponse {
    translations?: {
        detected_source_language?: string;
        text?: string;
    }[];
    message?: string;
}

interface DeepLUsageResponse {
    api_key_character_count?: number;
    api_key_character_limit?: number;
    character_count?: number;
    character_limit?: number;
    end_time?: string;
    message?: string;
    start_time?: string;
}

interface AzureTranslationResponseEntry {
    detectedLanguage?: {
        language: string;
    };
    translations?: {
        text: string;
        to: string;
    }[];
}

const ChannelStore = findByStoreName("ChannelStore");
const LanguageIcon = findAssetId("LanguageIcon");
const shownDeepLFallbackNotices = new Set<string>();
const PRESERVED_TOKEN_PATTERN = /⟪RAIN_CHAT_TRANSLATOR_TOKEN_(\d+)⟫/g;
const PRESERVED_SEGMENT_PATTERNS = [
    /```[\s\S]*?```/g,
    /`[^`\n]+`/g,
    /https?:\/\/\S+/g,
    /<a?:[A-Za-z0-9_~]+:\d+>/g,
    /<@[!&]?\d+>/g,
    /<#\d+>/g,
    /<\/[^:>]+:\d+>/g,
    /<t:\d+(?::[tTdDfFR])?>/g,
] as const;

interface PreservedTextState {
    hasMeaningfulText: boolean;
    restore: (text: string) => string;
    text: string;
}

function timeoutSignal(ms: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

function prepareTextForTranslation(text: string): PreservedTextState {
    const preservedValues: string[] = [];
    let masked = text;

    for (const pattern of PRESERVED_SEGMENT_PATTERNS) {
        masked = masked.replace(pattern, match => {
            const token = `⟪RAIN_CHAT_TRANSLATOR_TOKEN_${preservedValues.length}⟫`;
            preservedValues.push(match);
            return token;
        });
    }

    const strippedForDetection = masked.replace(PRESERVED_TOKEN_PATTERN, " ").trim();

    return {
        hasMeaningfulText: /[\p{L}\p{N}]/u.test(strippedForDetection),
        restore: translatedText => translatedText.replace(
            PRESERVED_TOKEN_PATTERN,
            (_, index) => preservedValues[Number(index)] ?? ""
        ),
        text: masked,
    };
}

export function hasMeaningfulTextForTranslation(text: string): boolean {
    return prepareTextForTranslation(text).hasMeaningfulText;
}

export function getMessageContent(message: DiscordMessage): string {
    return message.content
        || message.messageSnapshots?.[0]?.message?.content
        || message.embeds?.find(embed => embed.type === "auto_moderation_message")?.rawDescription
        || "";
}

export function getMessageChannelId(message: DiscordMessage): string {
    return message.channel_id ?? message.channelId ?? "";
}

export function getMessageGuildId(message: DiscordMessage, channelId = getMessageChannelId(message)): string | undefined {
    return message.guild_id ?? message.guildId ?? ChannelStore?.getChannel?.(channelId)?.guild_id;
}

function parseIdList(value = ""): Set<string> {
    return new Set(value.split(",").map(id => id.trim()).filter(Boolean));
}

function writeIdList(settingKey: "ignoredGuilds" | "ignoredChannels" | "ignoredUsers", ids: Set<string>) {
    useChatTranslatorSettings.getState().updateSettings({ [settingKey]: Array.from(ids).join(",") } as any);
}

export function getIgnoredGuilds(): Set<string> {
    return parseIdList(useChatTranslatorSettings.getState().ignoredGuilds);
}

export function getIgnoredChannels(): Set<string> {
    return parseIdList(useChatTranslatorSettings.getState().ignoredChannels);
}

export function getIgnoredUsers(): Set<string> {
    return parseIdList(useChatTranslatorSettings.getState().ignoredUsers);
}

export function isIgnoredGuild(guildId?: string | null): boolean {
    return !!guildId && getIgnoredGuilds().has(guildId);
}

export function isIgnoredChannel(channelId?: string | null): boolean {
    return !!channelId && getIgnoredChannels().has(channelId);
}

export function isIgnoredUser(userId?: string | null): boolean {
    return !!userId && getIgnoredUsers().has(userId);
}

export function setIgnoredGuild(guildId: string, ignored: boolean) {
    const ignoredGuilds = getIgnoredGuilds();
    ignored ? ignoredGuilds.add(guildId) : ignoredGuilds.delete(guildId);
    writeIdList("ignoredGuilds", ignoredGuilds);
}

export function setIgnoredChannel(channelId: string, ignored: boolean) {
    const ignoredChannels = getIgnoredChannels();
    ignored ? ignoredChannels.add(channelId) : ignoredChannels.delete(channelId);
    writeIdList("ignoredChannels", ignoredChannels);
}

export function setIgnoredUser(userId: string, ignored: boolean) {
    const ignoredUsers = getIgnoredUsers();
    ignored ? ignoredUsers.add(userId) : ignoredUsers.delete(userId);
    writeIdList("ignoredUsers", ignoredUsers);
}

export function hasReceivedAutoTranslateChannelOverride(channelId?: string | null): boolean {
    if (!channelId) return false;
    return Object.prototype.hasOwnProperty.call(useChatTranslatorSettings.getState().receivedChannelOverrides, channelId);
}

export function getReceivedAutoTranslateChannelState(channelId?: string | null): boolean {
    const state = useChatTranslatorSettings.getState();
    if (!channelId) return state.autoTranslateReceived;
    return state.receivedChannelOverrides[channelId] ?? state.autoTranslateReceived;
}

export function setReceivedAutoTranslateChannelState(channelId: string, enabled: boolean) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...state.receivedChannelOverrides };

    if (enabled === state.autoTranslateReceived) delete overrides[channelId];
    else overrides[channelId] = enabled;

    state.updateSettings({ receivedChannelOverrides: overrides });
}

export function toggleReceivedAutoTranslateChannelState(channelId: string): boolean {
    const next = !getReceivedAutoTranslateChannelState(channelId);

    setReceivedAutoTranslateChannelState(channelId, next);
    return next;
}

export function clearReceivedAutoTranslateChannelOverride(channelId: string) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...state.receivedChannelOverrides };
    delete overrides[channelId];
    state.updateSettings({ receivedChannelOverrides: overrides });
}

export function hasSentAutoTranslateChannelOverride(channelId?: string | null): boolean {
    if (!channelId) return false;
    return Object.prototype.hasOwnProperty.call(useChatTranslatorSettings.getState().sentChannelOverrides ?? {}, channelId);
}

export function getSentAutoTranslateChannelState(channelId?: string | null): boolean {
    const state = useChatTranslatorSettings.getState();
    if (!channelId) return state.autoTranslate;
    return (state.sentChannelOverrides ?? {})[channelId] ?? state.autoTranslate;
}

export function setSentAutoTranslateChannelState(channelId: string, enabled: boolean) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...(state.sentChannelOverrides ?? {}) };

    if (enabled === state.autoTranslate) delete overrides[channelId];
    else overrides[channelId] = enabled;

    state.updateSettings({ sentChannelOverrides: overrides });
}

export function toggleSentAutoTranslateChannelState(channelId: string): boolean {
    const next = !getSentAutoTranslateChannelState(channelId);

    setSentAutoTranslateChannelState(channelId, next);
    return next;
}

export function clearSentAutoTranslateChannelOverride(channelId: string) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...(state.sentChannelOverrides ?? {}) };
    delete overrides[channelId];
    state.updateSettings({ sentChannelOverrides: overrides });
}

export function getReceivedTranslationOptionsForChannel(channelId?: string | null): Required<Pick<ReceivedTranslationOptions, "sourceLang" | "targetLang">> {
    const state = useChatTranslatorSettings.getState();
    return {
        sourceLang: channelId ? state.receivedChannelInputOverrides[channelId] ?? state.receivedInput : state.receivedInput,
        targetLang: channelId ? state.receivedChannelOutputOverrides[channelId] ?? state.receivedOutput : state.receivedOutput,
    };
}

export function setReceivedInputLanguageForChannel(channelId: string, value: string) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...state.receivedChannelInputOverrides };
    const normalized = normalizeLanguageForService(value, state.service, true);

    if (!value || normalized === state.receivedInput) delete overrides[channelId];
    else overrides[channelId] = normalized;

    state.updateSettings({ receivedChannelInputOverrides: overrides });
}

export function setReceivedOutputLanguageForChannel(channelId: string, value: string) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...state.receivedChannelOutputOverrides };
    const normalized = normalizeLanguageForService(value, state.service, false);

    if (!value || normalized === state.receivedOutput) delete overrides[channelId];
    else overrides[channelId] = normalized;

    state.updateSettings({ receivedChannelOutputOverrides: overrides });
}

export function clearReceivedInputLanguageOverride(channelId: string) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...state.receivedChannelInputOverrides };
    delete overrides[channelId];
    state.updateSettings({ receivedChannelInputOverrides: overrides });
}

export function clearReceivedOutputLanguageOverride(channelId: string) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...state.receivedChannelOutputOverrides };
    delete overrides[channelId];
    state.updateSettings({ receivedChannelOutputOverrides: overrides });
}

function countMessageLines(text: string): number {
    if (!text) return 0;
    return text.split(/\r?\n/).length;
}

function hasCodeBlock(text: string): boolean {
    return /```[\s\S]*?```/.test(text);
}

function looksAlreadyTranslated(text: string): boolean {
    return /(?:^|\n)\s*(?:\*?\(translated\)\*?|translated from\s+[^\n]+|translated by chattranslator)\s*$/i.test(text.trim());
}

export function getManualTranslationBlockReason(text: string): TranslationSkipResult | null {
    if (!hasMeaningfulTextForTranslation(text)) {
        return {
            reason: "Skipped: no translatable text",
            canTranslateManually: false,
        };
    }

    return null;
}

export function getAutomaticTranslationSkipReason(text: string): TranslationSkipResult | null {
    const state = useChatTranslatorSettings.getState();

    if (!hasMeaningfulTextForTranslation(text)) {
        return {
            reason: "Skipped: no translatable text",
            canTranslateManually: false,
        };
    }

    if (state.skipCodeBlockMessages && hasCodeBlock(text)) {
        return {
            reason: "Skipped: contains code block",
            canTranslateManually: true,
        };
    }

    if (state.skipAlreadyTranslatedMessages && looksAlreadyTranslated(text)) {
        return {
            reason: "Skipped: already looks translated",
            canTranslateManually: true,
        };
    }

    if ((state.autoTranslateMaxCharacters || 0) > 0 && text.length > state.autoTranslateMaxCharacters) {
        return {
            reason: `Skipped: longer than ${state.autoTranslateMaxCharacters} characters`,
            canTranslateManually: true,
        };
    }

    if ((state.autoTranslateMaxLines || 0) > 0 && countMessageLines(text) > state.autoTranslateMaxLines) {
        return {
            reason: `Skipped: more than ${state.autoTranslateMaxLines} lines`,
            canTranslateManually: true,
        };
    }

    return null;
}

export function getAutomaticMessageSkipReason(message: DiscordMessage, content: string): TranslationSkipResult | null {
    const state = useChatTranslatorSettings.getState();
    const channelId = getMessageChannelId(message);
    const guildId = getMessageGuildId(message, channelId);

    if (state.skipBotMessages && message.author?.bot) {
        return {
            reason: "Skipped: bot message",
            canTranslateManually: true,
        };
    }

    if (isIgnoredUser(message.author?.id)) {
        return {
            reason: "Skipped: ignored user",
            canTranslateManually: true,
        };
    }

    if (isIgnoredChannel(channelId)) {
        return {
            reason: "Skipped: ignored channel",
            canTranslateManually: true,
        };
    }

    if (isIgnoredGuild(guildId)) {
        return {
            reason: "Skipped: ignored server",
            canTranslateManually: true,
        };
    }

    return getAutomaticTranslationSkipReason(content);
}

export function normalizeTranslationFailureReason(error: unknown): string {
    const message = typeof error === "string"
        ? error
        : error instanceof Error
            ? error.message
            : String(error);

    if (/azure translator api key is not set/i.test(message)) return "Azure Translator API key is missing.";
    if (/deepl.*api key is not set|api key is not set/i.test(message)) return "DeepL API key is missing. Google Translate fallback was used when possible.";
    if (/deepl.*quota exceeded|quota exceeded/i.test(message)) return "DeepL quota is used up. Google Translate fallback was used when possible.";
    if (/low google detection confidence/i.test(message)) return "Skipped: low Google detection confidence";
    if (/invalid .*api key|invalid azure|invalid deepl|401|403/i.test(message)) return "Invalid API key or translation service setting.";
    if (/failed to connect|fetch failed|network|certificate|abort/i.test(message)) return "Network or certificate error while translating.";

    return `Failed: ${message}`;
}

function normalizeCacheSignatureLanguage(language: string | undefined, isTarget: boolean): string {
    const upper = language?.trim().toUpperCase();
    if (isTarget && upper && /^(?:EN|PT|ZH)-(?:US|GB|BR|PT|HANS|HANT)$/.test(upper)) return upper;

    return deeplLanguageToGoogleLanguage(language || (isTarget ? "en" : "auto"));
}

export function getReceivedTranslationCacheSignatureFromValues(sourceLang?: string, targetLang?: string): string {
    return [
        normalizeCacheSignatureLanguage(sourceLang, false),
        normalizeCacheSignatureLanguage(targetLang, true),
    ].join("::");
}

export function createSecretFingerprint(secret?: string | null): string {
    const trimmed = secret?.trim() ?? "";
    if (!trimmed) return "";

    return `${trimmed.length}:${cyrb64Hash(trimmed)}`;
}

export function getReceivedTranslationRequestSignatureFromValues(sourceLang?: string, targetLang?: string): string {
    const state = useChatTranslatorSettings.getState();

    return [
        state.service,
        normalizeCacheSignatureLanguage(sourceLang, false),
        normalizeCacheSignatureLanguage(targetLang, true),
        createSecretFingerprint(state.deeplApiKey),
        createSecretFingerprint(state.azureApiKey),
        state.azureRegion.trim(),
        state.azureEndpoint.trim(),
        state.service === "google" ? String(Number(state.googleConfidenceRequirement) || 0) : "",
    ].join("::");
}

function showDeepLFallbackNotice(key: string, message: string) {
    if (shownDeepLFallbackNotices.has(key)) return;

    shownDeepLFallbackNotices.add(key);
    showToast(message, LanguageIcon);
}

async function googleTranslate(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    const url = "https://translate.googleapis.com/translate_a/single?" + new URLSearchParams({
        client: "gtx",
        sl: sourceLang || "auto",
        tl: targetLang || "en",
        dt: "t",
        dj: "1",
        source: "input",
        q: text,
    });

    const res = await fetch(url, { signal: timeoutSignal(15000) });
    if (!res.ok) throw new Error(`Google Translate returned ${res.status} ${res.statusText}`);

    const response = await res.json() as GoogleTranslateResponse;
    const translation = response.sentences?.map(sentence => sentence.trans).filter(Boolean).join("") ?? "";
    if (!translation) throw new Error("Google Translate returned an empty translation response.");

    const sourceLanguage = response.src ?? response.ld_result?.srclangs?.[0] ?? sourceLang;
    const confidence = response.confidence ?? response.ld_result?.srclangs_confidences?.[0];

    return {
        confidence,
        sourceLanguage: getLanguageDisplayName(sourceLanguage),
        text: translation,
    };
}

async function deeplTranslate(service: TranslationService, text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    const state = useChatTranslatorSettings.getState();
    if (!state.deeplApiKey.trim()) throw new Error("DeepL API key is not set.");

    const body = new URLSearchParams();
    const deeplTarget = googleLanguageToDeepLLanguage(targetLang, "EN-US");
    const deeplSource = googleLanguageToDeepLLanguage(sourceLang, "", true);

    if (!deeplTarget) throw new Error("DeepL target language is not set.");

    body.append("text", text);
    body.append("target_lang", deeplTarget);
    if (deeplSource) body.append("source_lang", deeplSource);

    const endpoint = service === "deepl-pro"
        ? "https://api.deepl.com/v2/translate"
        : "https://api-free.deepl.com/v2/translate";

    const res = await fetch(endpoint, {
        method: "POST",
        headers: {
            Authorization: `DeepL-Auth-Key ${state.deeplApiKey.trim()}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: timeoutSignal(15000),
    });

    const response = await res.json().catch(() => ({})) as DeepLTranslateResponse;
    if (!res.ok) {
        if (res.status === 456) throw new Error("DeepL API quota exceeded.");
        throw new Error(response.message || `DeepL returned ${res.status} ${res.statusText}`);
    }

    const first = response.translations?.[0];
    if (!first?.text) throw new Error("DeepL returned an empty translation response.");

    return {
        sourceLanguage: getLanguageDisplayName(first.detected_source_language || sourceLang),
        text: first.text,
    };
}

async function fallbackToGoogle(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    return googleTranslate(
        text,
        deeplLanguageToGoogleLanguage(sourceLang || "auto"),
        deeplLanguageToGoogleLanguage(targetLang || "en")
    );
}

export function switchDeepLToGoogleIfApiKeyMissing(): boolean {
    const state = useChatTranslatorSettings.getState();
    if (state.service !== "deepl" && state.service !== "deepl-pro") return false;
    if (state.deeplApiKey.trim()) return false;

    state.updateSettings(normalizeChatTranslatorSettingsForService(state, "google"));
    showDeepLFallbackNotice(
        "deepl-missing-key",
        "DeepL API key is missing, so ChatTranslator switched to Google Translate."
    );
    logger.warn("[ChatTranslator] DeepL API key is missing. Switched service to Google Translate.");
    return true;
}

export async function getDeeplUsage(): Promise<DeepLUsageResponse> {
    const state = useChatTranslatorSettings.getState();
    if (state.service !== "deepl" && state.service !== "deepl-pro") {
        throw new Error("DeepL service is not selected.");
    }

    const apiKey = state.deeplApiKey.trim();
    if (!apiKey) throw new Error("DeepL API key is not set.");

    const endpoint = state.service === "deepl-pro"
        ? "https://api.deepl.com/v2/usage"
        : "https://api-free.deepl.com/v2/usage";

    const res = await fetch(endpoint, {
        headers: {
            Authorization: `DeepL-Auth-Key ${apiKey}`,
        },
        signal: timeoutSignal(15000),
    });

    const response = await res.json().catch(() => ({})) as DeepLUsageResponse;
    if (!res.ok) {
        if (res.status === 403) throw new Error("DeepL API key is invalid or does not match the selected Free/Pro service.");
        if (res.status === 456) throw new Error("DeepL API quota exceeded.");
        throw new Error(response.message || `DeepL usage returned ${res.status} ${res.statusText}`);
    }

    return response;
}

function normalizeAzureLanguage(language: string): string {
    if (!language || language === "auto") return "";

    switch (language) {
        case "zh-CN": return "zh-Hans";
        case "zh-TW": return "zh-Hant";
        case "iw": return "he";
        case "jw": return "jv";
        case "tl": return "fil";
        case "no": return "nb";
        default: return language;
    }
}

function azureLanguageToInternal(language: string): string {
    switch (language) {
        case "zh-Hans": return "zh-CN";
        case "zh-Hant": return "zh-TW";
        case "he": return "iw";
        case "jv": return "jw";
        case "fil": return "tl";
        case "nb": return "no";
        default: return language.toLowerCase();
    }
}

function getAzureTranslateUrl(sourceLang: string, targetLang: string): string {
    const state = useChatTranslatorSettings.getState();
    const endpoint = (state.azureEndpoint || "https://api.cognitive.microsofttranslator.com").trim();
    const url = new URL(endpoint);
    const trimmedPath = url.pathname.replace(/\/+$/, "");
    const isGlobalEndpoint = url.hostname === "api.cognitive.microsofttranslator.com";

    if (!trimmedPath) {
        url.pathname = isGlobalEndpoint ? "/translate" : "/translator/text/v3.0/translate";
    } else if (/\/translator\/text\/v3\.0\/translate$/i.test(trimmedPath) || /\/translate$/i.test(trimmedPath)) {
        url.pathname = trimmedPath;
    } else if (/\/translator\/text\/v3\.0$/i.test(trimmedPath)) {
        url.pathname = `${trimmedPath}/translate`;
    } else {
        url.pathname = isGlobalEndpoint ? "/translate" : "/translator/text/v3.0/translate";
    }

    url.searchParams.set("api-version", "3.0");

    const normalizedSource = normalizeAzureLanguage(sourceLang);
    const normalizedTarget = normalizeAzureLanguage(targetLang);

    if (!normalizedTarget) throw new Error("Azure Translator target language is not set.");
    if (normalizedSource) url.searchParams.set("from", normalizedSource);

    url.searchParams.append("to", normalizedTarget);
    return url.toString();
}

async function azureTranslate(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    const state = useChatTranslatorSettings.getState();
    if (!state.azureApiKey.trim()) throw new Error("Azure Translator API key is not set.");

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": state.azureApiKey.trim(),
    };

    if (state.azureRegion.trim()) {
        headers["Ocp-Apim-Subscription-Region"] = state.azureRegion.trim();
    }

    const res = await fetch(getAzureTranslateUrl(sourceLang, targetLang), {
        method: "POST",
        headers,
        body: JSON.stringify([{ Text: text }]),
        signal: timeoutSignal(15000),
    });

    const responseText = await res.text();
    if (!res.ok) {
        if (res.status === 429) throw new Error("Azure Translator rate limit exceeded.");
        throw new Error(`Azure Translator returned ${res.status} ${res.statusText}: ${responseText}`);
    }

    const [firstResult] = JSON.parse(responseText) as AzureTranslationResponseEntry[];
    const translated = firstResult?.translations?.[0];
    if (!translated?.text) throw new Error("Azure Translator returned an empty translation response.");

    const detectedSource = firstResult.detectedLanguage?.language
        ? azureLanguageToInternal(firstResult.detectedLanguage.language)
        : sourceLang;

    return {
        sourceLanguage: getLanguageDisplayName(detectedSource),
        text: translated.text,
    };
}

export async function testAzureConnection(): Promise<TranslationValue> {
    return azureTranslate("안녕하세요", "auto", "en");
}

export async function translate(kind: "received" | "sent", text: string, options?: ReceivedTranslationOptions): Promise<TranslationValue> {
    const state = useChatTranslatorSettings.getState();
    const prepared = prepareTextForTranslation(text);
    const rawSourceLang = options?.sourceLang ?? state[`${kind}Input`];
    const rawTargetLang = options?.targetLang ?? state[`${kind}Output`];
    const sourceLang = deeplLanguageToGoogleLanguage(rawSourceLang);
    const targetLang = deeplLanguageToGoogleLanguage(rawTargetLang);

    if (!prepared.hasMeaningfulText) {
        return {
            sourceLanguage: "",
            text,
        };
    }

    if ((state.service === "deepl" || state.service === "deepl-pro") && !state.deeplApiKey.trim()) {
        switchDeepLToGoogleIfApiKeyMissing();
        const translated = await fallbackToGoogle(prepared.text, rawSourceLang, rawTargetLang);

        return {
            ...translated,
            text: prepared.restore(translated.text),
        };
    }

    let translated: TranslationValue;

    if (state.service === "azure") {
        translated = await azureTranslate(prepared.text, sourceLang, targetLang);
    } else if (state.service === "deepl" || state.service === "deepl-pro") {
        try {
            translated = await deeplTranslate(state.service, prepared.text, rawSourceLang, rawTargetLang);
        } catch (error) {
            if (!/deepl.*quota exceeded|quota exceeded/i.test(error instanceof Error ? error.message : String(error))) throw error;

            // Quota errors happen after an in-flight request already has a DeepL request signature.
            // On mobile, changing the global service at that point can make pending message guards
            // treat the fallback result as stale, so keep the setting and use Google only for this try.
            showDeepLFallbackNotice(
                "deepl-quota",
                "DeepL quota is used up, so this translation used Google Translate."
            );
            logger.warn("[ChatTranslator] DeepL quota exceeded. Falling back to Google Translate for this request.");
            translated = await fallbackToGoogle(prepared.text, rawSourceLang, rawTargetLang);
        }
    } else {
        translated = await googleTranslate(prepared.text, sourceLang, targetLang);
    }

    const minimumGoogleConfidence = Number(state.googleConfidenceRequirement) || 0;
    if (
        kind === "received"
        && state.service === "google"
        && !options?.ignoreConfidenceRequirement
        && minimumGoogleConfidence > 0
        && translated.confidence != null
        && translated.confidence < minimumGoogleConfidence
    ) {
        throw new Error(`Low Google detection confidence (${translated.confidence.toFixed(2)} < ${minimumGoogleConfidence.toFixed(2)})`);
    }

    return {
        ...translated,
        text: prepared.restore(translated.text),
    };
}
