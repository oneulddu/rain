// React exports may be plain functions, memo wrappers, or forwardRef wrappers.
export function getRenderTarget(module: any): { target: any; key: string } | undefined {
    let target = module;
    let key = "default";
    const seen = new Set<any>();
    while (target && !seen.has(target)) {
        seen.add(target);
        const component = target[key];
        if (typeof component?.render === "function") return { target: component, key: "render" };
        if (component?.type) {
            target = component;
            key = "type";
        } else {
            return typeof component === "function" ? { target, key } : undefined;
        }
    }
}
