# LLM Access (MCP)

PixelCI exposes a **read-only** API and a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server so AI assistants (Claude, etc.) can read build statuses, per-screen approval/rejection decisions, and review comments — for example to summarize what changed in a build, or to triage which screens were rejected and why.

Access is strictly read-only: an MCP client can never approve, reject, or comment.

## Authentication

Programmatic access authenticates with a **personal access token** from your VCS provider (passthrough auth). PixelCI validates the token against GitLab or GitHub and maps it to your PixelCI user, so access is scoped to exactly what the provider grants you — you only see apps whose project your account can access.

- **GitLab**: create a token at **Settings → Access Tokens** with the `read_user` scope (plus read access to the projects you want to see).
- **GitHub**: create a **fine-grained personal access token** at **Settings → Developer settings → Personal access tokens**, with access to the selected repositories and read-only permissions (Metadata read is granted automatically). A classic token also works.

## MCP Server

PixelCI serves its MCP server from the API itself at `/api/mcp`, over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) (stateless, JSON responses). There is nothing extra to install or run. Authenticate with a personal access token (see above) sent as a Bearer token.

With Claude Code:

```bash
claude mcp add --transport http pixelci https://pixelci.example.com/api/mcp \
    --header "Authorization: Bearer <token>"
```

Or the equivalent JSON (e.g. `.mcp.json`):

```json
{
    "mcpServers": {
        "pixelci": {
            "type": "http",
            "url": "https://pixelci.example.com/api/mcp",
            "headers": {
                "Authorization": "Bearer glpat-xxxxxxxxxxxxxxxxxxxx"
            }
        }
    }
}
```

- `<token>` is a GitLab or GitHub personal access token, as described under [Authentication](#authentication).
- If your instance has more than one VCS integration of the same platform, add an `X-PixelCI-Vcs-Id: <integration id>` header to choose which one the token belongs to.
- Only `POST` is supported. `GET` and `DELETE` on `/api/mcp` return `405` with `Allow: POST` (there is no server-initiated SSE stream); requests without a valid token get `401` first.
- Clients that require OAuth, such as the claude.ai and Claude Desktop connectors, are not supported yet.
- The former stdio package (`@zyno-io/pixelci-mcp`) has been removed; reconfigure existing clients as above.

### Tools

| Tool               | Description                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_apps`        | List visual-testing apps you can access                                                                                                            |
| `list_builds`      | List recent builds for an app, with status and who approved each                                                                                   |
| `get_build`        | A build with every screen's comparison status, review decision (approved/rejected), comment, and reviewer                                          |
| `get_screen_image` | A screen's image as a PNG — the highlighted pixel diff (`kind=diff`) or the screenshot (`kind=new`) — so the assistant can actually see the change |

Once connected, you can ask things like _"In PixelCI, which screens on the latest build of app X were rejected, and what were the comments?"_

## REST API

The same data is available under `/api/ext` for non-MCP automations, using the same personal-access-token auth — send `Authorization: Bearer <token>` (and `X-PixelCI-Vcs-Id: <id>` when multiple providers are configured):

| Endpoint                                                           | Description                                  |
| ------------------------------------------------------------------ | -------------------------------------------- |
| `GET /api/ext/apps`                                                | Accessible apps                              |
| `GET /api/ext/apps/:appId/builds`                                  | Recent builds (optional `branchId`, `limit`) |
| `GET /api/ext/apps/:appId/builds/:buildId`                         | Build detail with per-screen reviews         |
| `GET /api/ext/apps/:appId/builds/:buildId/screens/:screenId/image` | Screen image (`?kind=diff` or `new`)         |

Reads are gated per app by VCS project access; a token can only see projects it can access in GitLab or GitHub (unless the operator has disabled [`ENFORCE_VCS_PROJECT_ACCESS`](/deployment#access-control)).
