import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { http, HttpError, HttpRequest, Logger, openapi, rawResponse, webResponse } from '@zyno-io/ts-server-foundation';

import { VcsTokenAuthMiddleware, vcsPrincipal } from '../accessories/AuthMiddleware.accessory';
import { IAppAccessPrincipal } from '../services/AppAccess.service';
import { ExternalReadService } from '../services/ExternalRead.service';
import { S3Service } from '../services/S3.service';

const SERVER_VERSION = '1.0.0';

// Claude and most MCP clients reject images over 5 MB; larger ones are reachable via the REST image route.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Backstop so a request whose handler never responds (e.g. a canceled call) can't hold the socket forever.
const REQUEST_DEADLINE_MS = 60_000;

const TOOLS: Tool[] = [
    {
        name: 'list_apps',
        description: 'List PixelCI visual-testing apps. Returns each app id and name; use the id with list_builds.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'list_builds',
        description:
            'List recent builds for an app, newest first, with each build’s status and who approved it (if approved). Optionally filter by branchId. Use get_build for per-screen review decisions and comments.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: { type: 'string', description: 'App id (from list_apps)' },
                branchId: { type: 'string', description: 'Optional branch id to filter by' },
                limit: { type: 'number', description: 'Max builds to return (default 50, max 200)' }
            },
            required: ['appId'],
            additionalProperties: false
        }
    },
    {
        name: 'get_build',
        description:
            'Get a build and every screen in it: comparison status (removed=true marks a screen deleted from this build; it has no image), the per-screen review decision (approved/rejected/none), the review comment, and who reviewed it, plus build-level approval.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: { type: 'string', description: 'App id' },
                buildId: { type: 'string', description: 'Build id (from list_builds)' }
            },
            required: ['appId', 'buildId'],
            additionalProperties: false
        }
    },
    {
        name: 'get_screen_image',
        description:
            "Get a screen's image as a PNG so you can actually see the visual change. kind='diff' (default) returns the highlighted pixel diff for a changed screen; kind='new' returns the build's screenshot of that screen. Get appId/buildId/screenId from get_build.",
        inputSchema: {
            type: 'object',
            properties: {
                appId: { type: 'string', description: 'App id' },
                buildId: { type: 'string', description: 'Build id' },
                screenId: { type: 'string', description: 'Screen id (from get_build screens[].screenId)' },
                kind: { type: 'string', enum: ['diff', 'new'], description: "Which image: 'diff' (default) or 'new'" }
            },
            required: ['appId', 'buildId', 'screenId'],
            additionalProperties: false
        }
    }
];

function textResult(value: unknown): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
    return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * MCP server (Streamable HTTP, stateless, JSON responses) exposing the same read-only data as
 * /api/ext. Authenticated with a VCS personal access token via VcsTokenAuthMiddleware, so
 * unauthenticated requests of any method get 401 before any 405.
 *
 * Stateless: a fresh Server + transport is created per POST. There is no SSE stream, so GET and
 * DELETE answer 405 with `Allow: POST` (permitted by the spec).
 */
@http.controller('/api/mcp')
@http.middleware(VcsTokenAuthMiddleware)
@openapi.ignore()
export class McpController {
    constructor(
        private extReadSvc: ExternalReadService,
        private s3Svc: S3Service,
        private logger: Logger
    ) {}

    @http.POST()
    async handlePost(request: HttpRequest) {
        const principal = vcsPrincipal(request);
        request.setDeadline(REQUEST_DEADLINE_MS);

        // JSON-RPC batches are rejected: the 2025-06-18 spec dropped them, and a batch would run many
        // tool calls (image reads included) concurrently in one request. An unparseable body is left
        // for the SDK, which answers with a JSON-RPC parse error.
        let parsedBody: unknown;
        try {
            parsedBody = JSON.parse(await request.readBodyText());
        } catch {
            parsedBody = undefined;
        }
        if (Array.isArray(parsedBody)) {
            return jsonRpcError(400, -32600, 'Batch requests are not supported.');
        }

        const server = this.createServer(principal);
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        try {
            const aborted = new Promise<never>((_, reject) => {
                if (request.signal.aborted) reject(request.signal.reason);
                request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
            });
            // An abort after the race settles (e.g. a disconnect while writing) must not surface as unhandled.
            aborted.catch(() => undefined);
            // In JSON-response mode the Response is fully materialized before handleRequest resolves,
            // so closing afterwards cannot truncate it.
            const response = await Promise.race([transport.handleRequest(await request.toWebRequest(), { parsedBody }), aborted]);
            return webResponse(response);
        } finally {
            await server.close().catch(() => undefined);
        }
    }

    @http.GET()
    handleGet() {
        return this.methodNotAllowed();
    }

    @http.DELETE()
    handleDelete() {
        return this.methodNotAllowed();
    }

    private methodNotAllowed() {
        return jsonRpcError(405, -32000, 'Method not allowed.', { Allow: 'POST' });
    }

    private createServer(principal: IAppAccessPrincipal): Server {
        const server = new Server({ name: 'pixelci', version: SERVER_VERSION }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
        server.setRequestHandler(CallToolRequestSchema, async request => {
            const args = (request.params.arguments ?? {}) as Record<string, unknown>;
            try {
                return await this.callTool(principal, request.params.name, args);
            } catch (err) {
                if (err instanceof HttpError) return errorResult(err.message);
                this.logger.error(`MCP tool ${request.params.name} failed`, err);
                return errorResult('Internal error');
            }
        });
        return server;
    }

    private async callTool(principal: IAppAccessPrincipal, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
        switch (name) {
            case 'list_apps':
                return textResult(await this.extReadSvc.listApps(principal));

            case 'list_builds': {
                const limit = args.limit === undefined || args.limit === null ? undefined : Number(args.limit);
                if (limit !== undefined && !Number.isFinite(limit)) throw new HttpError(400, 'limit must be a number');
                return textResult(
                    await this.extReadSvc.listBuilds(principal, requireId(args, 'appId'), {
                        branchId: args.branchId ? requireId(args, 'branchId') : undefined,
                        limit
                    })
                );
            }

            case 'get_build':
                return textResult(await this.extReadSvc.getBuild(principal, requireId(args, 'appId'), requireId(args, 'buildId')));

            case 'get_screen_image': {
                const kind = args.kind === 'new' ? 'new' : 'diff';
                const path = await this.extReadSvc.getScreenImagePath(
                    principal,
                    requireId(args, 'appId'),
                    requireId(args, 'buildId'),
                    requireId(args, 'screenId'),
                    kind
                );
                let bytes: Buffer | undefined;
                try {
                    bytes = await this.s3Svc.getBufferWithLimit(path, MAX_IMAGE_BYTES);
                } catch (err) {
                    if ((err as { name?: string })?.name !== 'NoSuchKey') throw err;
                    return errorResult(
                        kind === 'diff'
                            ? 'This screen has no diff image (diffs exist only for changed screens). Use kind="new" for its screenshot.'
                            : 'This screen has no stored screenshot.'
                    );
                }
                if (!bytes) {
                    return errorResult(
                        `This image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB, too large to return over MCP. ` +
                            `View it in the PixelCI UI or via GET /api/ext/apps/{appId}/builds/{buildId}/screens/{screenId}/image?kind=${kind}.`
                    );
                }
                return { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }] };
            }

            default:
                return errorResult(`Unknown tool: ${name}`);
        }
    }
}

function jsonRpcError(statusCode: number, code: number, message: string, headers: Record<string, string> = {}) {
    return rawResponse(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
        statusCode,
        contentType: 'application/json',
        headers
    });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || !UUID_RE.test(value)) throw new HttpError(400, `${key} must be a valid id`);
    return value;
}
