/* eslint-disable @typescript-eslint/no-require-imports */
import type { IncomingMessage } from 'http';

// otel must be initialized before all else

const otel = require('@zyno-io/ts-server-foundation/otel');
otel.init({
    // Query strings can carry authorization codes and OAuth state; redact them from exported spans.
    redactQueryKeys: [...otel.DEFAULT_REDACTED_QUERY_KEYS, 'request'],
    httpIncomingRequestAttributeHook(request: IncomingMessage) {
        return {
            'openreplay.sid': request.headers['x-openreplay-sessionid'] ?? 'unk'
        };
    }
});

const { createPixelCIApp } = require('./app');
const app = createPixelCIApp();
app.run();
