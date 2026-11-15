import vue from '@vitejs/plugin-vue';
import { openapiClientGeneratorPlugin } from '@zyno-io/vue-foundation/vite-plugins';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import oxlintPlugin from 'vite-plugin-oxlint';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
process.env.VITE_APP_VERSION = version;

// https://vitejs.dev/config/
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
        // The OAuth issuer is PUBLIC_URL (the dev UI origin); its discovery, protocol and MCP endpoints live on the API, so MCP clients
        // can be pointed at the dev UI (http://localhost:7925/api/mcp) end to end.
        proxy: {
            '/.well-known': 'http://localhost:7924',
            '/api/mcp': 'http://localhost:7924',
            '/api/oauth': 'http://localhost:7924'
        }
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
