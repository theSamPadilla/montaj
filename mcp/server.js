#!/usr/bin/env node
/**
 * montaj MCP server — exposes all native steps as MCP tools.
 * Scans step scopes on start; each .json schema becomes one tool.
 * Communicates over stdin/stdout (no port, no HTTP).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MONTAJ_ROOT = resolve(__dirname, "..");
const PYTHON = process.env.MONTAJ_PYTHON || "python3";

// MCP clients (Claude Desktop, Cursor) spawn the server from their own cwd,
// not the user's project directory. MONTAJ_PROJECT_DIR must be set by the
// montaj mcp launcher to preserve the cwd at invocation time.
const PROJECT_DIR = process.env.MONTAJ_PROJECT_DIR || process.cwd();

const STEP_TIMEOUT_MS = 300_000; // 5 minutes — guards against hung transcription jobs

// Scan all three scopes in priority order: built-in → user-global → project-local.
// Each scope's Map.set() overwrites the previous entry, so the last scope written
// (project-local) takes precedence. DO NOT reverse this order.
function scanSteps() {
  const scopes = [
    join(MONTAJ_ROOT, "steps"),
    join(homedir(), ".montaj", "steps"),
    join(PROJECT_DIR, "steps"),
  ];

  const steps = new Map(); // name → { schema, pyPath }

  for (const dir of scopes) {
    if (!existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".json"));
    } catch {
      continue;
    }

    for (const file of files) {
      let schema;
      try {
        schema = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch (err) {
        process.stderr.write(`[montaj-mcp] skipping malformed schema ${join(dir, file)}: ${err.message}\n`);
        continue;
      }

      if (!schema.name) continue;

      const pyPath = join(dir, schema.name + ".py");
      if (!existsSync(pyPath)) continue;

      steps.set(schema.name, { schema, pyPath });
    }
  }

  return steps;
}

// Scan adaptor scopes: built-in → user-global → project-local.
// Returns Map: name → { schema, jsPath }
function scanAdaptors() {
  const scopes = [
    join(MONTAJ_ROOT, "adaptors"),
    join(homedir(), ".montaj", "adaptors"),
    join(PROJECT_DIR, "adaptors"),
  ];

  const adaptors = new Map();

  for (const dir of scopes) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      continue;
    }

    for (const name of entries) {
      const schemaPath = join(dir, name, "schema.json");
      const jsPath     = join(dir, name, "adaptor.js");
      if (!existsSync(schemaPath) || !existsSync(jsPath)) continue;

      let schema;
      try {
        schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      } catch (err) {
        process.stderr.write(`[montaj-mcp] skipping malformed adaptor schema ${schemaPath}: ${err.message}\n`);
        continue;
      }

      adaptors.set(name, { schema, jsPath });
    }
  }

  return adaptors;
}

// Build MCP inputSchema for an adaptor. All adaptors share a required `description`
// string plus any adaptor-specific options declared in schema.input.
function buildAdaptorInputSchema(schema) {
  const properties = {
    description: { type: "string", description: "What to generate (plain text description)" },
    out: { type: "string", description: "Output file path" },
  };

  for (const [key, opt] of Object.entries(schema.input || {})) {
    if (key === "description") continue;
    const prop = { description: key };
    prop.type = opt.type || "string";
    if (opt.options)  prop.enum    = opt.options;
    if (opt.default !== undefined) prop.default = opt.default;
    properties[key] = prop;
  }

  return { type: "object", properties, required: ["description"] };
}

// Convert a step schema to an MCP-compatible JSON Schema inputSchema.
function buildInputSchema(schema) {
  const properties = {};
  const required = [];

  if (schema.input) {
    if (schema.input.multiple) {
      properties.inputs = {
        type: "array",
        items: { type: "string" },
        description: schema.input.description || "Input files",
      };
      required.push("inputs");
    } else {
      properties.input = {
        type: "string",
        description: schema.input.description || "Input file",
      };
      required.push("input");
    }
  }

  for (const param of (schema.params || [])) {
    const prop = { description: param.description || param.name };

    switch (param.type) {
      case "float":   prop.type = "number";  break;
      case "int":     prop.type = "integer"; break;
      case "bool":    prop.type = "boolean"; break;
      case "enum":
        prop.type = "string";
        if (param.options) prop.enum = param.options;
        break;
      default:        prop.type = "string";
    }

    if (param.default !== undefined) prop.default = param.default;
    if (param.min     !== undefined) prop.minimum  = param.min;
    if (param.max     !== undefined) prop.maximum  = param.max;

    properties[param.name] = prop;
    if (param.required) required.push(param.name);
  }

  const outputDesc = schema.output
    ? `Output file path. Returns: ${schema.output.type}${schema.output.description ? " — " + schema.output.description : ""}`
    : "Output file path";
  properties.out = { type: "string", description: outputDesc };

  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
}

// Map MCP call arguments to CLI flag array.
function buildCliArgs(schema, args) {
  const flags = [];

  if (schema.input?.multiple) {
    flags.push("--inputs", ...args.inputs);
  } else if (args.input !== undefined) {
    flags.push("--input", String(args.input));
  }

  for (const param of (schema.params || [])) {
    const val = args[param.name];
    if (val === undefined || val === null) continue;
    if (param.type === "bool") {
      if (val) flags.push("--" + param.name);
    } else {
      flags.push("--" + param.name, String(val));
    }
  }

  if (args.out) flags.push("--out", String(args.out));

  return flags;
}

// Wrap a step's stdout in a JSON envelope so MCP callers always receive
// structured output. Steps that already return JSON are passed through unchanged.
function wrapOutput(stdout, schema) {
  const text = stdout.trim();
  if (text.startsWith("{") || text.startsWith("[")) return text;
  return JSON.stringify({ path: text, type: schema.output?.type || "file" });
}

async function main() {
  const steps    = scanSteps();
  const adaptors = scanAdaptors();

  const server = new Server(
    { name: "montaj", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // ---------------------------------------------------------------------------
  // Profile resources — montaj://profile/<name>
  // ---------------------------------------------------------------------------

  function scanProfiles() {
    const profilesDir = join(homedir(), ".montaj", "profiles");
    if (!existsSync(profilesDir)) return [];
    try {
      return readdirSync(profilesDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && existsSync(join(profilesDir, e.name, "analysis_current.json")))
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: scanProfiles().map(name => ({
      uri:         `montaj://profile/${name}`,
      name:        `Profile: ${name}`,
      description: `Creator style profile for ${name} — pacing, color palette, editorial direction`,
      mimeType:    "text/markdown",
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (!uri.startsWith("montaj://profile/")) {
      return { contents: [{ uri, mimeType: "text/plain", text: `Unknown resource: ${uri}` }] };
    }
    const name = uri.slice("montaj://profile/".length);
    const stylePath = join(homedir(), ".montaj", "profiles", name, "style_profile.md");
    if (!existsSync(stylePath)) {
      return { contents: [{ uri, mimeType: "text/plain", text: `Profile '${name}' not found. Run the style-profile skill to create it.` }] };
    }
    const text = readFileSync(stylePath, "utf8");
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...Array.from(steps.values()).map(({ schema }) => ({
        name: schema.name,
        description: schema.description,
        inputSchema: buildInputSchema(schema),
      })),
      ...Array.from(adaptors.entries()).map(([name, { schema }]) => ({
        name: `adaptor_${name}`,
        description: schema.description,
        inputSchema: buildAdaptorInputSchema(schema),
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Adaptor dispatch
    if (name.startsWith("adaptor_")) {
      const adaptorName = name.slice(8);
      const adaptor = adaptors.get(adaptorName);
      if (!adaptor) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool", message: `No adaptor found: ${adaptorName}` }) }],
          isError: true,
        };
      }
      const { description = "", out, ...rest } = args || {};
      const cliArgs = [description];
      if (out) cliArgs.push("--out", String(out));
      // Pass through any extra adaptor-specific flags
      for (const [k, v] of Object.entries(rest)) {
        cliArgs.push("--" + k, String(v));
      }
      const result = spawnSync("node", [adaptor.jsPath, ...cliArgs], {
        encoding: "utf8",
        timeout: STEP_TIMEOUT_MS,
        env: { ...process.env, MONTAJ_ROOT, MONTAJ_PROJECT_DIR: PROJECT_DIR },
      });
      if (result.error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "spawn_error", message: result.error.message }) }], isError: true };
      }
      if (result.signal === "SIGTERM") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "timeout", message: `Adaptor '${adaptorName}' exceeded timeout` }) }], isError: true };
      }
      if (result.status !== 0) {
        return { content: [{ type: "text", text: result.stderr?.trim() || `Adaptor '${adaptorName}' failed` }], isError: true };
      }
      return { content: [{ type: "text", text: result.stdout.trim() }] };
    }

    // Step dispatch
    const step = steps.get(name);

    if (!step) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool", message: `No step found: ${name}` }) }],
        isError: true,
      };
    }

    const cliArgs = buildCliArgs(step.schema, args || {});
    const result = spawnSync(PYTHON, [step.pyPath, ...cliArgs], {
      encoding: "utf8",
      timeout: STEP_TIMEOUT_MS,
    });

    if (result.error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "spawn_error", message: result.error.message }) }],
        isError: true,
      };
    }

    if (result.signal === "SIGTERM") {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "timeout", message: `Step '${name}' exceeded ${STEP_TIMEOUT_MS / 1000}s timeout` }) }],
        isError: true,
      };
    }

    if (result.status !== 0) {
      const errText = result.stderr?.trim() || `Step '${name}' exited with code ${result.status}`;
      return {
        content: [{ type: "text", text: errText }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: wrapOutput(result.stdout || "", step.schema) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(JSON.stringify({ error: "server_error", message: err.message }) + "\n");
  process.exit(1);
});
