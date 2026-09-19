import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";

function fixture(enabled, globals = {}) {
    const code = transformSync(fs.readFileSync(new URL("../src/bootDiagnostics.ts", import.meta.url), "utf8"), {
        loader: "ts", format: "cjs", define: { __RAIN_DIAGNOSTICS__: String(enabled) },
    }).code;
    const timers = [];
    const module = { exports: {} };
    const context = { module, exports: module.exports, setTimeout: fn => timers.push(fn), ...globals };
    vm.runInNewContext(code, context);
    return { stage: module.exports.bootStage, timers, context };
}

test("normal builds do not collect or display diagnostics", () => {
    const f = fixture(false);
    f.stage("test");
    assert.equal(f.timers.length, 0);
    assert.equal(f.context.__RAIN_BOOT_REPORT__, undefined);
});

test("diagnostics work before Metro and capture an initialization failure", () => {
    let message;
    const f = fixture(true, { alert: value => { message = value; } });
    f.stage("01 bundle executing");
    f.stage("FAIL initializeRain", new Error("missing native module"));
    assert.equal(f.timers.length, 1);
    f.timers.shift()();
    assert.match(message, /01 bundle executing/);
    assert.match(message, /missing native module/);
});

test("native alert and local report do not depend on Rain initialization", () => {
    let message, report;
    const f = fixture(true, { __turboModuleProxy: name => {
        if (name === "AlertManager") return { alertWithArgs: args => { message = args.message; } };
        if (name === "NativeFileModule") return { writeFile: (_dir, path, data) => { report = { path, data }; } };
    } });
    f.stage("02 waiting for Discord require");
    f.timers.shift()();
    assert.equal(report.path, "rain/boot-diagnostic.txt");
    assert.equal(report.data, message);
});

test("missing native UI retries are bounded", () => {
    const f = fixture(true, { __turboModuleProxy: () => { throw Error("not ready"); } });
    f.stage("waiting");
    let count = 0;
    while (f.timers.length && count < 20) { f.timers.shift()(); count++; }
    assert.equal(count, 6);
    assert.equal(f.timers.length, 0);
});
