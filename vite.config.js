import { defineConfig } from 'vite';

export default defineConfig(() => {
    const runtimeMode =
        process.env.VITE_RUNTIME_MODE || 'standalone';

    const isMichigan =
        runtimeMode === 'michigan';

    return {
        // Standalone public build lives on GitHub Pages.
        // Michigan build is served locally from the root.
        base: isMichigan
            ? '/'
            : '/scarlettshi.github.io/',

        server: isMichigan
            ? {
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
              }
            : undefined,
    };
});

