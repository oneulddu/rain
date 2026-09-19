import { initFetchI18nStrings } from "@i18n";
import { initEagerPlugins, initPlugins } from "@plugins/index";
import { versionCheck } from "@rain/pages/Updater";

import { initDebugger, patchLogHook } from "./api/debug";
import { injectFluxInterceptor } from "./api/flux";
import { patchJsx } from "./api/react/jsx";
import { bootStage } from "./bootDiagnostics";
import * as lib from "./lib";

export default async () => {
    bootStage("05 core patches starting");
    const critical = await Promise.all([
        patchLogHook(),
        patchJsx(),
        injectFluxInterceptor(),
    ]);

    bootStage("06 core patches ready; plugins and translations starting");
    const core = await Promise.all([
        initEagerPlugins(),
        initFetchI18nStrings(),
    ]);

    bootStage("07 eager plugins and translations ready");
    critical.forEach(f => { if (f !== undefined) lib.unload.push(f); });
    core.forEach(f => { if (f !== undefined) lib.unload.push(f); });

    window.rain = lib;

    initDebugger();

    versionCheck();
};

export { initPlugins };
