# CloudForge MCP — Publishing & Submission Guide

## Status

| Platform | Status | URL |
|----------|--------|-----|
| **npm** | ✅ Published | https://www.npmjs.com/package/cloudforge-mcp |
| **Anthropic MCP Registry** | ✅ Published | https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.cloudforgetech6-ctrl/cloudforge |
| **mcp.so** | ✅ Submitted | https://mcp.so/server/cloudforge----terraform-visual-diagram-&-iac-generator |
| **Smithery** | ⏳ Pending | https://smithery.ai |
| **Glama** | ⏳ Pending | https://glama.ai/mcp/servers |
| **Awesome MCP Servers** | ⏳ Pending | https://github.com/punkpeye/awesome-mcp-servers |

---

## npm

**Package:** `cloudforge-mcp`
**Published by:** `cloudforgeadmin`

To publish a new version:
```bash
cd C:\Others\IAC\mcp_servers\cloudforge-mcp
# bump version in package.json and server.json
npm publish --otp=YOUR_OTP_CODE
```

---

## Anthropic MCP Registry (Official)

**Server name:** `io.github.cloudforgetech6-ctrl/cloudforge`
**Registry URL:** https://registry.modelcontextprotocol.io
**Search:** https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.cloudforgetech6-ctrl/cloudforge

To publish a new version:
```bash
cd C:\Others\IAC\mcp_servers\cloudforge-mcp
.\mcp-publisher.exe login github   # only needed if token expired
.\mcp-publisher.exe publish
```

The `server.json` file controls what is submitted. Key fields:
- `name` — must match `mcpName` in `package.json` (`io.github.cloudforgetech6-ctrl/cloudforge`)
- `version` — must match the npm published version
- `description` — max 100 characters

---

## mcp.so

**Submitted as:** `cloudforge----terraform-visual-diagram-&-iac-generator`
**Account:** cloudforgetech6@gmail.com
**GitHub URL:** https://github.com/cloudforgetech6-ctrl/mcp_server

Server config used:
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

## Smithery

- URL: https://smithery.ai
- Submit: GitHub URL `https://github.com/cloudforgetech6-ctrl/mcp_server`
- Smithery auto-scans tools from README

---

## Glama

- URL: https://glama.ai/mcp/servers
- Submit: GitHub URL or npm package name `cloudforge-mcp`

---

## Awesome MCP Servers (punkpeye)

- Fork `https://github.com/punkpeye/awesome-mcp-servers` with `cloudforgetech6-ctrl` account
- Add under **Cloud Platforms** or **DevOps** section:

```markdown
- [CloudForge](https://github.com/cloudforgetech6-ctrl/mcp_server) - Visualise cloud architecture diagrams, generate Terraform HCL, import IaC, and manage Azure/AWS/GCP infrastructure. ([npm](https://www.npmjs.com/package/cloudforge-mcp))
```

- Open a PR

---

## How users get their API key

1. Sign in at **cloudforge.cloud**
2. Go to **Account → API Keys**
3. Click **Generate API Key**, name it (e.g. `Claude MCP`)
4. Copy the `cf_live_...` key — shown once only
5. Paste as `CLOUDFORGE_TOKEN` in the MCP config

---

## Version bump checklist

When releasing a new version:
- [ ] Bump `version` in `package.json`
- [ ] Bump `mcpName` stays the same, only `version` changes
- [ ] Bump `version` and `packages[0].version` in `server.json`
- [ ] `npm publish --otp=CODE`
- [ ] `.\mcp-publisher.exe publish`
- [ ] Push to GitHub
