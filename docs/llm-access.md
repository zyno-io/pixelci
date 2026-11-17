# LLM Access (MCP)

PixelCI exposes a **read-only** API and a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server so AI assistants (Claude, etc.) can read build statuses, per-screen approval/rejection decisions, and review comments — for example to summarize what changed in a build, or to triage which screens were rejected and why.

Access is strictly read-only: an MCP client can never approve, reject, or comment.

## Authentication

There are two ways to authenticate. Either way, PixelCI maps you to your PixelCI user, so access is scoped to exactly what your VCS provider grants you: you only see apps whose project your account can access.

- **OAuth (recommended).** MCP clients such as claude.ai, Claude Desktop and Claude Code sign in through your browser: you approve the connection on a PixelCI screen, signed in as yourself, and no token is copied anywhere. PixelCI is its own OAuth authorization server (OAuth 2.1 with PKCE and dynamic client registration), so nothing needs configuring on the GitLab or GitHub side. Access is read-only and ends when you revoke it or your VCS sign-in expires.
- **Personal access token.** For scripts and clients without OAuth support, send a GitLab or GitHub personal access token as a Bearer token. PixelCI validates it against the provider.
    - **GitLab**: create a token at **Settings → Access Tokens** with the `read_user` scope (plus read access to the projects you want to see).
    - **GitHub**: create a **fine-grained personal access token** at **Settings → Developer settings → Personal access tokens**, with access to the selected repositories and read-only permissions (Metadata read is granted automatically). A classic token also works.

OAuth requires the instance's [`PUBLIC_URL`](/deployment#environment-variable-reference) to be an `https` address, and for claude.ai the instance must be reachable from the public internet (claude.ai connects from Anthropic's servers, not your browser).

## MCP Server

PixelCI serves its MCP server from the API itself at `/api/mcp`, over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) (stateless, JSON responses). There is nothing extra to install or run.

### Connect with OAuth

- **claude.ai and Claude Desktop**: **Settings → Connectors → Add custom connector**, and enter `https://pixelci.example.com/api/mcp`. Approve the request that opens in your browser.
- **Claude Code**:

    ```bash
    claude mcp add --transport http pixelci https://pixelci.example.com/api/mcp
    ```

    then run `/mcp`, choose **pixelci** and **Authenticate**. Approve the request that opens in your browser.

The approval screen shows which app is asking and where you'll be sent back to. Apps register themselves, so PixelCI marks apps that registered themselves **Unverified**: only approve a connection you just started. Apps that publish a metadata URL are identified by that domain instead ("Verified domain" means PixelCI loaded the app's details over HTTPS from that host, nothing more); the app still chooses its own name, and one that returns to your own computer is always shown as unverified. Manage what you've approved, and revoke it at any time, under **Connected apps** in the PixelCI top bar. A connection also stops working when your GitLab or GitHub sign-in expires; the client then asks you to approve it again.

### Connect with a personal access token

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
- If your instance has more than one VCS integration of the same platform, add an `X-PixelCI-Vcs-Id: <integration id>` header to choose which one the token belongs to. (Not needed with OAuth: the provider is the one you signed in with.)
- Only `POST` is supported. `GET` and `DELETE` on `/api/mcp` return `405` with `Allow: POST` (there is no server-initiated SSE stream); requests without valid credentials get `401` first, with a `WWW-Authenticate` header that points OAuth clients at the sign-in metadata.
- The former stdio package (`@zyno-io/pixelci-mcp`) has been removed; reconfigure existing clients as above.

### Tools

| Tool               | Description                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_apps`        | List visual-testing apps you can access                                                                                                            |
| `list_builds`      | List recent builds for an app, with status and who approved each                                                                                   |
| `get_build`        | A build with every screen's comparison status, review decision (approved/rejected), comment, and reviewer                                          |
| `get_screen_image` | A screen's image as a PNG — the highlighted pixel diff (`kind=diff`) or the screenshot (`kind=new`) — so the assistant can actually see the change |

Each screen in `get_build` (and in the REST build detail below) has an `appliedMasks` field: the regions that were ignored when it was compared, as `{ x, y, width, height, label }` in screenshot pixels from the top-left, or `null` for a build processed before [masks](/usage#masks) existed. A screen reported as unchanged can still differ inside them, so check `appliedMasks` before telling someone nothing changed. The diff image (`kind=diff`) shows masked pixels in a grey hatch. Masks are read-only here: they can only be changed in the PixelCI UI.

Once connected, you can ask things like _"In PixelCI, which screens on the latest build of app X were rejected, and what were the comments?"_

## REST API

The same data is available under `/api/ext` for non-MCP automations, using personal-access-token auth only (OAuth tokens are issued for `/api/mcp` and are not accepted here) — send `Authorization: Bearer <token>` (and `X-PixelCI-Vcs-Id: <id>` when multiple providers are configured):

| Endpoint                                                           | Description                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| `GET /api/ext/apps`                                                | Accessible apps                                         |
| `GET /api/ext/apps/:appId/builds`                                  | Recent builds (optional `branchId`, `limit`)            |
| `GET /api/ext/apps/:appId/builds/:buildId`                         | Build detail with per-screen reviews and `appliedMasks` |
| `GET /api/ext/apps/:appId/builds/:buildId/screens/:screenId/image` | Screen image (`?kind=diff` or `new`)                    |

Reads are gated per app by VCS project access; a token can only see projects it can access in GitLab or GitHub (unless the operator has disabled [`ENFORCE_VCS_PROJECT_ACCESS`](/deployment#access-control)).
