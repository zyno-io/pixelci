#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

const API_URL = process.env.PIXELCI_API_URL?.replace(/\/+$/, '');
const TOKEN = process.env.PIXELCI_VCS_TOKEN ?? process.env.PIXELCI_GITHUB_TOKEN ?? process.env.PIXELCI_GITLAB_TOKEN;
const VCS_ID = process.env.PIXELCI_VCS_ID;

function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` };
    // Required only when the PixelCI instance has more than one VCS provider configured.
    if (VCS_ID) headers['X-PixelCI-Vcs-Id'] = VCS_ID;
    return headers;
}

if (!API_URL || !TOKEN) {
    console.error(
        'PixelCI MCP: PIXELCI_API_URL and PIXELCI_VCS_TOKEN (or PIXELCI_GITHUB_TOKEN / PIXELCI_GITLAB_TOKEN) environment variables are required.'
    );
    process.exit(1);
}

async function api(path: string): Promise<unknown> {
    const response = await fetch(`${API_URL}${path}`, {
        headers: authHeaders()
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`PixelCI API ${path} failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
    }

    return response.json();
}

async function apiBinary(path: string): Promise<{ base64: string; mimeType: string }> {
    // Don't auto-follow the redirect: the image endpoint 302s to a signed storage URL, and the VCS
    // token must NOT ride along to object storage. We fetch the Location separately, without auth.
    const response = await fetch(`${API_URL}${path}`, {
        headers: authHeaders(),
        redirect: 'manual'
    });

    let imageResponse = response;
    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`PixelCI API ${path}: redirect with no Location header`);
        imageResponse = await fetch(location);
    }

    if (!imageResponse.ok) {
        const body = await imageResponse.text().catch(() => '');
        throw new Error(`PixelCI image ${path} failed: ${imageResponse.status} ${imageResponse.statusText}${body ? ` — ${body}` : ''}`);
    }

    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    const mimeType = imageResponse.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
    return { base64: bytes.toString('base64'), mimeType };
}

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
            'Get a build and every screen in it: comparison status, the per-screen review decision (approved/rejected/none), the review comment, and who reviewed it, plus build-level approval.',
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

const server = new Server({ name: 'pixelci', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
        let result: unknown;

        switch (name) {
            case 'list_apps':
                result = await api('/api/ext/apps');
                break;

            case 'list_builds': {
                const appId = String(args.appId ?? '');
                const params = new URLSearchParams();
                if (args.branchId) params.set('branchId', String(args.branchId));
                if (args.limit) params.set('limit', String(args.limit));
                const qs = params.toString();
                result = await api(`/api/ext/apps/${encodeURIComponent(appId)}/builds${qs ? `?${qs}` : ''}`);
                break;
            }

            case 'get_build': {
                const appId = String(args.appId ?? '');
                const buildId = String(args.buildId ?? '');
                result = await api(`/api/ext/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(buildId)}`);
                break;
            }

            case 'get_screen_image': {
                const appId = String(args.appId ?? '');
                const buildId = String(args.buildId ?? '');
                const screenId = String(args.screenId ?? '');
                const kind = args.kind === 'new' ? 'new' : 'diff';
                const { base64, mimeType } = await apiBinary(
                    `/api/ext/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(buildId)}/screens/${encodeURIComponent(screenId)}/image?kind=${kind}`
                );
                return { content: [{ type: 'image', data: base64, mimeType }] };
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
        return {
            isError: true,
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }]
        };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('PixelCI MCP server running on stdio');
