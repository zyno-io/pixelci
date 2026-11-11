# @zyno-io/pixelci-mcp

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that exposes PixelCI
build statuses, per-screen approval/rejection decisions, and review comments to LLM clients
(Claude Desktop, Claude Code, etc.).

It authenticates to the PixelCI API with a **GitLab or GitHub personal access token** (passthrough auth): the
API validates the token against the provider and maps it to your PixelCI user. For GitLab the token
needs only the `read_user` scope; for GitHub use a fine-grained PAT limited to the selected
repositories with read-only permissions (Metadata read is implicit), or a classic PAT. Access is strictly read-only — the server cannot approve, reject,
or comment.

## Tools

- `list_apps` — list visual-testing apps (id + name)
- `list_builds` — list recent builds for an app (status, approver); optional `branchId`, `limit`
- `get_build` — a build plus every screen's comparison status, review decision (approved/rejected),
  review comment, reviewer, and build-level approval

## Configuration

Set these environment variables:

| Variable            | Description                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PIXELCI_API_URL`   | Base URL of your PixelCI API, e.g. `https://pixelci.example.com`                                                                                                                             |
| `PIXELCI_VCS_TOKEN` | A GitLab (`read_user`) or GitHub (fine-grained, read-only) personal access token. `PIXELCI_GITHUB_TOKEN` / `PIXELCI_GITLAB_TOKEN` are accepted aliases.                                      |
| `PIXELCI_VCS_ID`    | Optional. The VCS integration id to authenticate against (sent as the `X-PixelCI-Vcs-Id` header). Required only if your PixelCI instance has more than one integration of the same platform. |

## Build

```bash
yarn install
yarn workspace @zyno-io/pixelci-mcp build
```

## Use with Claude Desktop / Claude Code

Add to your MCP config (e.g. `claude_desktop_config.json`, or via `claude mcp add`):

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

Then ask your assistant things like _"In PixelCI, which screens on the latest build of app X were
rejected and what were the comments?"_

## License

The PixelCI MCP server is licensed under the [MIT License](LICENSE). The PixelCI server and web UI are source-available
under the [PixelCI Source Available License](https://github.com/zyno-io/pixelci/blob/main/LICENSE.md).
