# CloudForge MCP Server

[![npm version](https://img.shields.io/npm/v/cloudforge-mcp)](https://www.npmjs.com/package/cloudforge-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP server for [CloudForge](https://cloudforge.cloud) — lets Claude and other AI assistants visualise cloud architecture diagrams, generate Terraform HCL, import existing IaC, and manage your infrastructure resources directly from chat.

## Tools

### Visualisation

| Tool | Description |
|------|-------------|
| `cloudforge_diagram_to_mermaid` | Fetch a saved diagram and render it as an inline Mermaid flowchart |
| `cloudforge_architecture_summary` | Structured summary: resource counts by category, central components, inline diagram |
| `cloudforge_mermaid_from_json` | Convert raw diagram JSON to Mermaid without fetching from the server |

### Terraform

| Tool | Description |
|------|-------------|
| `cloudforge_generate_terraform` | Generate Terraform HCL from a natural-language architecture description |
| `cloudforge_export_terraform_from_diagram` | Export Terraform HCL from an existing saved diagram in one step |
| `cloudforge_import_terraform` | Parse existing HCL → diagram structure + Mermaid preview |

### AI Architect

| Tool | Description |
|------|-------------|
| `cloudforge_chat` | Ask the CloudForge AI Architect for IaC advice, cost estimates, security reviews |
| `cloudforge_suggest_resources` | Get AI-recommended resources and connections for a described use case |

### Diagram Management

| Tool | Description |
|------|-------------|
| `cloudforge_list_diagrams` | List saved diagrams with metadata |
| `cloudforge_recent_diagrams` | Get recently accessed/modified diagrams |
| `cloudforge_get_diagram` | Fetch a diagram by ID (full JSON) |
| `cloudforge_save_diagram` | Save or update a diagram |
| `cloudforge_delete_diagram` | Permanently delete a diagram |

### Organisation

| Tool | Description |
|------|-------------|
| `cloudforge_list_members` | List organisation members (name, email, role, status) |
| `cloudforge_invite_member` | Send an organisation invitation |
| `cloudforge_list_invitations` | List pending invitations |
| `cloudforge_cancel_invitation` | Cancel a pending invitation |
| `cloudforge_remove_member` | Remove a member from the organisation |

## Setup

### Claude Desktop (recommended)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cloudforge": {
      "command": "npx",
      "args": ["-y", "cloudforge-mcp"],
      "env": {
        "CLOUDFORGE_TOKEN": "your-bearer-token"
      }
    }
  }
}
```

### Claude Code / `.mcp.json`

```json
{
  "mcpServers": {
    "cloudforge": {
      "command": "npx",
      "args": ["-y", "cloudforge-mcp"],
      "env": {
        "CLOUDFORGE_TOKEN": "your-bearer-token"
      }
    }
  }
}
```

## Authentication

Get your bearer token from [cloudforge.cloud](https://cloudforge.cloud):

1. Sign in to CloudForge
2. Open browser DevTools → **Application** → **Local Storage** → copy the value of `auth_token`
3. Paste it as `CLOUDFORGE_TOKEN` in your MCP config

The token is long-lived — you only need to do this once.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUDFORGE_TOKEN` | _(required)_ | Bearer token from your CloudForge account |
| `CLOUDFORGE_API_URL` | `https://cloudforge.cloud/api` | API base URL — only change if self-hosting |

## Example prompts

```
Show me my recent diagrams
```
```
Render diagram <id> as a Mermaid chart
```
```
Generate Terraform for a 3-tier Azure web app with a private SQL database in UK South
```
```
Import this Terraform and show me a diagram: <paste HCL>
```
```
What are the security best practices for the resources in diagram <id>?
```
```
Invite john@example.com as a Member to my organisation
```

## Self-hosting

If you run CloudForge on-premises, point the server at your own API:

```json
"env": {
  "CLOUDFORGE_API_URL": "https://your-cloudforge-host/api",
  "CLOUDFORGE_TOKEN": "your-token"
}
```

## License

MIT © [CloudForge](https://cloudforge.cloud)
