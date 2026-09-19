declare const __RAIN_DIAGNOSTICS__: boolean;

const events: string[] = [];
let pending = false;
let shown = false;
let attempts = 0;

function nativeModule(name: string) {
    const root = globalThis as any;
    try { return root.__turboModuleProxy?.(name) ?? root.nativeModuleProxy?.[name]; }
    catch { return undefined; }
}

function showReport() {
    pending = false;
    const root = globalThis as any;
    const report = `Rain diagnostic 0919\n${events.join("\n")}\nrequire=${typeof root.__r}, modules=${root.modules instanceof Map ? "Map" : typeof root.modules}`;
    root.__RAIN_BOOT_REPORT__ = report;
    try {
        const files = nativeModule("NativeFileModule") ?? nativeModule("RTNFileManager") ?? nativeModule("DCDFileManager");
        const write = files?.writeFile?.("documents", "rain/boot-diagnostic.txt", report, "utf8");
        write?.catch?.(() => {});
    } catch { /* Keep diagnostics independent of Rain's native module wrapper. */ }
    try {
        const manager = nativeModule("AlertManager");
        if (typeof manager?.alertWithArgs === "function") {
            manager.alertWithArgs({ title: "Rain diagnostic 0919", message: report, buttons: [{ "0": "OK" }] }, () => {});
            shown = true;
        } else if (typeof root.alert === "function") {
            root.alert(report);
            shown = true;
        }
    } catch { /* Discord may not have registered native UI yet. */ }
    if (!shown && ++attempts < 6) scheduleReport(3000);
}

function scheduleReport(delay = 10000) {
    if (pending || shown || typeof globalThis.setTimeout !== "function") return;
    pending = true;
    globalThis.setTimeout(showReport, delay);
}

export function bootStage(stage: string, error?: unknown) {
    if (!__RAIN_DIAGNOSTICS__) return;
    let detail = "";
    try { if (error !== undefined) detail = `: ${String((error as any)?.stack ?? error).slice(0, 1800)}`; }
    catch { detail = ": unreadable error"; }
    events.push(`${stage}${detail}`);
    if (events.length > 35) events.shift();
    (globalThis as any).__RAIN_BOOT_REPORT__ = events.join("\n");
    scheduleReport();
}
