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
| `cloudforge_parse_terraform` | Turn raw HCL into a diagram structure — deterministic, no AI, **and no account needed** |
| `cloudforge_export_terraform` | Export a saved diagram's Terraform as it stands, without regenerating |
| `cloudforge_import_terraform` | Parse existing HCL → diagram structure + Mermaid preview |

### AI Architect

| Tool | Description |
|------|-------------|
| `cloudforge_chat` | Ask the CloudForge AI Architect for IaC advice, cost estimates, security reviews |
| `cloudforge_suggest_resources` | Get AI-recommended resources and connections for a described use case |

### Mold Library

| Tool | Description |
|------|-------------|
| `cloudforge_list_molds` | Browse 90 curated architecture templates (30 per cloud) — filter by provider, category, or search |
| `cloudforge_get_mold` | Full detail for one Mold: layout, "why this shape" best practices, inline Mermaid preview, forge link |

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
| `cloudforge_org_details` | Organisation overview: name, plan, member count, MFA policy, custom assistant name |
| `cloudforge_list_members` | List organisation members (name, email, role, status) |
| `cloudforge_invite_member` | Send an organisation invitation |
| `cloudforge_list_invitations` | List pending invitations |
| `cloudforge_cancel_invitation` | Cancel a pending invitation |
| `cloudforge_remove_member` | Remove a member from the organisation |

### Pricing

| Tool | Description |
|------|-------------|
| `cloudforge_get_pricing` | Get CloudForge's current plans & pricing (Free, Pro, Team, Business), incl. the 14-day free trial — fetched live |

### Deploy

Real infrastructure changes. `apply` and `destroy` stop at a human approval gate and change
nothing until `cloudforge_approve_deployment` is called, so an agent cannot deploy on its own.

| Tool | Description |
|------|-------------|
| `cloudforge_plan` | Run `terraform plan` — add/change/destroy diff plus the security quality gate. Read-only |
| `cloudforge_dry_run` | Validate and plan without touching a cloud account |
| `cloudforge_validate_deployment` | Provider and HCL pre-flight checks |
| `cloudforge_apply` | Start a real deployment. **Creates resources and costs money**; stops at the approval gate |
| `cloudforge_destroy` | Start a destroy. **Permanently deletes infrastructure**; same approval gate |
| `cloudforge_approve_deployment` | Approve or reject a job waiting at its gate — the step that actually changes the cloud |
| `cloudforge_deployment_status` | Status and log of one job |
| `cloudforge_deployment_history` | Every deployment run against a diagram |

### Quality & cost

| Tool | Description |
|------|-------------|
| `cloudforge_fix_terraform` | Repair broken HCL from an error log — the same healer the deployment pipeline uses on itself |
| `cloudforge_validate_terraform` | Syntax and provider-schema check without deploying |
| `cloudforge_estimate_cost` | Estimated monthly cost, per resource |
| `cloudforge_review_architecture` | AI review: reliability, security, cost, scaling trade-offs |

### Drift & compliance

| Tool | Description |
|------|-------------|
| `cloudforge_scan_drift` | Compare a diagram against what is actually deployed |
| `cloudforge_latest_drift` | Most recent drift report for a diagram |
| `cloudforge_drift_report` | Read one drift report by id — poll this after a scan |
| `cloudforge_compliance_frameworks` | Frameworks available to scan against (APRA CPS 234, CIS, …) |
| `cloudforge_compliance_scan` | Scan against frameworks — deterministic evidence and control mappings, never an AI opinion |

### Self-healing — detect, approve, heal

Three steps, always in that order. There is deliberately **no tool that approves a fix**: approval
means a person read what would change and consented to it, and a tool that let an assistant grant
that consent on their behalf would remove the only guarantee the feature offers. Detect and report
freely; the user approves in the CloudForge panel, the VS Code extension or the JetBrains tool
window; then heal.

| Tool | Description |
|------|-------------|
| `cloudforge_detect_remediations` | Turn a completed drift report into proposed fixes, all awaiting a person's decision |
| `cloudforge_list_remediations` | Proposals and where each one stands |
| `cloudforge_heal_approved` | Apply only what a person approved; pauses at the Terraform plan for a second yes |
| `cloudforge_remediation_ledger` | The append-only audit trail: what changed, why, and who said it could |
| `cloudforge_remediation_policy` | The bounds healing works inside — excluded resource types, how long a proposal stays actionable |

### Governance

| Tool | Description |
|------|-------------|
| `cloudforge_list_policies` | Governance policies configured for the organisation |
| `cloudforge_evaluate_policies` | Check a design against them before deploying — the pipeline enforces the same rules |

### Shared work

| Tool | Description |
|------|-------------|
| `cloudforge_foundry_diagrams` | Diagrams shared across the organisation (The Foundry) |
| `cloudforge_list_templates` | Organisation-authored templates, distinct from the built-in Molds |

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

1. Sign in at [cloudforge.cloud](https://cloudforge.cloud)
2. Go to **Account → API Keys**
3. Click **Generate API Key**, give it a name (e.g. `CloudForge MCP`), and copy the key — it starts with `cf_live_` and is shown only once
4. Set it as `CLOUDFORGE_TOKEN` in your MCP config

The key is long-lived and can be revoked from the same page at any time.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUDFORGE_TOKEN` | _(required)_ | CloudForge API key — must start with `cf_live_` |
| `CLOUDFORGE_API_URL` | `https://cloudforge.cloud/api` | API base URL — only change if self-hosting |

## Example prompts

```
Show me my recent diagrams
```
```
What serverless Molds do you have for AWS?
```
```
Show me the azure-3-tier-web-app Mold and explain why it's shaped that way
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

## Pricing

The `cloudforge_get_pricing` tool returns CloudForge's current plans live (so they're always up to date). All prices USD; paid plans include a **14-day free trial**:

| Plan | Price |
|---|---|
| **Free** | $0 — visual designer, limited export, community support |
| **Pro** | **US$9.99/mo** or US$99/yr · 14-day free trial |
| **Team** | **US$12/user/mo** (3-seat min) · 14-day free trial |
| **Business** | Contact us — volume/annual pricing |

Full details: [cloudforge.cloud/pricing](https://cloudforge.cloud/pricing).

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
