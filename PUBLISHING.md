# CloudForge MCP — Publishing & Submission Guide

## Step 1 — Publish to npm (do this first)

```bash
cd C:\Others\IAC\mcp_servers\cloudforge-mcp
npm login
npm publish
```

Once published, the package is live at `https://www.npmjs.com/package/cloudforge-mcp`
and users can run it with `npx cloudforge-mcp` — no manual install needed.

---

## Step 2 — Submit to Marketplaces

### mcp.so

- **URL:** https://mcp.so/submit
- **Type:** MCP Server
- **Name:** `CloudForge — Terraform Visual Diagram & IaC Generator`
- **URL:** `https://github.com/cloudforgetech6-ctrl/mcp_server`
- **Server Config:**
```json
{
  "mcpServers": {
    "cloudforge": {
      "command": "npx",
      "args": ["-y", "cloudforge-mcp"],
      "env": {
        "CLOUDFORGE_TOKEN": "<your-cf_live_-api-key>"
      }
    }
  }
}
```

---

### Smithery

- **URL:** https://smithery.ai
- Submit via their registry form
- Provide the GitHub URL: `https://github.com/cloudforgetech6-ctrl/mcp_server`
- Smithery auto-scans tools and descriptions from the README

---

### Glama

- **URL:** https://glama.ai/mcp/servers
- Submit the GitHub URL or npm package name: `cloudforge-mcp`

---

### Anthropic MCP Hub (most important)

The official directory — Claude users check this first.

1. Fork `https://github.com/modelcontextprotocol/servers`
2. Add an entry to the `README.md` under the relevant category (e.g. **Cloud Infrastructure / DevOps**)
3. Entry format:
```
- [CloudForge](https://github.com/cloudforgetech6-ctrl/mcp_server) — Visualise cloud diagrams, generate Terraform HCL, import IaC, and manage Azure/AWS/GCP infrastructure from Claude.
```
4. Open a PR

---

## How users get their API key

1. Sign in at **cloudforge.cloud**
2. Go to **Account → API Keys**
3. Click **Generate API Key**, name it (e.g. `Claude MCP`)
4. Copy the `cf_live_...` key — shown once only
5. Paste as `CLOUDFORGE_TOKEN` in the MCP config

---

## Order of operations

```
npm publish  →  mcp.so  →  Smithery  →  Glama  →  Anthropic MCP Hub PR
```

npm must be done first. All other platforms verify the npx command works.
