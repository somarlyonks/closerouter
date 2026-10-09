// Small readers shared by config resolution and model mapping. Each tolerates
// unknown input so closerouter and provider payloads can evolve freely.

export function asRecord (value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

export function parseJson (text: string | undefined): unknown {
    if (text === undefined) return undefined
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

export function stringField (record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record?.[key]
        if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
}

export function numberField (record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
    for (const key of keys) {
        const value = record?.[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
    }
    return undefined
}

export function integerField (record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
    const value = numberField(record, ...keys)
    return value === undefined ? undefined : Math.floor(value)
}

export function booleanField (record: Record<string, unknown> | undefined, ...keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = record?.[key]
        if (typeof value === 'boolean') return value
    }
    return undefined
}
