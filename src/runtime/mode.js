export const RUNTIME_MODE =
    import.meta.env.VITE_RUNTIME_MODE || 'standalone';

export const IS_MICHIGAN =
    RUNTIME_MODE === 'michigan';

