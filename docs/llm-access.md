# LLM Access (MCP)

PixelCI exposes a **read-only** API and a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server so AI assistants (Claude, etc.) can read build statuses, per-screen approval/rejection decisions, and review comments — for example to summarize what changed in a build, or to triage which screens were rejected and why.

Access is strictly read-only: an MCP client can never approve, reject, or comment.

## Authentication

Programmatic access authenticates with a **personal access token** from your VCS provider (passthrough auth). PixelCI validates the token against GitLab or GitHub and maps it to your PixelCI user, so access is scoped to exactly what the provider grants you — you only see apps whose project your account can access.

- **GitLab**: create a token at **Settings → Access Tokens** with the `read_user` scope (plus read access to the projects you want to see).
- **GitHub**: create a **fine-grained personal access token** at **Settings → Developer settings → Personal access tokens**, with access to the selected repositories and read-only permissions (Metadata read is granted automatically). A classic token also works.

## MCP Server

The MCP server lives in `packages/mcp` and communicates over stdio. Build it:

```bash
yarn workspace @zyno-io/pixelci-mcp build
```

Then point your MCP client at it (e.g. Claude Desktop's `claude_desktop_config.json`, or `claude mcp add`):

```json
{
    "mcpServers": {
        "pixelci": {
            "command": "node",
            "args": ["/absolute/path/to/pixelci/packages/mcp/dist/index.js"],
            "env": {
                "PIXELCI_API_URL": "https://pixelci.example.com",
                "PIXELCI_VCS_TOKEN": "glpat-xxxxxxxxxxxxxxxxxxxx"
            }
        }
    }
}
```

| Variable            | Required | Description                                                                                                                                                                |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PIXELCI_API_URL`   | Yes      | Base URL of your PixelCI instance                                                                                                                                          |
| `PIXELCI_VCS_TOKEN` | Yes      | A GitLab or GitHub personal access token. `PIXELCI_GITHUB_TOKEN` and `PIXELCI_GITLAB_TOKEN` are accepted aliases                                                           |
| `PIXELCI_VCS_ID`    | No       | The VCS integration id to authenticate against (sent as the `X-PixelCI-Vcs-Id` header). Required only if your instance has more than one integration of the same platform. |

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
