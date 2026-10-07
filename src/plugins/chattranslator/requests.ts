import type { TranslationValue } from "./utils";

export type TranslationRequestPriority = "background" | "interactive";

export interface TranslationRequestHandle<T> {
    promise: Promise<T>;
    release: () => void;
}

export interface TranslationRequestCoordinatorStats {
    active: number;
    backgroundQueued: number;
    interactiveQueued: number;
    shared: number;
}

interface TranslationRequestCoordinatorOptions {
    maxBackgroundQueued: number;
    maxConcurrent: number;
    maxInteractiveQueued?: number;
    maxQueueWaitMs?: number;
}

interface QueuedRequest<T> {
    consumers: Set<symbol>;
    controller: AbortController;
    execute: (signal: AbortSignal) => Promise<T>;
    key: string;
    priority: TranslationRequestPriority;
    promise: Promise<T>;
    queueTimer?: ReturnType<typeof setTimeout>;
    reject: (reason: unknown) => void;
    resolve: (value: T | PromiseLike<T>) => void;
    settled: boolean;
    started: boolean;
}

export class TranslationRequestCancelledError extends Error {
    override name = "AbortError";

    constructor(message = "Translation request was cancelled.") {
        super(message);
    }
}

export function isTranslationRequestCancelled(error: unknown): boolean {
    return error instanceof TranslationRequestCancelledError
        || (
            typeof error === "object"
            && error !== null
            && "name" in error
            && error.name === "AbortError"
        );
}

const translationExecutionCompletions = new WeakMap<Promise<unknown>, Promise<void>>();

export type TranslationRequestCompletionReporter = (completion: Promise<unknown>) => void;

function attachExecutionCompletion<T>(promise: Promise<T>, completion: Promise<void>): Promise<T> {
    translationExecutionCompletions.set(promise, completion);
    return promise;
}

function getExecutionCompletion<T>(promise: Promise<T>): Promise<unknown> {
    return translationExecutionCompletions.get(promise) ?? promise;
}

export function trackTranslationExecution<T>(
    execute: (reportCompletion: TranslationRequestCompletionReporter) => Promise<T>
): Promise<T> {
    const completions: Promise<unknown>[] = [];
    let result: Promise<T>;

    try {
        result = execute(completion => completions.push(completion));
    } catch (error) {
        result = Promise.reject(error);
    }

    const directCompletion = getExecutionCompletion(result);
    if (directCompletion !== result) completions.push(directCompletion);

    const completion = result.then(
        () => Promise.all(completions),
        () => Promise.all(completions)
    ).then(() => undefined);
    return attachExecutionCompletion(result, completion);
}

export function runAbortableTranslationRequest<T>(
    externalSignal: AbortSignal | undefined,
    timeoutMs: number,
    request: (signal: AbortSignal) => Promise<T>,
    reportCompletion?: TranslationRequestCompletionReporter
): Promise<T> {
    const controller = new AbortController();
    let rejectCancellation: (reason: unknown) => void = () => undefined;
    const cancellation = new Promise<T>((_resolve, reject) => {
        rejectCancellation = reject;
    });
    const abortFromCaller = () => {
        rejectCancellation(new TranslationRequestCancelledError());
        controller.abort();
    };

    if (externalSignal?.aborted) {
        abortFromCaller();
    } else {
        externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    const timeout = setTimeout(() => {
        rejectCancellation(new Error("Translation request timed out."));
        controller.abort();
    }, Math.max(0, timeoutMs));

    const operation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new TranslationRequestCancelledError();
        return request(controller.signal);
    });
    const operationCompletion = operation.then(() => undefined, () => undefined);
    reportCompletion?.(operationCompletion);

    const result = Promise.race([operation, cancellation]).finally(() => {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", abortFromCaller);
    });
    return attachExecutionCompletion(result, operationCompletion);
}

export function createTranslationRequestCoordinator<T>({
    maxBackgroundQueued,
    maxConcurrent,
    maxInteractiveQueued = maxBackgroundQueued,
    maxQueueWaitMs,
}: TranslationRequestCoordinatorOptions) {
    const normalizeLimit = (value: number) => Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
    const backgroundQueueLimit = normalizeLimit(maxBackgroundQueued);
    const concurrentLimit = normalizeLimit(maxConcurrent);
    const interactiveQueueLimit = normalizeLimit(maxInteractiveQueued);
    const queueWaitLimit = maxQueueWaitMs != null && Number.isFinite(maxQueueWaitMs)
        ? Math.max(0, maxQueueWaitMs)
        : null;
    const backgroundQueue: QueuedRequest<T>[] = [];
    const interactiveQueue: QueuedRequest<T>[] = [];
    const requests = new Map<string, QueuedRequest<T>>();
    let active = 0;

    const removeQueuedRequest = (entry: QueuedRequest<T>) => {
        for (const queue of [backgroundQueue, interactiveQueue]) {
            let index = queue.indexOf(entry);
            while (index !== -1) {
                queue.splice(index, 1);
                index = queue.indexOf(entry);
            }
        }
    };

    const isRunnable = (entry: QueuedRequest<T>) => {
        return !entry.settled && !entry.started && entry.consumers.size > 0;
    };

    const countRunnable = (queue: QueuedRequest<T>[], priority: TranslationRequestPriority) => {
        let count = 0;

        for (const entry of queue) {
            if (entry.priority === priority && isRunnable(entry)) count++;
        }

        return count;
    };

    const settleSharedRequest = (entry: QueuedRequest<T>, settle: () => void) => {
        if (entry.settled) return;

        if (entry.queueTimer) {
            clearTimeout(entry.queueTimer);
            entry.queueTimer = undefined;
        }
        entry.settled = true;
        entry.consumers.clear();
        if (requests.get(entry.key) === entry) requests.delete(entry.key);
        settle();
    };

    const finishQueuedRequest = (entry: QueuedRequest<T>, error: Error) => {
        if (entry.started) return;

        removeQueuedRequest(entry);
        settleSharedRequest(entry, () => entry.reject(error));
    };

    const scheduleQueueTimeout = (entry: QueuedRequest<T>) => {
        if (queueWaitLimit == null) return;

        entry.queueTimer = setTimeout(() => {
            entry.queueTimer = undefined;
            if (entry.started || entry.settled) return;

            finishQueuedRequest(entry, new Error("Translation request timed out while waiting in the queue."));
            pump();
        }, queueWaitLimit);
    };

    const shiftRunnable = (queue: QueuedRequest<T>[]) => {
        while (queue.length) {
            const entry = queue.shift();
            if (entry && isRunnable(entry)) return entry;
        }

        return undefined;
    };

    const pump = () => {
        while (active < concurrentLimit) {
            const entry = shiftRunnable(interactiveQueue) ?? shiftRunnable(backgroundQueue);
            if (!entry) return;

            entry.started = true;
            if (entry.queueTimer) {
                clearTimeout(entry.queueTimer);
                entry.queueTimer = undefined;
            }
            active++;

            const execute = entry.execute;
            const { signal } = entry.controller;
            const startedExecution = Promise.resolve().then(() => {
                if (signal.aborted) throw new TranslationRequestCancelledError();
                const promise = execute(signal);
                return {
                    completion: getExecutionCompletion(promise),
                    promise,
                };
            });
            const execution = startedExecution.then(started => started.promise);
            const executionCompletion = startedExecution.then(started => started.completion);
            const releaseExecutionSlot = () => {
                active--;
                pump();
            };

            void execution.then(
                value => settleSharedRequest(entry, () => entry.resolve(value)),
                error => settleSharedRequest(entry, () => entry.reject(error))
            );
            void executionCompletion.then(releaseExecutionSlot, releaseExecutionSlot);
        }
    };

    const evictOldestQueuedRequestIfNeeded = (
        queue: QueuedRequest<T>[],
        priority: TranslationRequestPriority,
        limit: number
    ) => {
        while (countRunnable(queue, priority) >= limit) {
            const entry = queue.shift();
            if (!entry || entry.priority !== priority || !isRunnable(entry)) continue;

            finishQueuedRequest(
                entry,
                new TranslationRequestCancelledError(`Translation queue replaced an older ${priority} request.`)
            );
        }
    };

    const acquire = (
        key: string,
        execute: (signal: AbortSignal) => Promise<T>,
        priority: TranslationRequestPriority = "background"
    ): TranslationRequestHandle<T> => {
        let entry = requests.get(key);

        if (!entry || entry.settled) {
            let reject: (reason: unknown) => void = () => undefined;
            let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
            const promise = new Promise<T>((resolvePromise, rejectPromise) => {
                reject = rejectPromise;
                resolve = resolvePromise;
            });

            entry = {
                consumers: new Set(),
                controller: new AbortController(),
                execute,
                key,
                priority,
                promise,
                reject,
                resolve,
                settled: false,
                started: false,
            };
            requests.set(key, entry);

            if (priority === "background") {
                evictOldestQueuedRequestIfNeeded(backgroundQueue, "background", backgroundQueueLimit);
                backgroundQueue.push(entry);
            } else {
                evictOldestQueuedRequestIfNeeded(interactiveQueue, "interactive", interactiveQueueLimit);
                interactiveQueue.push(entry);
            }
            scheduleQueueTimeout(entry);
        } else if (priority === "interactive" && entry.priority === "background" && !entry.started) {
            evictOldestQueuedRequestIfNeeded(interactiveQueue, "interactive", interactiveQueueLimit);
            removeQueuedRequest(entry);
            entry.priority = "interactive";
            interactiveQueue.push(entry);
        }

        const consumer = Symbol(key);
        entry.consumers.add(consumer);
        pump();

        let released = false;
        return {
            promise: entry.promise,
            release: () => {
                if (released) return;
                released = true;

                entry.consumers.delete(consumer);
                if (entry.consumers.size || entry.settled) return;

                if (entry.started) {
                    entry.controller.abort();
                    settleSharedRequest(entry, () => entry.reject(new TranslationRequestCancelledError()));
                } else {
                    finishQueuedRequest(entry, new TranslationRequestCancelledError());
                    pump();
                }
            },
        };
    };

    const abortAll = () => {
        for (const entry of [...requests.values()]) {
            entry.consumers.clear();

            if (entry.started) {
                entry.controller.abort();
                settleSharedRequest(entry, () => entry.reject(new TranslationRequestCancelledError()));
            } else {
                finishQueuedRequest(entry, new TranslationRequestCancelledError());
            }
        }
        pump();
    };

    const getStats = (): TranslationRequestCoordinatorStats => ({
        active,
        backgroundQueued: backgroundQueue.length,
        interactiveQueued: interactiveQueue.length,
        shared: requests.size,
    });

    return { abortAll, acquire, getStats };
}

export function makeTranslationRequestKey(
    kind: "received" | "sent",
    requestSignature: string,
    text: string
): string {
    return JSON.stringify([kind, requestSignature, text]);
}

export const translationRequestCoordinator = createTranslationRequestCoordinator<TranslationValue>({
    maxBackgroundQueued: 120,
    maxConcurrent: 4,
    maxInteractiveQueued: 60,
    maxQueueWaitMs: 15000,
});
