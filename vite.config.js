import { defineConfig } from 'vite';

export default defineConfig(() => {
    const runtimeMode =
        process.env.VITE_RUNTIME_MODE || 'standalone';

    const isMichigan =
        runtimeMode === 'michigan';

    return {
        // ------------------------------------------------------------
        // BASE
        // ------------------------------------------------------------
        //
        // Standalone public build lives on GitHub Pages under a subpath.
        // Michigan build is served locally from the root.
        //
        // This one genuinely has to stay a build-time decision: base is
        // baked into every asset URL, so it cannot be switched at runtime
        // the way the audio mode can.
        // ------------------------------------------------------------

        base: isMichigan
            ? '/'
            : '/A-Thousand-Clocks-WebXR/',

        // ------------------------------------------------------------
        // DEV SERVER
        // ------------------------------------------------------------
        //
        // Both builds allow Cloudflare Quick Tunnel hosts for Quest testing.
        //
        // The /inviso-ws proxy is ALWAYS on, not gated on isMichigan.
        // Runtime mode is chosen by the participant on the loading screen,
        // so at build time there is no way to know whether it will be
        // needed. Gating it meant a standalone dev server could never reach
        // the bridge even when Michigan was selected in the browser —
        // InvisoClient would resolve ws://localhost:5173/inviso-ws, which
        // Vite has no route for, and the connection would silently never
        // open.
        //
        // Leaving it on costs nothing: with no bridge running, the proxy
        // simply fails to forward, which is the same outcome as having no
        // proxy at all.
        // ------------------------------------------------------------

        server: {
            host: '0.0.0.0',

            allowedHosts: [
                '.trycloudflare.com',
            ],

            proxy: {
                '/inviso-ws': {
                    target: 'ws://127.0.0.1:8082',
                    ws: true,
                },
            },
        },
    };
});