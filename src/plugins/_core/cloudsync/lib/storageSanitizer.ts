const CHAT_TRANSLATOR_SENSITIVE_STORAGE_KEYS = new Set(["azureApiKey", "deeplApiKey"]);
const NO_SENSITIVE_STORAGE_KEYS = new Set<string>();

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function stripNoCloudSync(obj: unknown, sensitiveKeys = NO_SENSITIVE_STORAGE_KEYS): unknown {
    if (Array.isArray(obj)) {
        const filtered: unknown[] = [];
        for (const value of obj) {
            const replacement = stripNoCloudSync(value, sensitiveKeys);
            if (replacement !== undefined) filtered.push(replacement);
        }
        return filtered;
    }

    if (!isObjectRecord(obj)) return obj;
    if (obj.__no_cloud_sync || obj.__no_sync) return undefined;

    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (key.startsWith("__") || sensitiveKeys.has(key)) continue;

        const replacement = stripNoCloudSync(value, sensitiveKeys);
        if (replacement !== undefined) filtered[key] = replacement;
    }
    return filtered;
}

function parseSanitizedStorage(storage: string, sensitiveKeys: Set<string>): unknown {
    return stripNoCloudSync(JSON.parse(storage), sensitiveKeys);
}

export function sanitizePluginStorage(pluginId: string, storage: string): string {
    const sensitiveKeys = pluginId === "chattranslator"
        ? CHAT_TRANSLATOR_SENSITIVE_STORAGE_KEYS
        : NO_SENSITIVE_STORAGE_KEYS;
    return JSON.stringify(parseSanitizedStorage(storage, sensitiveKeys) ?? null);
}

export function prepareImportedPluginStorage(
    pluginId: string,
    incomingStorage: string,
    localStorage: string | null
): string {
    if (pluginId !== "chattranslator") return incomingStorage;

    const incoming = parseSanitizedStorage(
        incomingStorage,
        CHAT_TRANSLATOR_SENSITIVE_STORAGE_KEYS
    );
    if (!isObjectRecord(incoming)) return localStorage ?? JSON.stringify(incoming ?? null);
    if (!localStorage) return JSON.stringify(incoming);

    let local: unknown;
    try {
        local = JSON.parse(localStorage);
    } catch {
        return JSON.stringify(incoming);
    }

    if (!isObjectRecord(local)) return JSON.stringify(incoming);
    if (!isObjectRecord(incoming.state)) return localStorage;
    if (!isObjectRecord(local.state)) {
        return JSON.stringify(incoming);
    }

    for (const key of CHAT_TRANSLATOR_SENSITIVE_STORAGE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(local.state, key)) {
            incoming.state[key] = local.state[key];
        }
    }

    return JSON.stringify(incoming);
}
