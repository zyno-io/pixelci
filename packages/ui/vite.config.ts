import vue from '@vitejs/plugin-vue';
import { openapiClientGeneratorPlugin } from '@zyno-io/vue-foundation/vite-plugins';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import oxlintPlugin from 'vite-plugin-oxlint';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
process.env.VITE_APP_VERSION = version;

// https://vitejs.dev/config/
const FRAME_HEADERS = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };

export default defineConfig({
    css: {
        preprocessorOptions: {
            scss: {
                api: 'modern-compiler'
            }
        }
    },
    server: {
        port: 7925,
        // Same frame protection the API sends on the built SPA (packages/api/src/app.ts STATIC_FILE_HEADERS).
        headers: FRAME_HEADERS,
        // The session is a cookie, so the UI and the API must share an origin: the dev UI proxies the whole API. The OAuth issuer is
        // PUBLIC_URL (the dev UI origin) too, so MCP clients can be pointed at http://localhost:7925/api/mcp end to end.
        proxy: {
            '/.well-known': 'http://localhost:7924',
            '/api': 'http://localhost:7924'
        }
    },
    preview: {
        headers: FRAME_HEADERS
    },
    build: {
        sourcemap: true,

        target: 'esnext',
        outDir: '../api/static'
    },
    plugins: [vue(), oxlintPlugin(), openapiClientGeneratorPlugin()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url))
        }
    }
});
