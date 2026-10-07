const PRESERVED_SEGMENT_PATTERNS = [
    /https?:\/\/\S+/g,
    /<a?:[A-Za-z0-9_~]+:\d+>/g,
    /<@[!&]?\d+>/g,
    /<#\d+>/g,
    /<\/[^:>]+:\d+>/g,
    /<t:\d+(?::[tTdDfFR])?>/g,
] as const;

export interface PreparedTranslationText {
    hasMeaningfulText: boolean;
    restore: (text: string) => string;
    text: string;
}

function replaceFencedCodeBlocks(text: string, replace: (block: string) => string): string {
    const openingFencePattern = /^[ \t]*(?:>[ \t]?)*(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
    let cursor = 0;
    let output = "";
    let openingMatch: RegExpExecArray | null;

    while ((openingMatch = openingFencePattern.exec(text))) {
        const openingFence = openingMatch[1];
        const closingFencePattern = new RegExp(
            `^[ \\t]*(?:>[ \\t]?)*${openingFence[0]}{${openingFence.length},}[ \\t]*(?:\\n|$)`,
            "gm"
        );
        closingFencePattern.lastIndex = openingFencePattern.lastIndex;
        const closingMatch = closingFencePattern.exec(text);
        const endIndex = closingMatch ? closingFencePattern.lastIndex : text.length;

        output += text.slice(cursor, openingMatch.index);
        output += replace(text.slice(openingMatch.index, endIndex));
        cursor = endIndex;
        openingFencePattern.lastIndex = endIndex;
    }

    return output + text.slice(cursor);
}

function isEscaped(text: string, index: number): boolean {
    let backslashes = 0;
    for (let current = index - 1; current >= 0 && text[current] === "\\"; current--) backslashes++;
    return backslashes % 2 === 1;
}

function replaceInlineCode(text: string, replace: (code: string) => string): string {
    let cursor = 0;
    let output = "";

    for (let index = 0; index < text.length;) {
        if (text[index] !== "`" || isEscaped(text, index)) {
            index++;
            continue;
        }

        let delimiterLength = 1;
        while (text[index + delimiterLength] === "`") delimiterLength++;
        const delimiter = "`".repeat(delimiterLength);
        const lineEnd = text.indexOf("\n", index + delimiterLength);
        let closingIndex = text.indexOf(delimiter, index + delimiterLength);

        while (
            closingIndex !== -1
            && (
                isEscaped(text, closingIndex)
                || text[closingIndex - 1] === "`"
                || text[closingIndex + delimiterLength] === "`"
            )
        ) {
            closingIndex = text.indexOf(delimiter, closingIndex + delimiterLength);
        }
        if (lineEnd !== -1 && closingIndex > lineEnd) closingIndex = -1;
        if (closingIndex === -1) {
            index += delimiterLength;
            continue;
        }

        const endIndex = closingIndex + delimiterLength;
        output += text.slice(cursor, index);
        output += replace(text.slice(index, endIndex));
        cursor = endIndex;
        index = endIndex;
    }

    return output + text.slice(cursor);
}

function createPreservedTokenPattern(text: string): { pattern: RegExp; tokenPrefix: string } {
    let tokenPrefix = "⟪RAIN_CHAT_TRANSLATOR_TOKEN_";

    while (text.includes(tokenPrefix)) tokenPrefix += "_";

    return {
        pattern: new RegExp(`${tokenPrefix}(\\d+)⟫`, "g"),
        tokenPrefix,
    };
}

export function prepareTextForTranslation(text: string): PreparedTranslationText {
    const preservedValues: string[] = [];
    const { pattern: preservedTokenPattern, tokenPrefix } = createPreservedTokenPattern(text);
    const preserve = (match: string) => {
        const token = `${tokenPrefix}${preservedValues.length}⟫`;
        preservedValues.push(match);
        return token;
    };
    let masked = replaceFencedCodeBlocks(text, preserve);
    masked = replaceInlineCode(masked, preserve);

    for (const pattern of PRESERVED_SEGMENT_PATTERNS) {
        masked = masked.replace(pattern, preserve);
    }

    const strippedForDetection = masked.replace(preservedTokenPattern, " ").trim();

    return {
        hasMeaningfulText: /[\p{L}\p{N}]/u.test(strippedForDetection),
        restore: translatedText => {
            const restoredCounts = preservedValues.map(() => 0);
            let hasInvalidToken = false;
            const restored = translatedText.replace(preservedTokenPattern, (_, rawIndex) => {
                const index = Number(rawIndex);
                if (!Number.isInteger(index) || index < 0 || index >= restoredCounts.length) {
                    hasInvalidToken = true;
                    return "";
                }

                restoredCounts[index]++;
                return preservedValues[index];
            });

            if (hasInvalidToken || restoredCounts.some(count => count !== 1)) {
                throw new Error("Translation service changed protected message content.");
            }

            return restored;
        },
        text: masked,
    };
}

export function hasMeaningfulTextForTranslation(text: string): boolean {
    return prepareTextForTranslation(text).hasMeaningfulText;
}
