export const COMPAT_LIMITS = Object.freeze({ bytes: 256 * 1024, collectionItems: 256, objectProperties: 256, nodes: 4096, depth: 24 });
export function compatibilityArgumentViolation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'compatibility arguments must be a JSON object';
    const stack = [{ value, depth: 0 }];
    let nodes = 0, bytes = 2;
    while (stack.length) {
        const current = stack.pop();
        if (++nodes > COMPAT_LIMITS.nodes) return 'compatibility arguments exceed the structural item limit';
        if (current.depth > COMPAT_LIMITS.depth) return 'compatibility arguments exceed the nesting limit';
        const item = current.value;
        if (typeof item === 'string') bytes += Buffer.byteLength(item, 'utf8') + 2;
        else if (Array.isArray(item)) {
            if (item.length > COMPAT_LIMITS.collectionItems) return 'compatibility argument collection exceeds 256 items';
            for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
        } else if (item && typeof item === 'object') {
            const entries = Object.entries(item);
            if (entries.length > COMPAT_LIMITS.objectProperties) return 'compatibility argument object exceeds 256 properties';
            for (const [key, child] of entries) { bytes += Buffer.byteLength(key, 'utf8') + 3; stack.push({ value: child, depth: current.depth + 1 }); }
        }
        if (bytes > COMPAT_LIMITS.bytes) return 'compatibility arguments exceed 256 KiB';
    }
    return null;
}
