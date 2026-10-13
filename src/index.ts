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

// Deliberately no hard exit, and deliberately no format check.
//
// Exiting on a missing token was wrong: cloudforge_parse_terraform,
// cloudforge_list_molds and cloudforge_get_pricing need no account at all, and a
// server that dies at startup can never serve them. Signed-out users are a real
// audience — that path is the product's front door.
//
// The format check was wrong too, and worse: it demanded a `cf_live_` API key,
// but the VS Code extension and the JetBrains plugin both pass the JWT they hold
// from sign-in (SecretStorage key `cloudforge.jwt`). The API accepts either as a
// bearer token; only this guard did not, so the server exited instantly for every
// editor user. Whether a token is valid is the API's judgement, not ours.
if (!sessionToken) {
  console.error(
    "CloudForge MCP: no CLOUDFORGE_TOKEN set — tools that need an account will say so. " +
      "Sign in through the CloudForge extension, or set a key from https://cloudforge.cloud/account."
  );
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
  // Signed out, a 401 is expected rather than exceptional — say which of the two
  // it is, because "unauthorized" alone leaves the user guessing whether their
  // token is wrong or simply absent.
  if ((res.status === 401 || res.status === 403) && !sessionToken) {
    return {
      ok: false,
      status: res.status,
      data:
        "This needs a CloudForge account. Sign in through the CloudForge extension, " +
        "or set CLOUDFORGE_TOKEN from https://cloudforge.cloud/account. " +
        "Tools that work without one: cloudforge_parse_terraform, cloudforge_list_molds, " +
        "cloudforge_get_mold, cloudforge_get_pricing, cloudforge_mermaid_from_json.",
    };
  }

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

const server = new McpServer({ name: "cloudforge-mcp", version: "1.2.0" });

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

// ─── Deploy: plan, apply, approve, destroy ────────────────────────────────────
//
// These endpoints stream Server-Sent Events rather than returning JSON, and the
// apply path deliberately BLOCKS on a human approval gate for up to 30 minutes.
// Holding a stream open that long inside a tool call is the wrong shape, so every
// deploy tool here reads the stream with a hard cap, extracts the markers the
// orchestrator emits, and hands back a job id the agent can poll.

const SSE_MARKERS = [
  "[JOB_ID]",
  "[HEALED_CODE]",
  "[PLAN_DONE_AWAITING_APPROVAL]",
  "[QUALITY_REPORT]",
  "[PLAN_JSON]",
  "[ERROR]",
  "[DONE]",
] as const;

interface StreamResult {
  jobId?: string;
  awaitingApproval: boolean;
  done: boolean;
  error?: string;
  planJson?: unknown;
  qualityReport?: unknown;
  log: string[];
}

function decodeMarker(line: string, marker: string): unknown {
  const raw = line.slice(marker.length).trim();
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return raw;
  }
}

/**
 * Consumes any of the API's SSE streams until it completes, reaches an approval
 * gate, or hits [capMs]. Returns whatever markers arrived.
 *
 * Shared by the deployment tools and the drift healer: both speak the same
 * marker protocol, and a second copy of this loop would drift from the first.
 */
async function streamSse(
  path: string,
  body: Record<string, unknown> | null,
  capMs = 120_000
): Promise<StreamResult> {
  const result: StreamResult = { awaitingApproval: false, done: false, log: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), capMs);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: authHeaders(),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      // A refusal arrives as a 400 with a sentence worth repeating verbatim —
      // "HTTP 400" would strip the only part the user can act on.
      let detail = "";
      try {
        const raw = await res.text();
        detail = (JSON.parse(raw) as { message?: string }).message ?? raw;
      } catch { /* non-JSON body */ }
      result.error = detail ? detail.slice(0, 600) : `HTTP ${res.status}`;
      return result;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.replace(/^data:\s?/, "").trimEnd();
        if (!line) continue;

        if (line.startsWith("[JOB_ID]")) result.jobId = String(decodeMarker(line, "[JOB_ID]"));
        else if (line.startsWith("[PLAN_JSON]")) result.planJson = decodeMarker(line, "[PLAN_JSON]");
        else if (line.startsWith("[QUALITY_REPORT]")) result.qualityReport = decodeMarker(line, "[QUALITY_REPORT]");
        else if (line.startsWith("[ERROR]")) result.error = String(decodeMarker(line, "[ERROR]"));
        else if (line.startsWith("[PLAN_DONE_AWAITING_APPROVAL]")) {
          result.awaitingApproval = true;
          result.planJson ??= decodeMarker(line, "[PLAN_DONE_AWAITING_APPROVAL]");
        } else if (line.startsWith("[DONE]")) result.done = true;
        else if (!SSE_MARKERS.some((m) => line.startsWith(m))) result.log.push(line);
      }

      // Nothing useful comes after either of these, and apply would otherwise
      // hold the connection open on the 30-minute approval gate.
      if (result.awaitingApproval || result.done || result.error) break;
    }

    await reader.cancel().catch(() => {});
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      result.error ??= `Stream exceeded ${Math.round(capMs / 1000)}s — poll cloudforge_deployment_status with the job id.`;
    } else {
      result.error ??= (err as Error).message;
    }
  } finally {
    clearTimeout(timer);
  }

  return result;
}

function streamDeployment(
  action: "plan" | "apply" | "dryrun" | "validate" | "destroy",
  body: Record<string, unknown>,
  capMs = 120_000
): Promise<StreamResult> {
  return streamSse(`/Deployment/${action}`, body, capMs);
}

function renderStream(action: string, r: StreamResult): string {
  const parts = [`## ${action}`];
  if (r.jobId) parts.push(`**Job:** \`${r.jobId}\``);
  if (r.error) parts.push(`**Error:** ${r.error}`);

  if (r.planJson) {
    const p = r.planJson as Record<string, unknown>;
    const add = p.add ?? p.create ?? "?";
    const change = p.change ?? p.update ?? "?";
    const destroy = p.destroy ?? p.delete ?? "?";
    parts.push(`**Plan:** ${add} to add · ${change} to change · ${destroy} to destroy`);
    if (Number(destroy) > 0) {
      parts.push(`> ⚠️ This plan DESTROYS ${destroy} resource(s). Confirm with the user before approving.`);
    }
  }

  if (r.qualityReport) {
    parts.push("**Quality gate:**\n```json\n" + JSON.stringify(r.qualityReport, null, 2).slice(0, 2000) + "\n```");
  }

  if (r.awaitingApproval) {
    parts.push(
      "**Awaiting approval.** Nothing has been applied. Call `cloudforge_approve_deployment` " +
        "with this job id once the user has agreed to the plan above."
    );
  } else if (r.done) {
    parts.push("**Finished.**");
  }

  const tail = r.log.filter(Boolean).slice(-40);
  if (tail.length) parts.push("```\n" + tail.join("\n").slice(-4000) + "\n```");

  return parts.join("\n\n");
}

const deploymentTarget = {
  diagram_id: z.string().optional().describe("Saved diagram to deploy. Provide this or terraform_code."),
  terraform_code: z.string().optional().describe("Raw HCL to deploy instead of a saved diagram."),
  cloud_provider: z.enum(["azure", "aws", "gcp"]).optional().describe("Target cloud. Defaults to the diagram's own provider."),
  connection_id: z.string().optional().describe("Cloud connection to deploy through."),
};

function deployBody(a: Record<string, unknown>): Record<string, unknown> {
  return {
    diagramId: a.diagram_id,
    terraformCode: a.terraform_code,
    cloudProvider: a.cloud_provider,
    connectionId: a.connection_id,
    overridePolicy: a.override_policy ?? false,
  };
}

server.registerTool(
  "cloudforge_plan",
  {
    description:
      "Run `terraform plan` and return the add/change/destroy diff plus the security quality gate. " +
      "Read-only — nothing is created or modified. Always plan before applying, and show the user " +
      "the diff before calling cloudforge_apply.",
    inputSchema: deploymentTarget,
  },
  async (a) => text(renderStream("terraform plan", await streamDeployment("plan", deployBody(a))))
);

server.registerTool(
  "cloudforge_dry_run",
  {
    description:
      "Validate and plan without touching any cloud account — the safest way to check whether " +
      "infrastructure is deployable. Use this when the user has no cloud connection configured.",
    inputSchema: deploymentTarget,
  },
  async (a) => text(renderStream("dry run", await streamDeployment("dryrun", deployBody(a))))
);

server.registerTool(
  "cloudforge_validate_deployment",
  {
    description: "Run provider and HCL pre-flight checks (credentials, syntax, required fields) without planning.",
    inputSchema: deploymentTarget,
  },
  async (a) => text(renderStream("validate", await streamDeployment("validate", deployBody(a))))
);

server.registerTool(
  "cloudforge_apply",
  {
    description:
      "Start a real deployment — this CREATES CLOUD RESOURCES AND COSTS MONEY. " +
      "It stops at a human approval gate and applies nothing until cloudforge_approve_deployment is called. " +
      "Never call this without having shown the user a plan first.",
    inputSchema: {
      ...deploymentTarget,
      override_policy: z
        .boolean()
        .optional()
        .describe("Proceed despite policy violations. Records the intent to override; ask the user first."),
    },
  },
  async (a) => text(renderStream("terraform apply", await streamDeployment("apply", deployBody(a))))
);

server.registerTool(
  "cloudforge_destroy",
  {
    description:
      "Start a `terraform destroy` — this PERMANENTLY DELETES the deployed infrastructure. " +
      "Stops at the same approval gate as apply. Confirm explicitly with the user first.",
    inputSchema: deploymentTarget,
  },
  async (a) => text(renderStream("terraform destroy", await streamDeployment("destroy", deployBody(a))))
);

server.registerTool(
  "cloudforge_approve_deployment",
  {
    description:
      "Approve (or reject) a deployment waiting at its approval gate. Only call this after the user " +
      "has seen the plan and said yes — this is the step that actually changes their cloud.",
    inputSchema: {
      job_id: z.string().describe("Job id from cloudforge_plan / cloudforge_apply."),
      approved: z.boolean().describe("true applies the plan; false abandons the job."),
    },
  },
  async ({ job_id, approved }) => {
    const res = await apiFetch(`/Deployment/${job_id}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    });
    if (!res.ok) return errText("Approval failed", res.data);
    return text(approved ? `Approved. Job \`${job_id}\` is applying.` : `Job \`${job_id}\` rejected; nothing applied.`);
  }
);

server.registerTool(
  "cloudforge_deployment_status",
  {
    description: "Current status and log of one deployment job.",
    inputSchema: { job_id: z.string().describe("Deployment job id.") },
  },
  async ({ job_id }) => {
    const res = await apiFetch(`/Deployment/${job_id}`);
    if (!res.ok) return errText(`Job ${job_id} not found`, res.data);
    const j = res.data as Record<string, unknown>;
    return text(
      `## Deployment \`${job_id}\`\n\n` +
        `**${j.action}** · **${j.status}** · ${j.cloudProvider}\n` +
        `Started ${j.createdAt}${j.completedAt ? ` · finished ${j.completedAt}` : ""}\n\n` +
        (j.log ? "```\n" + String(j.log).slice(-4000) + "\n```" : "")
    );
  }
);

server.registerTool(
  "cloudforge_deployment_history",
  {
    description: "Every deployment job run against one diagram, newest first.",
    inputSchema: { diagram_id: z.string().describe("Diagram id.") },
  },
  async ({ diagram_id }) => {
    const res = await apiFetch(`/Deployment/diagram/${diagram_id}`);
    if (!res.ok) return errText("Could not load deployment history", res.data);
    const jobs = (res.data as Record<string, unknown>[]) || [];
    if (!jobs.length) return text("No deployments yet for this diagram.");
    return text(
      "## Deployment history\n\n" +
        jobs
          .map((j) => `- \`${j.id}\` — **${j.action}** ${j.status} · ${j.createdAt}`)
          .join("\n")
    );
  }
);

// ─── Terraform quality: fix, validate, cost ───────────────────────────────────

server.registerTool(
  "cloudforge_fix_terraform",
  {
    description:
      "Repair broken Terraform. Give it the HCL and the error output from plan/apply and it returns " +
      "corrected code. This is the right tool when a deployment fails — it is the same healer the " +
      "deployment pipeline uses on itself.",
    inputSchema: {
      terraform_code: z.string().describe("The HCL that failed."),
      error_log: z.string().describe("Error output from terraform validate/plan/apply."),
      is_modular: z.boolean().optional().describe("True if the code is split across modules."),
    },
  },
  async ({ terraform_code, error_log, is_modular }) => {
    const res = await apiFetch("/Cloudie/fix-terraform", {
      method: "POST",
      body: JSON.stringify({ terraformCode: terraform_code, errorLog: error_log, isModular: !!is_modular }),
    });
    if (!res.ok) return errText("Fix failed", res.data);
    const d = res.data as Record<string, unknown>;
    const fixed = (d.fixedCode || d.code || d.terraformCode) as string | undefined;
    if (!fixed) return errText("No corrected code returned", res.data);
    return text(`## Corrected Terraform\n\n\`\`\`hcl\n${fixed}\n\`\`\`` + (d.explanation ? `\n\n${d.explanation}` : ""));
  }
);

server.registerTool(
  "cloudforge_validate_terraform",
  {
    description: "Check HCL for syntax and provider-schema errors without deploying anything.",
    inputSchema: {
      terraform_code: z.string().describe("HCL to validate."),
      cloud_provider: z.enum(["azure", "aws", "gcp"]).optional().describe("Target cloud."),
    },
  },
  async ({ terraform_code, cloud_provider }) => {
    const res = await apiFetch("/Cloudie/validate-code", {
      method: "POST",
      body: JSON.stringify({ code: terraform_code, terraformCode: terraform_code, cloudProvider: cloud_provider }),
    });
    if (!res.ok) return errText("Validation failed", res.data);
    return text("```json\n" + JSON.stringify(res.data, null, 2).slice(0, 6000) + "\n```");
  }
);

server.registerTool(
  "cloudforge_estimate_cost",
  {
    description:
      "Estimated monthly cost for a set of resources, broken down per resource. " +
      "An estimate, not a quote — it does not know the user's committed-use or enterprise discounts.",
    inputSchema: {
      resources: z
        .array(z.record(z.string(), z.unknown()))
        .describe("Resource objects, each with at least type/terraformType and any sizing fields (sku, instance_type…)."),
      cloud_provider: z.enum(["azure", "aws", "gcp"]).optional(),
      region: z.string().optional().describe("Region, e.g. australiaeast or us-east-1."),
    },
  },
  async ({ resources, cloud_provider, region }) => {
    const res = await apiFetch("/Cloudie/cost-estimate", {
      method: "POST",
      body: JSON.stringify({ resources, cloudProvider: cloud_provider, region }),
    });
    if (!res.ok) return errText("Cost estimate failed", res.data);
    return text("```json\n" + JSON.stringify(res.data, null, 2).slice(0, 6000) + "\n```");
  }
);

server.registerTool(
  "cloudforge_review_architecture",
  {
    description:
      "AI architecture review of a diagram — reliability, security, cost and scaling trade-offs, " +
      "with specific findings rather than generic advice.",
    inputSchema: {
      diagram_id: z.string().optional().describe("Saved diagram to review."),
      diagram_json: z.record(z.string(), z.unknown()).optional().describe("Inline {nodes, edges} instead of a saved diagram."),
    },
  },
  async ({ diagram_id, diagram_json }) => {
    const res = await apiFetch("/Review/architecture", {
      method: "POST",
      body: JSON.stringify({ diagramId: diagram_id, diagram: diagram_json }),
    });
    if (!res.ok) return errText("Review failed", res.data);
    const d = res.data as Record<string, unknown>;
    return text(String(d.review || d.analysis || JSON.stringify(d, null, 2)).slice(0, 8000));
  }
);

// ─── Drift ────────────────────────────────────────────────────────────────────

server.registerTool(
  "cloudforge_scan_drift",
  {
    description:
      "Compare a diagram against what is actually deployed in the cloud and report the differences. " +
      "Needs a configured cloud connection. Use it to answer 'has anyone changed this by hand?'.",
    inputSchema: {
      diagram_id: z.string().describe("Diagram to compare against reality."),
      connection_id: z.string().optional().describe("Cloud connection to scan through."),
      cloud_provider: z.enum(["azure", "aws", "gcp"]).optional(),
    },
  },
  async ({ diagram_id, connection_id, cloud_provider }) => {
    const res = await apiFetch("/Drift/scan", {
      method: "POST",
      body: JSON.stringify({ diagramId: diagram_id, connectionId: connection_id, cloudProvider: cloud_provider }),
    });
    if (!res.ok) return errText("Drift scan failed", res.data);
    return text("## Drift scan started\n\n```json\n" + JSON.stringify(res.data, null, 2).slice(0, 4000) + "\n```");
  }
);

server.registerTool(
  "cloudforge_latest_drift",
  {
    description: "Most recent drift report for a diagram.",
    inputSchema: { diagram_id: z.string().describe("Diagram id.") },
  },
  async ({ diagram_id }) => {
    const res = await apiFetch(`/Drift/diagram/${diagram_id}/latest`);
    if (!res.ok) return errText("No drift report found", res.data);
    return text("```json\n" + JSON.stringify(res.data, null, 2).slice(0, 8000) + "\n```");
  }
);

// ─── Remediation: detect, approve, heal ───────────────────────────────────────
//
// Note what is NOT exposed here: approving a proposal. Approval is the whole
// point of the feature — a person reads what would change and consents to it —
// and a tool that let an agent grant that consent on their behalf would remove
// the guarantee the rest of the design exists to provide. Detect and report
// freely; the user approves in the editor or the web app; then heal.

server.registerTool(
  "cloudforge_drift_report",
  {
    description:
      "Read a drift report by id. Poll this after cloudforge_scan_drift until status is " +
      "'completed' or 'failed'.",
    inputSchema: { report_id: z.string().describe("Drift report id returned by the scan.") },
  },
  async ({ report_id }) => {
    const res = await apiFetch(`/Drift/report/${report_id}`);
    if (!res.ok) return errText("Could not read the drift report", res.data);
    return text("```json\n" + JSON.stringify(res.data, null, 2).slice(0, 8000) + "\n```");
  }
);

server.registerTool(
  "cloudforge_detect_remediations",
  {
    description:
      "Turn a completed drift report into proposed fixes, one per drifted resource. Nothing is " +
      "applied and nothing is approved — every proposal comes back awaiting a person's decision. " +
      "Idempotent per finding, so calling it twice is safe.",
    inputSchema: { report_id: z.string().describe("A completed drift report's id.") },
  },
  async ({ report_id }) => {
    const res = await apiFetch(`/remediation/reports/${report_id}/detect`, { method: "POST" });
    if (!res.ok) return errText("Detection failed", res.data);

    const d = res.data as { proposals?: unknown[]; awaitingApproval?: number };
    const n = d?.awaitingApproval ?? d?.proposals?.length ?? 0;
    return text(
      `## ${n} fix(es) proposed\n\n` +
        "All of them are awaiting approval. Show them to the user and let them decide — " +
        "approve in the CloudForge panel (VS Code), the Drift panel (web), or the JetBrains tool " +
        "window. Then call `cloudforge_heal_approved`.\n\n```json\n" +
        JSON.stringify(d?.proposals ?? d, null, 2).slice(0, 6000) +
        "\n```"
    );
  }
);

server.registerTool(
  "cloudforge_list_remediations",
  {
    description:
      "List remediation proposals and where each one stands: awaiting_approval, approved, " +
      "rejected, acknowledged, applying, applied, failed or expired.",
    inputSchema: {
      report_id: z.string().optional().describe("Limit to one drift report."),
      status: z.string().optional().describe("Limit to one status, e.g. awaiting_approval."),
    },
  },
  async ({ report_id, status }) => {
    const qs = new URLSearchParams();
    if (report_id) qs.set("driftReportId", report_id);
    if (status) qs.set("status", status);
    const suffix = qs.toString() ? `?${qs}` : "";
    const res = await apiFetch(`/remediation/proposals${suffix}`);
    if (!res.ok) return errText("Could not load proposals", res.data);
    return text("```json\n" + JSON.stringify(res.data, null, 2).slice(0, 8000) + "\n```");
  }
);

server.registerTool(
  "cloudforge_heal_approved",
  {
    description:
      "Apply the fixes a person has already approved for one drift report. Refuses if anything " +
      "in the batch is still undecided, if nothing is approved, or if a proposal was rejected — " +
      "healing converges the whole diagram, so it cannot skip one resource. It then pauses at the " +
      "Terraform plan: call cloudforge_approve_deployment with the job id once the user has agreed " +
      "to the plan. Never approve that plan without asking them.",
    inputSchema: {
      report_id: z.string().describe("Drift report whose approved fixes to apply."),
    },
  },
  async ({ report_id }) => {
    const r = await streamSse(`/remediation/reports/${report_id}/heal`, null);
    return text(renderStream("drift heal", r));
  }
);

server.registerTool(
  "cloudforge_remediation_ledger",
  {
    description:
      "The append-only audit trail: every detection, decision and action, with who did it and " +
      "when. This is the record an auditor asks for — what changed, why, and who said it could.",
    inputSchema: {
      proposal_id: z.string().optional().describe("Limit to one proposal's history."),
    },
  },
  async ({ proposal_id }) => {
    const suffix = proposal_id ? `?proposalId=${proposal_id}` : "";
    const res = await apiFetch(`/remediation/ledger${suffix}`);
    if (!res.ok) return errText("Could not read the ledger", res.data);
    return text("```json\n" + JSON.stringify(res.data, null, 2).slice(0, 8000) + "\n```");
  }
);

server.registerTool(
  "cloudforge_remediation_policy",
  {
    description:
      "The bounds healing works inside: which resource types are excluded from being proposed at " +
      "all, and how long a proposal stays actionable. There is no auto-approval setting by design.",
    inputSchema: {},
  },
  async () => {
    const res = await apiFetch("/remediation/policy");
    if (!res.ok) return errText("Could not read the remediation policy", res.data);
    return text("```json\n" + JSON.stringify(res.data, null, 2).slice(0, 4000) + "\n```");
  }
);

// ─── Compliance ───────────────────────────────────────────────────────────────

server.registerTool(
  "cloudforge_compliance_frameworks",
  {
    description: "Compliance frameworks available to scan against (APRA CPS 234, CIS, and others).",
    inputSchema: {},
  },
  async () => {
    const res = await apiFetch("/Compliance/frameworks");
    if (!res.ok) return errText("Could not load frameworks", res.data);
    return text("```json\n" + JSON.stringify(res.data, null, 2).slice(0, 4000) + "\n```");
  }
);

server.registerTool(
  "cloudforge_compliance_scan",
  {
    description:
      "Scan a diagram against one or more compliance frameworks. Returns evidence and control mappings — " +
      "deterministic rules, never an AI opinion, so the output is usable with an auditor.",
    inputSchema: {
      diagram_id: z.string().optional().describe("Saved diagram to scan."),
      diagram_json: z.record(z.string(), z.unknown()).optional().describe("Inline {nodes, edges} instead."),
      frameworks: z.array(z.string()).optional().describe("Framework ids from cloudforge_compliance_frameworks."),
    },
  },
  async ({ diagram_id, diagram_json, frameworks }) => {
    const res = await apiFetch("/Compliance/scan", {
      method: "POST",
      body: JSON.stringify({ diagramId: diagram_id, diagramJson: diagram_json ?? {}, frameworks }),
    });
    if (!res.ok) return errText("Compliance scan failed", res.data);
    return text("```json\n" + JSON.stringify(res.data, null, 2).slice(0, 8000) + "\n```");
  }
);

// ─── Policy ───────────────────────────────────────────────────────────────────

server.registerTool(
  "cloudforge_list_policies",
  { description: "Governance policies configured for this organisation.", inputSchema: {} },
  async () => {
    const res = await apiFetch("/Policy");
    if (!res.ok) return errText("Could not load policies", res.data);
    const list = (res.data as Record<string, unknown>[]) || [];
    if (!list.length) return text("No policies configured.");
    return text(
      "## Policies\n\n" +
        list.map((p) => `- **${p.name}** — ${p.enabled === false ? "disabled" : "enabled"}${p.description ? `\n  ${p.description}` : ""}`).join("\n")
    );
  }
);

server.registerTool(
  "cloudforge_evaluate_policies",
  {
    description:
      "Check a design against the organisation's policies before deploying it. Returns violations. " +
      "The deployment pipeline enforces the same rules, so clearing this first avoids a blocked apply.",
    inputSchema: {
      resources: z.array(z.record(z.string(), z.unknown())).describe("Diagram resources to evaluate."),
      connections: z.array(z.record(z.string(), z.unknown())).optional().describe("Connections between them."),
      provider: z.enum(["azure", "aws", "gcp"]).optional(),
    },
  },
  async ({ resources, connections, provider }) => {
    const res = await apiFetch("/Policy/evaluate", {
      method: "POST",
      body: JSON.stringify({ resources, connections, provider }),
    });
    if (!res.ok) return errText("Policy evaluation failed", res.data);
    const violations = (res.data as Record<string, unknown>[]) || [];
    if (!Array.isArray(violations) || !violations.length) return text("No policy violations.");
    return text(
      `## ${violations.length} policy violation(s)\n\n` +
        violations.map((v) => `- **${v.policyName ?? v.name}** — ${v.message ?? v.description}`).join("\n")
    );
  }
);

// ─── Terraform in and out ─────────────────────────────────────────────────────

server.registerTool(
  "cloudforge_parse_terraform",
  {
    description:
      "Turn raw HCL into a diagram structure without saving anything and without needing an account. " +
      "Deterministic — no AI. Use it to understand or visualise Terraform the user has locally.",
    inputSchema: { terraform_code: z.string().describe("HCL to parse. Capped at 256 KB.") },
  },
  async ({ terraform_code }) => {
    const res = await apiFetch("/terraform/parse-public", {
      method: "POST",
      body: JSON.stringify({ content: terraform_code }),
    });
    if (!res.ok) return errText("Parse failed", res.data);
    const d = res.data as Record<string, unknown>;
    const nodes = (d.nodes || []) as CFNode[];
    const edges = (d.edges || []) as CFEdge[];
    if (!nodes.length) return text("No resources found in that Terraform.");
    return text(
      `**${nodes.length} resources · ${edges.length} connections**\n\n` +
        "```mermaid\n" + toMermaid(nodes, edges, "Terraform") + "\n```"
    );
  }
);

server.registerTool(
  "cloudforge_export_terraform",
  {
    description: "Export a saved diagram's Terraform as it currently stands, without regenerating it.",
    inputSchema: { diagram_id: z.string().describe("Diagram id.") },
  },
  async ({ diagram_id }) => {
    const res = await apiFetch(`/terraform/export/${diagram_id}`, { method: "POST", body: "{}" });
    if (!res.ok) return errText("Export failed", res.data);
    const d = res.data as Record<string, unknown>;
    const code = (d.code || d.terraform || d.content) as string | undefined;
    return code ? text("```hcl\n" + code + "\n```") : text("```json\n" + JSON.stringify(d, null, 2).slice(0, 6000) + "\n```");
  }
);

// ─── Org board and templates ──────────────────────────────────────────────────

server.registerTool(
  "cloudforge_foundry_diagrams",
  {
    description: "Diagrams shared across the organisation — The Foundry. Distinct from the caller's own diagrams.",
    inputSchema: {},
  },
  async () => {
    const res = await apiFetch("/organization/board/diagrams");
    if (!res.ok) return errText("Could not load The Foundry", res.data);
    const list = (res.data as Record<string, unknown>[]) || [];
    if (!list.length) return text("No shared diagrams yet.");
    return text(
      "## The Foundry\n\n" +
        list.map((d) => `- **${d.name}** (\`${d.id}\`)${d.cloudProvider ? ` — ${d.cloudProvider}` : ""}`).join("\n")
    );
  }
);

server.registerTool(
  "cloudforge_list_templates",
  { description: "Organisation-authored diagram templates (distinct from the built-in Mold library).", inputSchema: {} },
  async () => {
    const res = await apiFetch("/Template");
    if (!res.ok) return errText("Could not load templates", res.data);
    const list = (res.data as Record<string, unknown>[]) || [];
    if (!list.length) return text("No templates yet. The built-in Molds are available via cloudforge_list_molds.");
    return text("## Templates\n\n" + list.map((t) => `- **${t.name}** (\`${t.id}\`)${t.description ? ` — ${t.description}` : ""}`).join("\n"));
  }
);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`CloudForge MCP server running — API: ${API_BASE}`);
