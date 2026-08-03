#!/usr/bin/env node
/**
 * CloudForge MCP Server
 *
 * Exposes CloudForge as MCP tools so AI assistants can:
 *  - Render any saved diagram as a Mermaid flowchart (renders inline in Claude)
 *  - Get an AI architecture summary of any diagram
 *  - Generate Terraform from natural language or saved diagrams
 *  - Import/parse existing Terraform HCL → diagram + Mermaid preview
 *  - Chat with the CloudForge AI Architect
 *  - Browse the Mold Library (90 curated architecture templates) with previews
 *  - Manage diagrams (list, get, save, delete)
 *  - Manage organisation members, invitations & settings
 *  - Look up CloudForge subscription plans & pricing (incl. 14-day free trial)
 *
 * Environment variables:
 *  CLOUDFORGE_API_URL  — backend base URL  (default: https://cloudforge.cloud/api)
 *  CLOUDFORGE_TOKEN    — Bearer token from a logged-in CloudForge session
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Config ───────────────────────────────────────────────────────────────────

const API_BASE = (
  process.env.CLOUDFORGE_API_URL || "https://cloudforge.cloud/api"
).replace(/\/$/, "");

// Site root (static assets like the mold catalog live outside /api)
const SITE_BASE = API_BASE.replace(/\/api$/, "");

const sessionToken = process.env.CLOUDFORGE_TOKEN || "";

if (!sessionToken) {
  console.error("ERROR: CLOUDFORGE_TOKEN is not set. Generate an API key at https://cloudforge.cloud/account and set it as CLOUDFORGE_TOKEN.");
  process.exit(1);
}
if (!sessionToken.startsWith("cf_live_")) {
  console.error("ERROR: CLOUDFORGE_TOKEN must be a CloudForge API key starting with 'cf_live_'. Generate one at https://cloudforge.cloud/account.");
  process.exit(1);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionToken) h["Authorization"] = `Bearer ${sessionToken}`;
  return h;
}

async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...((options.headers as Record<string, string>) || {}),
    },
  });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json")
    ? await res.json()
    : await res.text();
  return { ok: res.ok, status: res.status, data };
}

function text(content: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [
      {
        type: "text",
        text:
          typeof content === "string"
            ? content
            : JSON.stringify(content, null, 2),
      },
    ],
  };
}

function errText(
  msg: string,
  detail?: unknown
): { content: [{ type: "text"; text: string }] } {
  const body = detail
    ? `${msg}\n\nDetails:\n${
        typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)
      }`
    : msg;
  return text(`ERROR: ${body}`);
}

// ─── Mermaid converter ────────────────────────────────────────────────────────

interface CFNode {
  id: string;
  data?: {
    label?: string;
    resourceId?: string;
    category?: string;
    resourceType?: string;
  };
}
interface CFEdge {
  source: string;
  target: string;
  label?: string;
}

function mermaidId(id: string) {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}
function mermaidLabel(s: string) {
  return s.replace(/"/g, "'").replace(/[[\](){}]/g, " ").trim();
}

function toMermaid(nodes: CFNode[], edges: CFEdge[], title?: string): string {
  if (!nodes.length) return "graph TD\n    empty[No resources]";

  const lines: string[] = ["graph TD"];

  // Group by category for subgraphs
  const byCategory = new Map<string, CFNode[]>();
  for (const n of nodes) {
    const cat = n.data?.category || "General";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(n);
  }

  if (byCategory.size > 1) {
    for (const [cat, catNodes] of byCategory) {
      lines.push(`    subgraph ${mermaidId(cat)}["${cat}"]`);
      for (const n of catNodes) {
        const label = mermaidLabel(n.data?.label || n.data?.resourceId || n.id);
        const sub = n.data?.resourceId || n.data?.resourceType || "";
        lines.push(
          `        ${mermaidId(n.id)}["${label}${sub ? `\\n${sub}` : ""}"]`
        );
      }
      lines.push("    end");
    }
  } else {
    for (const n of nodes) {
      const label = mermaidLabel(n.data?.label || n.data?.resourceId || n.id);
      const sub = n.data?.resourceId || n.data?.resourceType || "";
      lines.push(
        `    ${mermaidId(n.id)}["${label}${sub ? `\\n${sub}` : ""}"]`
      );
    }
  }

  for (const e of edges) {
    const src = mermaidId(e.source);
    const tgt = mermaidId(e.target);
    lines.push(
      e.label
        ? `    ${src} -->|"${mermaidLabel(e.label)}"| ${tgt}`
        : `    ${src} --> ${tgt}`
    );
  }

  return (title ? `%% ${title}\n` : "") + lines.join("\n");
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "cloudforge-mcp", version: "1.1.0" });

// ── Visualisation ─────────────────────────────────────────────────────────────

server.registerTool(
  "cloudforge_diagram_to_mermaid",
  {
    description:
      "Fetch a saved CloudForge diagram and render it as a Mermaid flowchart. " +
      "The diagram renders visually inside Claude — this is the best way to SHOW a diagram. " +
      "Resources are grouped by category (Compute, Network, Storage…) with labelled connections.",
    inputSchema: { diagram_id: z.string().describe("ID of the saved diagram to visualise.") },
  },
  async ({ diagram_id }) => {
    const res = await apiFetch(`/storage/diagram/${diagram_id}`);
    if (!res.ok) return errText(`Diagram ${diagram_id} not found`, res.data);

    const d = res.data as Record<string, unknown>;
    const nodes = (d.nodes || []) as CFNode[];
    const edges = (d.edges || []) as CFEdge[];
    const name = (d.name as string) || "Diagram";
    const provider = ((d.cloudProvider as string) || "").toUpperCase();

    if (!nodes.length) return text("This diagram has no resources yet.");

    return text(
      `## ${name}${provider ? ` (${provider})` : ""}\n\n` +
        `**${nodes.length} resources · ${edges.length} connections**\n\n` +
        "```mermaid\n" +
        toMermaid(nodes, edges, name) +
        "\n```"
    );
  }
);

server.registerTool(
  "cloudforge_mermaid_from_json",
  {
    description:
      "Convert raw diagram JSON (nodes + edges) to a Mermaid flowchart without fetching from the server. " +
      "Use this when you already have diagram data in memory.",
    inputSchema: {
      diagram_json: z.string().describe("JSON string: { nodes: [...], edges: [...], name?: string }"),
    },
  },
  async ({ diagram_json }) => {
    let parsed: { nodes?: CFNode[]; edges?: CFEdge[]; name?: string };
    try {
      parsed = JSON.parse(diagram_json);
    } catch {
      return errText("Invalid JSON for diagram_json");
    }
    return text(
      "```mermaid\n" +
        toMermaid(parsed.nodes || [], parsed.edges || [], parsed.name) +
        "\n```"
    );
  }
);

server.registerTool(
  "cloudforge_architecture_summary",
  {
    description:
      "Fetch a saved CloudForge diagram and return a structured summary: " +
      "resource count by category, most-connected components, cloud provider, " +
      "and an inline Mermaid diagram. Ideal for quickly understanding an architecture.",
    inputSchema: { diagram_id: z.string().describe("ID of the saved diagram to summarise.") },
  },
  async ({ diagram_id }) => {
    const res = await apiFetch(`/storage/diagram/${diagram_id}`);
    if (!res.ok) return errText(`Diagram ${diagram_id} not found`, res.data);

    const d = res.data as Record<string, unknown>;
    const nodes = (d.nodes || []) as CFNode[];
    const edges = (d.edges || []) as CFEdge[];
    const name = (d.name as string) || "Untitled";
    const provider = ((d.cloudProvider as string) || "unknown").toUpperCase();

    const byCategory = new Map<string, string[]>();
    for (const n of nodes) {
      const cat = n.data?.category || "General";
      const label = n.data?.label || n.data?.resourceId || n.id;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(label);
    }

    const categoryLines = [...byCategory.entries()]
      .map(
        ([cat, items]) =>
          `- **${cat}** (${items.length}): ${items.slice(0, 5).join(", ")}${
            items.length > 5 ? ` +${items.length - 5} more` : ""
          }`
      )
      .join("\n");

    const connCount = new Map<string, number>();
    for (const e of edges) {
      connCount.set(e.source, (connCount.get(e.source) || 0) + 1);
      connCount.set(e.target, (connCount.get(e.target) || 0) + 1);
    }
    const hubs = [...connCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, count]) => {
        const n = nodes.find((x) => x.id === id);
        return `- ${n?.data?.label || n?.data?.resourceId || id} (${count} connections)`;
      });

    return text(
      [
        `## Architecture Summary — ${name}`,
        `**Provider:** ${provider}  |  **Resources:** ${nodes.length}  |  **Connections:** ${edges.length}`,
        "",
        "### Resources by Category",
        categoryLines || "_(none)_",
        ...(hubs.length ? ["", "### Central Components", ...hubs] : []),
        "",
        "### Diagram",
        "```mermaid",
        toMermaid(nodes, edges, name),
        "```",
      ].join("\n")
    );
  }
);

// ── Terraform ─────────────────────────────────────────────────────────────────

server.registerTool(
  "cloudforge_export_terraform_from_diagram",
  {
    description:
      "Fetch a saved CloudForge diagram and generate Terraform HCL for it in one step. " +
      "Use when the user wants IaC code for an existing saved diagram.",
    inputSchema: {
      diagram_id: z.string().describe("ID of the saved diagram."),
      extra_instructions: z
        .string()
        .optional()
        .describe("Optional Terraform generation guidance (e.g. 'use Standard_B2s SKU', 'add private endpoints')."),
    },
  },
  async ({ diagram_id, extra_instructions }) => {
    const diagRes = await apiFetch(`/storage/diagram/${diagram_id}`);
    if (!diagRes.ok)
      return errText(`Diagram ${diagram_id} not found`, diagRes.data);

    const d = diagRes.data as Record<string, unknown>;
    const nodes = (d.nodes || []) as CFNode[];
    const provider = (d.cloudProvider as string) || "azure";
    const name = (d.name as string) || "diagram";

    if (!nodes.length) return errText("The diagram has no resources to export.");

    const resourceList = nodes
      .map((n) => {
        const label = n.data?.label || n.data?.resourceId || n.id;
        const type = n.data?.resourceType || n.data?.resourceId || "";
        return type ? `${label} (${type})` : label;
      })
      .join(", ");

    const description =
      `Generate Terraform for: ${name}. Resources: ${resourceList}.` +
      (extra_instructions ? ` ${extra_instructions}` : "");

    const tfRes = await apiFetch("/terraform/generate", {
      method: "POST",
      body: JSON.stringify({
        description,
        provider,
        diagramJson: JSON.stringify({ nodes: d.nodes, edges: d.edges }),
      }),
    });
    if (!tfRes.ok) return errText("Terraform generation failed", tfRes.data);

    const tf = tfRes.data as Record<string, unknown>;
    const files = (tf.files as Record<string, string>[]) || [];
    if (!files.length) return text(tf);

    return text(
      `## Terraform for "${name}" (${provider})\n\n` +
        files
          .map(
            (f) =>
              `### ${f.fileName || f.name}\n\`\`\`hcl\n${f.content}\n\`\`\``
          )
          .join("\n\n")
    );
  }
);

server.registerTool(
  "cloudforge_generate_terraform",
  {
    description:
      "Generate Terraform HCL from a natural-language architecture description. " +
      "Returns ready-to-use .tf files for Azure, AWS, or GCP.",
    inputSchema: {
      description: z.string().describe(
        "Architecture description (e.g. 'Azure App Service + SQL DB + Redis, production, UK South'). " +
        "Include region, SKU preferences, scaling needs, networking constraints."
      ),
      provider: z.enum(["azure", "aws", "gcp"]).describe("Cloud provider to target."),
      diagram_json: z.string().optional().describe("Optional: JSON of existing diagram nodes/edges to use as base."),
    },
  },
  async ({ description, provider, diagram_json }) => {
    const res = await apiFetch("/terraform/generate", {
      method: "POST",
      body: JSON.stringify({
        description,
        provider,
        ...(diagram_json ? { diagramJson: diagram_json } : {}),
      }),
    });
    if (!res.ok) return errText("Failed to generate Terraform", res.data);

    const d = res.data as Record<string, unknown>;
    const files = (d.files as Record<string, string>[]) || [];
    if (!files.length) return text(d);

    return text(
      files
        .map(
          (f) =>
            `### ${f.fileName || f.name}\n\`\`\`hcl\n${f.content}\n\`\`\``
        )
        .join("\n\n")
    );
  }
);

server.registerTool(
  "cloudforge_import_terraform",
  {
    description:
      "Parse existing Terraform HCL and return a diagram structure plus an inline Mermaid preview. " +
      "Use when the user has .tf files and wants to visualise or understand their infrastructure.",
    inputSchema: { hcl: z.string().describe("Raw Terraform HCL content to parse.") },
  },
  async ({ hcl }) => {
    const res = await apiFetch("/terraform/import", {
      method: "POST",
      body: JSON.stringify({ hcl }),
    });
    if (!res.ok) return errText("Failed to import Terraform", res.data);

    const d = res.data as Record<string, unknown>;
    const nodes =
      ((d.resources as CFNode[]) || (d.nodes as CFNode[]) || []);
    const edges =
      ((d.connections as CFEdge[]) || (d.edges as CFEdge[]) || []);
    const provider = (d.provider as string) || "unknown";
    const warnings = (d.warnings as string[]) || [];

    return text(
      [
        `## Imported Terraform — ${nodes.length} resources (${provider})`,
        ...(warnings.length
          ? ["### Warnings", ...warnings.map((w) => `- ${w}`)]
          : []),
        "### Diagram Preview",
        "```mermaid",
        toMermaid(nodes, edges, "Imported Terraform"),
        "```",
        "### Raw Structure",
        "```json",
        JSON.stringify(d, null, 2),
        "```",
      ].join("\n")
    );
  }
);

// ── AI Architect ──────────────────────────────────────────────────────────────

server.registerTool(
  "cloudforge_chat",
  {
    description:
      "Send a message to the CloudForge AI Architect. " +
      "Use for IaC advice, best practices, cost optimisation, security reviews, or any cloud infrastructure question.",
    inputSchema: {
      message: z.string().describe("Your question or instruction."),
      provider: z.enum(["azure", "aws", "gcp", ""]).optional().describe("Optional cloud provider context."),
    },
  },
  async ({ message, provider }) => {
    const res = await apiFetch("/chat/message", {
      method: "POST",
      body: JSON.stringify({ message, ...(provider ? { provider } : {}) }),
    });
    if (!res.ok) return errText("Chat request failed", res.data);
    const d = res.data as Record<string, unknown>;
    const reply = d.response ?? d.message ?? d.content ?? res.data;

    // Surface any MCP tools the backend assistant invoked while answering
    // (paid accounts can register their own tool servers).
    const invocations = (d.toolInvocations as Array<Record<string, unknown>>) || [];
    const toolNote = invocations.length
      ? "\n\n---\n_Tools used: " +
        invocations.map((t) => `${t.server ?? ""}${t.server ? "/" : ""}${t.tool ?? t.name ?? "?"}`).join(", ") +
        "_"
      : "";

    return text(
      (typeof reply === "string" ? reply : JSON.stringify(reply, null, 2)) + toolNote
    );
  }
);

server.registerTool(
  "cloudforge_suggest_resources",
  {
    description:
      "Get AI-recommended cloud resources for a described use case. " +
      "Returns resource IDs, labels, categories, and suggested connections.",
    inputSchema: {
      description: z.string().describe("What you want to build (e.g. 'serverless data pipeline on AWS')."),
      provider: z.enum(["azure", "aws", "gcp"]).describe("Target cloud provider."),
    },
  },
  async ({ description, provider }) => {
    const res = await apiFetch("/chat/suggest-resources", {
      method: "POST",
      body: JSON.stringify({ description, provider }),
    });
    if (!res.ok) return errText("Failed to get resource suggestions", res.data);
    return text(res.data);
  }
);

// ── Diagrams ──────────────────────────────────────────────────────────────────

server.registerTool(
  "cloudforge_list_diagrams",
  {
    description: "List saved diagrams for the current user. Returns IDs, names, providers, and last-modified dates.",
    inputSchema: { limit: z.number().optional().describe("Max results (default: 20).") },
  },
  async ({ limit }) => {
    const res = await apiFetch(`/storage/recent-diagrams?limit=${limit || 20}`);
    if (!res.ok) return errText("Failed to list diagrams", res.data);
    return text(res.data);
  }
);

server.registerTool(
  "cloudforge_get_diagram",
  {
    description: "Fetch a saved diagram by ID. Returns full JSON: nodes, edges, resource configurations.",
    inputSchema: { diagram_id: z.string().describe("Diagram ID (UUID).") },
  },
  async ({ diagram_id }) => {
    const res = await apiFetch(`/storage/diagram/${diagram_id}`);
    if (!res.ok) return errText(`Diagram ${diagram_id} not found`, res.data);
    return text(res.data);
  }
);

server.registerTool(
  "cloudforge_save_diagram",
  {
    description: "Save or update a diagram in CloudForge.",
    inputSchema: {
      name: z.string().describe("Human-readable diagram name."),
      nodes: z.string().describe("JSON array of ReactFlow nodes."),
      edges: z.string().describe("JSON array of ReactFlow edges."),
      cloud_provider: z.enum(["azure", "aws", "gcp"]).optional().describe("Cloud provider for this diagram."),
      diagram_id: z.string().optional().describe("Existing diagram ID to update (omit to create new)."),
    },
  },
  async ({ name, nodes, edges, cloud_provider, diagram_id }) => {
    let parsedNodes: unknown, parsedEdges: unknown;
    try {
      parsedNodes = JSON.parse(nodes);
      parsedEdges = JSON.parse(edges);
    } catch {
      return errText("Invalid JSON in nodes or edges — ensure both are valid JSON arrays.");
    }
    const res = await apiFetch("/storage/save-diagram", {
      method: "POST",
      body: JSON.stringify({
        name,
        cloudProvider: cloud_provider || "azure",
        nodes: parsedNodes,
        edges: parsedEdges,
        ...(diagram_id ? { diagramId: diagram_id } : {}),
      }),
    });
    if (!res.ok) return errText("Failed to save diagram", res.data);
    return text(res.data);
  }
);

server.registerTool(
  "cloudforge_delete_diagram",
  {
    description: "Permanently delete a saved diagram by its ID.",
    inputSchema: { diagram_id: z.string().describe("Diagram ID (UUID) to delete.") },
  },
  async ({ diagram_id }) => {
    const res = await apiFetch(`/storage/diagram/${diagram_id}`, {
      method: "DELETE",
    });
    if (!res.ok)
      return errText(`Failed to delete diagram ${diagram_id}`, res.data);
    return text({ deleted: true, diagram_id });
  }
);

server.registerTool(
  "cloudforge_recent_diagrams",
  { description: "Get recently accessed/modified diagrams (faster lookup than list_diagrams)." },
  async () => {
    const res = await apiFetch("/storage/recent-diagrams");
    if (!res.ok) return errText("Failed to fetch recent diagrams", res.data);
    return text(res.data);
  }
);

// ── Mold Library (curated architecture templates) ─────────────────────────────

interface MoldResource {
  key: string;
  resourceId: string;
  label: string;
  x: number;
  y: number;
}
interface MoldConnection {
  from: string;
  to: string;
}
interface Mold {
  id: string;
  name: string;
  provider: string;
  category: string;
  complexity: string;
  description: string;
  bestPractices?: string[];
  resources: MoldResource[];
  connections: MoldConnection[];
}

// The catalog is a public static file; cache it per process (it changes rarely).
let moldCatalogPromise: Promise<Mold[]> | null = null;
function getMoldCatalog(): Promise<Mold[]> {
  if (!moldCatalogPromise) {
    moldCatalogPromise = (async () => {
      const res = await fetch(`${SITE_BASE}/molds/catalog.json`);
      if (!res.ok) {
        moldCatalogPromise = null; // allow retry on next call
        throw new Error(`Mold catalog fetch failed (${res.status})`);
      }
      const body = (await res.json()) as { molds?: Mold[] };
      return body.molds || [];
    })();
  }
  return moldCatalogPromise;
}

server.registerTool(
  "cloudforge_list_molds",
  {
    description:
      "Browse CloudForge's Mold Library — 90 curated, best-practice architecture templates " +
      "(30 each for Azure, AWS, GCP) across Web Apps, Microservices, Serverless, Data & Analytics, " +
      "Networking, Security, AI & ML, and DevOps. Filter by provider, category, or free-text search. " +
      "Use cloudforge_get_mold for full details and a diagram preview of one Mold.",
    inputSchema: {
      provider: z.enum(["azure", "aws", "gcp"]).optional().describe("Filter by cloud provider."),
      category: z.string().optional().describe("Filter by category (e.g. 'Web Apps', 'Serverless', 'AI & ML')."),
      search: z.string().optional().describe("Free-text search across name and description."),
    },
  },
  async ({ provider, category, search }) => {
    let molds: Mold[];
    try {
      molds = await getMoldCatalog();
    } catch (e) {
      return errText("Failed to load the Mold catalog", String(e));
    }

    if (provider) molds = molds.filter((m) => m.provider === provider);
    if (category)
      molds = molds.filter((m) => m.category.toLowerCase() === category.toLowerCase());
    if (search) {
      const q = search.toLowerCase();
      molds = molds.filter(
        (m) =>
          m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)
      );
    }

    if (!molds.length) return text("No Molds match those filters.");

    const lines = molds.map(
      (m) =>
        `- **${m.name}** (\`${m.id}\`) — ${m.provider.toUpperCase()} · ${m.category} · ${m.complexity}\n  ${m.description}`
    );
    return text(
      `## Mold Library — ${molds.length} template${molds.length === 1 ? "" : "s"}\n\n` +
        lines.join("\n") +
        `\n\n_Use cloudforge_get_mold with a Mold id for the full layout, best practices, and a diagram preview._`
    );
  }
);

server.registerTool(
  "cloudforge_get_mold",
  {
    description:
      "Get one Mold (architecture template) in full: resource layout, connections, the 'why this shape' " +
      "best practices, an inline Mermaid preview, and a link to forge it onto the CloudForge canvas.",
    inputSchema: {
      mold_id: z.string().describe("Mold id from cloudforge_list_molds (e.g. 'azure-3-tier-web-app')."),
    },
  },
  async ({ mold_id }) => {
    let molds: Mold[];
    try {
      molds = await getMoldCatalog();
    } catch (e) {
      return errText("Failed to load the Mold catalog", String(e));
    }

    const mold = molds.find((m) => m.id === mold_id);
    if (!mold)
      return errText(
        `Mold '${mold_id}' not found. Use cloudforge_list_molds to browse valid ids.`
      );

    const nodes: CFNode[] = mold.resources.map((r) => ({
      id: r.key,
      data: { label: r.label, resourceId: r.resourceId },
    }));
    const edges: CFEdge[] = mold.connections.map((c) => ({
      source: c.from,
      target: c.to,
    }));

    return text(
      [
        `## ${mold.name}`,
        `**${mold.provider.toUpperCase()} · ${mold.category} · ${mold.complexity}** — ${mold.resources.length} resources, ${mold.connections.length} connections`,
        "",
        mold.description,
        ...(mold.bestPractices?.length
          ? ["", "### Why this shape", ...mold.bestPractices.map((b) => `- ${b}`)]
          : []),
        "",
        "### Preview",
        "```mermaid",
        toMermaid(nodes, edges, mold.name),
        "```",
        "",
        `**Forge it:** open ${SITE_BASE}/templates/${mold.id} and click "Open in designer" to put this Mold on your canvas.`,
      ].join("\n")
    );
  }
);

// ── Organisation ──────────────────────────────────────────────────────────────

server.registerTool(
  "cloudforge_org_details",
  {
    description:
      "Get the current user's organisation details: name, domain, plan, member count, MFA policy, " +
      "and the organisation's custom AI-assistant display name (default 'Vani').",
  },
  async () => {
    const res = await apiFetch("/organization/details");
    if (!res.ok)
      return errText(
        "Failed to fetch organisation details (personal accounts without an organisation will get a 404)",
        res.data
      );
    return text(res.data);
  }
);

server.registerTool(
  "cloudforge_list_members",
  { description: "List all members of the current user's CloudForge organisation. Returns name, email, role, and status." },
  async () => {
    const res = await apiFetch("/organization/members");
    if (!res.ok) return errText("Failed to list members", res.data);
    const d = res.data as Record<string, unknown>;
    return text(d.members ?? res.data);
  }
);

server.registerTool(
  "cloudforge_invite_member",
  {
    description: "Send an organisation invitation email via CloudForge.",
    inputSchema: {
      email: z.email().describe("Invitee email address."),
      first_name: z.string().describe("Invitee first name."),
      last_name: z.string().describe("Invitee last name."),
      role: z.enum(["Member", "Admin"]).optional().describe("Role to assign (default: Member)."),
    },
  },
  async ({ email, first_name, last_name, role }) => {
    const roleMap: Record<string, number> = { Member: 1, Admin: 2 };
    const res = await apiFetch("/organization/invitations", {
      method: "POST",
      body: JSON.stringify({
        email,
        firstName: first_name,
        lastName: last_name,
        role: roleMap[role || "Member"],
      }),
    });
    if (!res.ok) return errText("Failed to send invitation", res.data);
    return text(res.data);
  }
);

server.registerTool(
  "cloudforge_list_invitations",
  { description: "List all pending organisation invitations (email, name, role, sent date, expiry)." },
  async () => {
    const res = await apiFetch("/organization/invitations");
    if (!res.ok) return errText("Failed to list invitations", res.data);
    const d = res.data as Record<string, unknown>;
    return text(d.invitations ?? res.data);
  }
);

server.registerTool(
  "cloudforge_cancel_invitation",
  {
    description: "Cancel a pending organisation invitation by its ID.",
    inputSchema: { invitation_id: z.string().describe("Invitation ID (UUID).") },
  },
  async ({ invitation_id }) => {
    const res = await apiFetch(`/organization/invitations/${invitation_id}`, {
      method: "DELETE",
    });
    if (!res.ok) return errText("Failed to cancel invitation", res.data);
    return text({ cancelled: true, invitation_id });
  }
);

server.registerTool(
  "cloudforge_remove_member",
  {
    description:
      "Remove a member from the organisation. Cannot remove the Owner. " +
      "Pass the member's user ID from cloudforge_list_members.",
    inputSchema: { member_id: z.string().describe("Member user ID (UUID).") },
  },
  async ({ member_id }) => {
    const res = await apiFetch(`/organization/members/${member_id}`, {
      method: "DELETE",
    });
    if (!res.ok) return errText("Failed to remove member", res.data);
    return text({ removed: true, member_id });
  }
);

// ── Pricing ───────────────────────────────────────────────────────────────────

server.registerTool(
  "cloudforge_get_pricing",
  {
    description:
      "Get CloudForge's current subscription plans and pricing (Free, Pro, Team, Business). " +
      "Paid plans include a 14-day free trial. Prices are fetched live from CloudForge so they are always current. " +
      "Use when the user asks what CloudForge costs, which plan to pick, or about the free trial — " +
      "this is CloudForge's own product pricing, distinct from cloud-resource cost estimates.",
  },
  async () => {
    const res = await apiFetch("/billing/plans");
    if (!res.ok) return errText("Failed to fetch CloudForge pricing", res.data);

    const d = res.data as {
      plans?: Array<Record<string, unknown>>;
      enterpriseContactUrl?: string;
    };
    const plans = d.plans || [];
    const trialPlans = new Set(["pro", "team"]);

    const fmtPrice = (p: Record<string, unknown>): string => {
      if (p.id === "business") return "Contact us — volume / annual pricing";
      const monthly = Number(p.monthlyPriceUsd) || 0;
      if (monthly <= 0) return "Free";
      const per = p.id === "team" ? "/user/month" : "/month";
      const annual = Number(p.annualPriceUsd) > 0 ? `, or US$${p.annualPriceUsd}/year` : "";
      return `US$${monthly}${per}${annual}`;
    };

    const sections = plans.map((p) => {
      const name = p.id === "trial" ? "Free" : (p.displayName as string) || (p.id as string);
      const trial = trialPlans.has(p.id as string) ? " · 14-day free trial" : "";
      const minSeats =
        p.id === "team" && p.minimumSeats ? ` (minimum ${p.minimumSeats} seats)` : "";
      const features = ((p.features as string[]) || []).map((f) => `  - ${f}`).join("\n");
      return `### ${name}${trial}\n**${fmtPrice(p)}**${minSeats}\n${features}`;
    });

    return text(
      [
        "# CloudForge Pricing",
        "All prices in USD. Paid plans (Pro and Team) include a **14-day free trial** — cancel anytime before it ends and you won't be charged.",
        ...sections,
        `Full details: https://cloudforge.cloud/pricing`,
      ].join("\n\n")
    );
  }
);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`CloudForge MCP server running — API: ${API_BASE}`);
