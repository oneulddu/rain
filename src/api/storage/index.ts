import { fileExists, readFile, writeFile } from "@api/native/fs";
import { FluxDispatcher } from "@metro/common";
import { create } from "zustand";
import { createJSONStorage, persist, StorageValue } from "zustand/middleware";

const storageOperationQueues = new Map<string, Promise<void>>();
const latestStorageWrites = new Map<string, Promise<void>>();
type PluginStoreRehydrator = () => Promise<void>;
const pluginStoreRehydrators = new Map<string, PluginStoreRehydrator>();
const pluginStoreHydrationErrors = new Set<string>();

function consumePersistenceResult(result: unknown) {
    if (result instanceof Promise) void result.catch(() => undefined);
}

function getErrorName(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
}

function enqueueStorageOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = storageOperationQueues.get(filePath) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    storageOperationQueues.set(filePath, tail);

    return result.finally(() => {
        if (storageOperationQueues.get(filePath) === tail) storageOperationQueues.delete(filePath);
    });
}

export function readStorageFile(filePath: string): Promise<string | null> {
    return enqueueStorageOperation(filePath, async () => {
        if (!await fileExists(filePath)) return null;
        return readFile(filePath);
    });
}

export function writeStorageFile(filePath: string, value: string): Promise<void> {
    const write = enqueueStorageOperation(filePath, () => writeFile(filePath, value));
    latestStorageWrites.set(filePath, write);
    void write.catch(() => undefined);
    return write;
}

export function updateStorageFile(
    filePath: string,
    update: (currentValue: string | null) => string | Promise<string>
): Promise<void> {
    const write = enqueueStorageOperation(filePath, async () => {
        const currentValue = await fileExists(filePath) ? await readFile(filePath) : null;
        await writeFile(filePath, await update(currentValue));
    });
    latestStorageWrites.set(filePath, write);
    void write.catch(() => undefined);
    return write;
}

export function waitForStorageWrites(filePath: string): Promise<void> {
    return latestStorageWrites.get(filePath) ?? Promise.resolve();
}

export function rehydratePluginStore(pluginName: string): Promise<void> {
    return pluginStoreRehydrators.get(pluginName)?.() ?? Promise.resolve();
}

export function hasPluginStoreHydrationFailed(pluginName: string): boolean {
    return pluginStoreHydrationErrors.has(pluginName);
}

export const createFileStorage = (filePath: string, canWrite: () => boolean = () => true) => {
    return {
        getItem: async (name: string): Promise<string | null> => {
            try {
                return await readStorageFile(filePath);
            } catch (e) {
                console.error(`Failed to read storage from '${filePath}'`, getErrorName(e));
                throw e;
            }
        },
        setItem: async (name: string, value: string): Promise<void> => {
            if (!canWrite()) {
                throw new Error(`Storage '${filePath}' is not writable before successful hydration.`);
            }

            try {
                await writeStorageFile(filePath, value);
            } catch (e) {
                console.error(`Failed to write storage to '${filePath}'`, getErrorName(e));
                throw e;
            }
        },
        removeItem: async (name: string): Promise<void> => {
            // we dont need this
        },
    };
};

export const createFlattenedFileStorage = <T>(filePath: string) => {
    return {
        getItem: async (name: string): Promise<string | null> => {
            try {
                const content = await readStorageFile(filePath);
                if (content == null) return null;
                const data = JSON.parse(content);
                if (data.state) return content;
                const wrapped: StorageValue<T> = {
                    state: data,
                    version: 0,
                };
                return JSON.stringify(wrapped);
            } catch (e) {
                console.error(`Failed to read flattened storage from '${filePath}'`, getErrorName(e));
                return null;
            }
        },
        setItem: async (name: string, value: string): Promise<void> => {
            try {
                const parsed = JSON.parse(value) as StorageValue<T>;
                const rawState = JSON.stringify(parsed.state);
                await writeStorageFile(filePath, rawState);
            } catch (e) {
                console.error(`Failed to write flattened storage to '${filePath}'`, getErrorName(e));
                throw e;
            }
        },
        removeItem: async () => {},
    };
};

interface HydratableStore<T extends { _hasHydrated: boolean }> {
    getState: () => T;
    subscribe: (listener: (state: T) => void) => () => void;
}

export async function waitForHydration<T extends { _hasHydrated: boolean }>(
    usePluginSettings: HydratableStore<T>
): Promise<void> {
    return new Promise(resolve => {
        if (usePluginSettings.getState()._hasHydrated) {
            resolve();
            return;
        }

        let timeout: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = usePluginSettings.subscribe(state => {
            if (state._hasHydrated) {
                unsubscribe();
                if (timeout) clearTimeout(timeout);
                resolve();
            }
        });

        timeout = setTimeout(() => {
            timeout = null;
            unsubscribe();
            resolve();
        }, 5000);
    });
}

export type PluginStore<T> = T & {
    updateSettings: (settings: Partial<T>) => void;
    _hasHydrated: boolean;
    setHasHydrated: (state: boolean) => void;
};

interface CreatePluginStoreOptions {
    emitSettingUpdated?: boolean;
}

export function createPluginStore<T extends object>(
    pluginName: string,
    initialState: T,
    { emitSettingUpdated = true }: CreatePluginStoreOptions = {}
) {
    const storagePath = `plugins/${pluginName}.json`;
    let hydrationRetryCount = 0;
    let hydrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let persistenceEnabled = false;
    let retryHydration: (() => void) | null = null;
    const useStore = create<PluginStore<T>>()(
        persist(
            set => ({
                ...initialState,
                _hasHydrated: false,
                updateSettings: newSettings =>
                    consumePersistenceResult(set(state => ({ ...state, ...newSettings }))),
                setHasHydrated: (state: boolean) =>
                    consumePersistenceResult(set({ _hasHydrated: state } as Partial<PluginStore<T>>)),
            }),
            {
                name: `${pluginName}-settings`,
                storage: createJSONStorage(() => createFileStorage(storagePath, () => persistenceEnabled)),
                merge: (persistedState, currentState) => {
                    const persistedSettings: Partial<PluginStore<T>> = persistedState
                        && typeof persistedState === "object"
                        && !Array.isArray(persistedState)
                        ? { ...persistedState as Partial<PluginStore<T>> }
                        : {};
                    delete persistedSettings._hasHydrated;
                    delete persistedSettings.setHasHydrated;
                    delete persistedSettings.updateSettings;

                    return {
                        ...currentState,
                        ...persistedSettings,
                        _hasHydrated: false,
                    };
                },
                onRehydrateStorage: () => state => {
                    if (state) {
                        persistenceEnabled = true;
                        pluginStoreHydrationErrors.delete(pluginName);
                        hydrationRetryCount = 0;
                        if (hydrationRetryTimer) {
                            clearTimeout(hydrationRetryTimer);
                            hydrationRetryTimer = null;
                        }
                        state.setHasHydrated(true);
                    } else {
                        persistenceEnabled = false;
                        pluginStoreHydrationErrors.add(pluginName);
                        if (!hydrationRetryTimer && hydrationRetryCount < 5) {
                            const delay = Math.min(16000, 1000 * 2 ** hydrationRetryCount++);
                            hydrationRetryTimer = setTimeout(() => {
                                hydrationRetryTimer = null;
                                retryHydration?.();
                            }, delay);
                        }
                    }
                },
                partialize: state => {
                    const persistedSettings: Partial<PluginStore<T>> = { ...state };
                    delete persistedSettings._hasHydrated;
                    delete persistedSettings.setHasHydrated;
                    delete persistedSettings.updateSettings;
                    return persistedSettings as PluginStore<T>;
                },
            }
        )
    );
    retryHydration = () => {
        void Promise.resolve(useStore.persist.rehydrate()).catch(() => undefined);
    };
    pluginStoreRehydrators.set(pluginName, async () => {
        await useStore.persist.rehydrate();
        if (pluginStoreHydrationErrors.has(pluginName)) {
            throw new Error(`Failed to hydrate plugin storage '${pluginName}'.`);
        }
    });

    if (emitSettingUpdated) {
        useStore.subscribe((state, prevState) => {
            if (state._hasHydrated && JSON.stringify(state) !== JSON.stringify(prevState)) {
                FluxDispatcher.dispatch({ type: "RAIN_SETTING_UPDATED" });
            }
        });
    }

    const settingsProxy = new Proxy({} as T, {
        get(_, prop: string) {
            const state = useStore.getState();
            if (prop.includes(".")) {
                const [parent, child] = prop.split(".");
                return (state as any)[parent]?.[child];
            }
            return (state as any)[prop];
        },
        set(_, prop: string, value: any) {
            const state = useStore.getState();
            if (prop.includes(".")) {
                const [parent, child] = prop.split(".");
                state.updateSettings({
                    [parent]: { ...(state as any)[parent], [child]: value }
                } as any);
            } else {
                state.updateSettings({ [prop]: value } as any);
            }
            return true;
        },
    });

    return { useStore, settings: settingsProxy };
}
