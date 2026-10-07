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
import {
    runAbortableTranslationRequest,
    TranslationRequestCancelledError,
    type TranslationRequestCompletionReporter,
} from "./requests";
import { ChatTranslatorSettings, TranslationService, useChatTranslatorSettings } from "./storage";
import {
    hasMeaningfulTextForTranslation,
    prepareTextForTranslation,
} from "./text";

export { hasMeaningfulTextForTranslation } from "./text";

export interface DiscordMessage {
    __chatTranslator?: boolean;
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
    reportRequestCompletion?: TranslationRequestCompletionReporter;
    signal?: AbortSignal;
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
const TRANSLATION_REQUEST_TIMEOUT_MS = 15000;

async function fetchAndConsumeWithTimeout<T>(
    input: RequestInfo | URL,
    init: RequestInit,
    externalSignal: AbortSignal | undefined,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    reportCompletion?: TranslationRequestCompletionReporter
): Promise<T> {
    return runAbortableTranslationRequest(
        externalSignal,
        TRANSLATION_REQUEST_TIMEOUT_MS,
        async signal => {
            const response = await fetch(input, { ...init, signal });
            return consume(response, signal);
        },
        reportCompletion
    );
}

async function parseOptionalJson<T>(response: Response, signal: AbortSignal): Promise<T> {
    try {
        return await response.json() as T;
    } catch (error) {
        if (signal.aborted) throw new TranslationRequestCancelledError();
        if (isTranslationAbortError(error)) throw error;
        return {} as T;
    }
}

export function isTranslationAbortError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "name" in error
        && error.name === "AbortError";
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

interface ParsedIdListCache {
    ids: Set<string>;
    value: string;
}

const ignoredIdListCache: Record<"ignoredChannels" | "ignoredGuilds" | "ignoredUsers", ParsedIdListCache> = {
    ignoredChannels: { ids: new Set(), value: "" },
    ignoredGuilds: { ids: new Set(), value: "" },
    ignoredUsers: { ids: new Set(), value: "" },
};

function getCachedIdList(settingKey: keyof typeof ignoredIdListCache): Set<string> {
    const value = useChatTranslatorSettings.getState()[settingKey] ?? "";
    const cached = ignoredIdListCache[settingKey];

    if (cached.value !== value) {
        cached.ids = parseIdList(value);
        cached.value = value;
    }

    return cached.ids;
}

function writeIdList(settingKey: "ignoredGuilds" | "ignoredChannels" | "ignoredUsers", ids: Set<string>) {
    const update: Partial<ChatTranslatorSettings> = {
        [settingKey]: Array.from(ids).join(","),
    };
    useChatTranslatorSettings.getState().updateSettings(update);
}

export function getIgnoredGuilds(): Set<string> {
    return new Set(getCachedIdList("ignoredGuilds"));
}

export function getIgnoredChannels(): Set<string> {
    return new Set(getCachedIdList("ignoredChannels"));
}

export function getIgnoredUsers(): Set<string> {
    return new Set(getCachedIdList("ignoredUsers"));
}

export function isIgnoredGuild(guildId?: string | null): boolean {
    return !!guildId && getCachedIdList("ignoredGuilds").has(guildId);
}

export function isIgnoredChannel(channelId?: string | null): boolean {
    return !!channelId && getCachedIdList("ignoredChannels").has(channelId);
}

export function isIgnoredUser(userId?: string | null): boolean {
    return !!userId && getCachedIdList("ignoredUsers").has(userId);
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
    return Object.prototype.hasOwnProperty.call(useChatTranslatorSettings.getState().receivedChannelOverrides ?? {}, channelId);
}

export function getReceivedAutoTranslateChannelState(channelId?: string | null): boolean {
    const state = useChatTranslatorSettings.getState();
    if (!channelId) return state.autoTranslateReceived;
    return (state.receivedChannelOverrides ?? {})[channelId] ?? state.autoTranslateReceived;
}

export function setReceivedAutoTranslateChannelState(channelId: string, enabled: boolean) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...(state.receivedChannelOverrides ?? {}) };

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
    const overrides = { ...(state.receivedChannelOverrides ?? {}) };
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
        sourceLang: channelId ? (state.receivedChannelInputOverrides ?? {})[channelId] ?? state.receivedInput : state.receivedInput,
        targetLang: channelId ? (state.receivedChannelOutputOverrides ?? {})[channelId] ?? state.receivedOutput : state.receivedOutput,
    };
}

export function setReceivedInputLanguageForChannel(channelId: string, value: string) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...(state.receivedChannelInputOverrides ?? {}) };
    const normalized = normalizeLanguageForService(value, state.service, true);

    if (!value || normalized === state.receivedInput) delete overrides[channelId];
    else overrides[channelId] = normalized;

    state.updateSettings({ receivedChannelInputOverrides: overrides });
}

export function setReceivedOutputLanguageForChannel(channelId: string, value: string) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...(state.receivedChannelOutputOverrides ?? {}) };
    const normalized = normalizeLanguageForService(value, state.service, false);

    if (!value || normalized === state.receivedOutput) delete overrides[channelId];
    else overrides[channelId] = normalized;

    state.updateSettings({ receivedChannelOutputOverrides: overrides });
}

export function setReceivedLanguagesForChannel(channelId: string, sourceValue: string, targetValue: string) {
    const state = useChatTranslatorSettings.getState();
    const inputOverrides = { ...(state.receivedChannelInputOverrides ?? {}) };
    const outputOverrides = { ...(state.receivedChannelOutputOverrides ?? {}) };
    const source = normalizeLanguageForService(sourceValue, state.service, true);
    const target = normalizeLanguageForService(targetValue, state.service, false);

    if (!sourceValue || source === state.receivedInput) delete inputOverrides[channelId];
    else inputOverrides[channelId] = source;

    if (!targetValue || target === state.receivedOutput) delete outputOverrides[channelId];
    else outputOverrides[channelId] = target;

    state.updateSettings({
        receivedChannelInputOverrides: inputOverrides,
        receivedChannelOutputOverrides: outputOverrides,
    });
}

export function clearReceivedInputLanguageOverride(channelId: string) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...(state.receivedChannelInputOverrides ?? {}) };
    delete overrides[channelId];
    state.updateSettings({ receivedChannelInputOverrides: overrides });
}

export function clearReceivedOutputLanguageOverride(channelId: string) {
    const state = useChatTranslatorSettings.getState();
    const overrides = { ...(state.receivedChannelOutputOverrides ?? {}) };
    delete overrides[channelId];
    state.updateSettings({ receivedChannelOutputOverrides: overrides });
}

export function clearReceivedLanguageOverrides(channelId: string) {
    const state = useChatTranslatorSettings.getState();
    const inputOverrides = { ...(state.receivedChannelInputOverrides ?? {}) };
    const outputOverrides = { ...(state.receivedChannelOutputOverrides ?? {}) };
    delete inputOverrides[channelId];
    delete outputOverrides[channelId];
    state.updateSettings({
        receivedChannelInputOverrides: inputOverrides,
        receivedChannelOutputOverrides: outputOverrides,
    });
}

function countMessageLines(text: string): number {
    if (!text) return 0;
    return text.split(/\r?\n/).length;
}

function hasCodeBlock(text: string): boolean {
    return /(?:^|\n)[ \t]*(?:>[ \t]?)*(?:`{3,}|~{3,})/.test(text);
}

function looksAlreadyTranslated(text: string): boolean {
    return /(?:^|\n)\s*(?:-#\s*)?(?:\*?\(translated\)\*?|translated from\s+[^\n]+|translated by chattranslator)\s*$/i.test(text.trim())
        || /`\([^`\n]+\s→\s[^`\n]+\)`\s*$/.test(text.trim());
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
    if (/deepl.*api key is not set|api key is not set/i.test(message)) return "DeepL API key is missing.";
    if (/deepl.*quota exceeded|quota exceeded/i.test(message)) return "DeepL quota is used up.";
    if (/low google detection confidence/i.test(message)) return "Skipped: low Google detection confidence";
    if (/invalid .*api key|invalid azure|invalid deepl|401|403/i.test(message)) return "Invalid API key or translation service setting.";
    if (/rate limit|returned 429/i.test(message)) return "The translation service rate limit was reached.";
    if (/failed to connect|fetch failed|network|certificate|abort|timed out/i.test(message)) return "Network or certificate error while translating.";
    if (/empty translation response/i.test(message)) return "The translation service returned an empty response.";
    if (/target language is not set/i.test(message)) return "The target language is not set.";
    if (/service is not selected/i.test(message)) return "The requested translation service is not selected.";
    if (/invalid url/i.test(message)) return "The translation service endpoint is invalid.";

    return "The translation service returned an unexpected error.";
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

function getTranslationRequestSignatureFromValues(
    sourceLang: string | undefined,
    targetLang: string | undefined,
    includeGoogleConfidence: boolean
): string {
    const state = useChatTranslatorSettings.getState();
    const serviceSettings = state.service === "google"
        ? [includeGoogleConfidence ? String(Number(state.googleConfidenceRequirement) || 0) : ""]
        : state.service === "azure"
            ? [
                createSecretFingerprint(state.azureApiKey),
                state.azureRegion.trim(),
                state.azureEndpoint.trim(),
            ]
            : [createSecretFingerprint(state.deeplApiKey)];

    return JSON.stringify([
        state.service,
        normalizeCacheSignatureLanguage(sourceLang, false),
        normalizeCacheSignatureLanguage(targetLang, true),
        ...serviceSettings,
    ]);
}

export function getReceivedTranslationRequestSignatureFromValues(sourceLang?: string, targetLang?: string): string {
    return getTranslationRequestSignatureFromValues(sourceLang, targetLang, true);
}

export function getReceivedTranslationNetworkSignatureFromValues(sourceLang?: string, targetLang?: string): string {
    return getTranslationRequestSignatureFromValues(sourceLang, targetLang, false);
}

export function getSentTranslationRequestSignatureFromValues(sourceLang?: string, targetLang?: string): string {
    return getTranslationRequestSignatureFromValues(sourceLang, targetLang, false);
}

export function getGoogleConfidenceSkipReason(
    translated: TranslationValue,
    ignoreConfidenceRequirement = false
): string | null {
    const state = useChatTranslatorSettings.getState();
    const minimum = Number(state.googleConfidenceRequirement) || 0;

    if (
        state.service !== "google"
        || ignoreConfidenceRequirement
        || minimum <= 0
        || translated.confidence == null
        || translated.confidence >= minimum
    ) return null;

    return `Skipped: low Google detection confidence (${translated.confidence.toFixed(2)} < ${minimum.toFixed(2)})`;
}

function showDeepLFallbackNotice(key: string, message: string) {
    if (shownDeepLFallbackNotices.has(key)) return;

    shownDeepLFallbackNotices.add(key);
    try {
        showToast(message, LanguageIcon);
    } catch (error) {
        logger.error(
            "[ChatTranslator] Failed to show a translation fallback notice",
            error instanceof Error ? error.name : "UnknownError"
        );
    }
}

async function googleTranslate(
    text: string,
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal,
    reportCompletion?: TranslationRequestCompletionReporter
): Promise<TranslationValue> {
    const url = "https://translate.googleapis.com/translate_a/single?" + new URLSearchParams({
        client: "gtx",
        sl: sourceLang || "auto",
        tl: targetLang || "en",
        dt: "t",
        dj: "1",
        source: "input",
        q: text,
    });

    return fetchAndConsumeWithTimeout(url, {}, signal, async res => {
        if (!res.ok) throw new Error(`Google Translate returned ${res.status} ${res.statusText}`);

        const response = await res.json() as GoogleTranslateResponse;
        const translation = Array.isArray(response.sentences)
            ? response.sentences
                .map(sentence => sentence?.trans)
                .filter((part): part is string => typeof part === "string")
                .join("")
            : "";
        if (!translation.trim()) throw new Error("Google Translate returned an empty translation response.");

        const detectedSource = typeof response.src === "string"
            ? response.src
            : typeof response.ld_result?.srclangs?.[0] === "string"
                ? response.ld_result.srclangs[0]
                : sourceLang;
        const rawConfidence = response.confidence ?? response.ld_result?.srclangs_confidences?.[0];
        const confidence = typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
            ? rawConfidence
            : undefined;

        return {
            confidence,
            sourceLanguage: getLanguageDisplayName(detectedSource),
            text: translation,
        };
    }, reportCompletion);
}

async function deeplTranslate(
    service: TranslationService,
    text: string,
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal,
    reportCompletion?: TranslationRequestCompletionReporter
): Promise<TranslationValue> {
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

    return fetchAndConsumeWithTimeout(endpoint, {
        method: "POST",
        headers: {
            Authorization: `DeepL-Auth-Key ${state.deeplApiKey.trim()}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
    }, signal, async (res, requestSignal) => {
        const response = await parseOptionalJson<DeepLTranslateResponse>(res, requestSignal);
        if (!res.ok) {
            if (res.status === 456) throw new Error("DeepL API quota exceeded.");
            throw new Error(response.message || `DeepL returned ${res.status} ${res.statusText}`);
        }

        const first = Array.isArray(response.translations) ? response.translations[0] : undefined;
        if (typeof first?.text !== "string" || !first.text.trim()) {
            throw new Error("DeepL returned an empty translation response.");
        }
        const detectedSource = typeof first.detected_source_language === "string"
            ? first.detected_source_language
            : sourceLang;

        return {
            sourceLanguage: getLanguageDisplayName(detectedSource),
            text: first.text,
        };
    }, reportCompletion);
}

async function fallbackToGoogle(
    text: string,
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal,
    reportCompletion?: TranslationRequestCompletionReporter
): Promise<TranslationValue> {
    return googleTranslate(
        text,
        deeplLanguageToGoogleLanguage(sourceLang || "auto"),
        deeplLanguageToGoogleLanguage(targetLang || "en"),
        signal,
        reportCompletion
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

export async function getDeeplUsage(signal?: AbortSignal): Promise<DeepLUsageResponse> {
    const state = useChatTranslatorSettings.getState();
    if (state.service !== "deepl" && state.service !== "deepl-pro") {
        throw new Error("DeepL service is not selected.");
    }

    const apiKey = state.deeplApiKey.trim();
    if (!apiKey) throw new Error("DeepL API key is not set.");

    const endpoint = state.service === "deepl-pro"
        ? "https://api.deepl.com/v2/usage"
        : "https://api-free.deepl.com/v2/usage";

    return fetchAndConsumeWithTimeout(endpoint, {
        headers: {
            Authorization: `DeepL-Auth-Key ${apiKey}`,
        },
    }, signal, async (res, requestSignal) => {
        const response = await parseOptionalJson<DeepLUsageResponse>(res, requestSignal);
        if (!res.ok) {
            if (res.status === 403) throw new Error("DeepL API key is invalid or does not match the selected Free/Pro service.");
            if (res.status === 456) throw new Error("DeepL API quota exceeded.");
            throw new Error(response.message || `DeepL usage returned ${res.status} ${res.statusText}`);
        }

        return response;
    });
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

async function azureTranslate(
    text: string,
    sourceLang: string,
    targetLang: string,
    signal?: AbortSignal,
    reportCompletion?: TranslationRequestCompletionReporter
): Promise<TranslationValue> {
    const state = useChatTranslatorSettings.getState();
    if (!state.azureApiKey.trim()) throw new Error("Azure Translator API key is not set.");

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": state.azureApiKey.trim(),
    };

    if (state.azureRegion.trim()) {
        headers["Ocp-Apim-Subscription-Region"] = state.azureRegion.trim();
    }

    return fetchAndConsumeWithTimeout(getAzureTranslateUrl(sourceLang, targetLang), {
        method: "POST",
        headers,
        body: JSON.stringify([{ Text: text }]),
    }, signal, async res => {
        const responseText = await res.text();
        if (!res.ok) {
            if (res.status === 429) throw new Error("Azure Translator rate limit exceeded.");
            throw new Error(`Azure Translator returned ${res.status} ${res.statusText}`);
        }

        const response = JSON.parse(responseText) as AzureTranslationResponseEntry[];
        const firstResult = Array.isArray(response) ? response[0] : undefined;
        const translated = Array.isArray(firstResult?.translations) ? firstResult.translations[0] : undefined;
        if (typeof translated?.text !== "string" || !translated.text.trim()) {
            throw new Error("Azure Translator returned an empty translation response.");
        }

        const detectedSource = typeof firstResult?.detectedLanguage?.language === "string"
            ? azureLanguageToInternal(firstResult.detectedLanguage.language)
            : sourceLang;

        return {
            sourceLanguage: getLanguageDisplayName(detectedSource),
            text: translated.text,
        };
    }, reportCompletion);
}

export async function testAzureConnection(signal?: AbortSignal): Promise<TranslationValue> {
    return azureTranslate("안녕하세요", "auto", "en", signal);
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
        const translated = await fallbackToGoogle(
            prepared.text,
            rawSourceLang,
            rawTargetLang,
            options?.signal,
            options?.reportRequestCompletion
        );

        return {
            ...translated,
            text: prepared.restore(translated.text),
        };
    }

    let translated: TranslationValue;

    if (state.service === "azure") {
        translated = await azureTranslate(
            prepared.text,
            sourceLang,
            targetLang,
            options?.signal,
            options?.reportRequestCompletion
        );
    } else if (state.service === "deepl" || state.service === "deepl-pro") {
        try {
            translated = await deeplTranslate(
                state.service,
                prepared.text,
                rawSourceLang,
                rawTargetLang,
                options?.signal,
                options?.reportRequestCompletion
            );
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
            translated = await fallbackToGoogle(
                prepared.text,
                rawSourceLang,
                rawTargetLang,
                options?.signal,
                options?.reportRequestCompletion
            );
        }
    } else {
        translated = await googleTranslate(
            prepared.text,
            sourceLang,
            targetLang,
            options?.signal,
            options?.reportRequestCompletion
        );
    }

    return {
        ...translated,
        text: prepared.restore(translated.text),
    };
}
