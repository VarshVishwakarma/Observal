/**
 * MCP config JSON parser — shared between submit dialog and edit form.
 * Mirrors the CLI's _parse_direct_config logic.
 */

export interface ParsedMcpConfig {
  serverName?: string;
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: string;
  framework?: string;
  dockerImage?: string;
  envVars: EnvVar[];
  headers?: { name: string; value: string }[];
  autoApprove?: string[];
}

export interface EnvVar {
  name: string;
  description: string;
  required: boolean;
}

export function parseMcpConfigJson(raw: string): { parsed?: ParsedMcpConfig; error?: string } {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return { error: "Invalid JSON" };
  }

  // Registry format: {server: {remotes: [...]}, _meta: {...}}
  let manifest = cfg;
  const serverMeta = cfg.server;
  if (serverMeta && typeof serverMeta === "object" && !Array.isArray(serverMeta)) {
    const sm = serverMeta as Record<string, unknown>;
    if (sm.remotes || sm.packages) {
      manifest = sm;
    }
  }

  // server.json manifest format (packages[]/remotes[])
  if (manifest.packages || manifest.remotes) {
    const result = parseServerJsonManifest(manifest);
    // Extract name/description from registry metadata
    if (serverMeta && typeof serverMeta === "object") {
      const sm = serverMeta as Record<string, string>;
      const regName = sm.title || sm.name;
      if (regName) result.serverName = regName;
      const regDesc = sm.description;
      if (regDesc) result.description = regDesc;
    }
    return { parsed: result };
  }

  // Unwrap IDE config formats
  const { inner, serverName } = unwrapMcpConfig(cfg);
  const result: ParsedMcpConfig = { envVars: [] };
  if (serverName) result.serverName = serverName;

  const i = inner as Record<string, unknown>;

  if (i.url && !i.command) {
    // SSE / streamable-http
    result.transport = (i.type as string) || "sse";
    result.url = i.url as string;
    const rawEnv = (i.env || {}) as Record<string, string>;
    result.envVars = Object.keys(rawEnv).map((k) => ({ name: k, description: "", required: true }));
    if (i.headers && typeof i.headers === "object") {
      result.headers = Object.entries(i.headers as Record<string, string>).map(([k, v]) => ({ name: k, value: v }));
    }
    if (Array.isArray(i.autoApprove)) result.autoApprove = i.autoApprove as string[];
  } else if (i.command) {
    // stdio
    result.transport = "stdio";
    result.command = i.command as string;
    result.args = Array.isArray(i.args) ? (i.args as string[]) : [];
    const rawEnv = (i.env || {}) as Record<string, string>;
    result.envVars = Object.keys(rawEnv).map((k) => ({ name: k, description: "", required: true }));
    // Derive framework
    if (result.command === "docker") {
      result.framework = "docker";
      const lastNonFlag = [...result.args].reverse().find((a) => !a.startsWith("-"));
      if (lastNonFlag) result.dockerImage = lastNonFlag;
    } else if (result.command === "python" || result.command === "python3") {
      result.framework = "python";
    } else if (result.command === "npx" || result.command === "node") {
      result.framework = "typescript";
    }
    if (Array.isArray(i.autoApprove)) result.autoApprove = i.autoApprove as string[];
  } else {
    return { error: "Could not detect command or url in config" };
  }

  return { parsed: result };
}

export function parseServerJsonManifest(cfg: Record<string, unknown>): ParsedMcpConfig {
  const result: ParsedMcpConfig = { envVars: [] };
  const packages = Array.isArray(cfg.packages) ? cfg.packages : [];
  const remotes = Array.isArray(cfg.remotes) ? cfg.remotes : [];

  for (const pkg of packages) {
    for (const arg of ((pkg as Record<string, unknown[]>).runtimeArguments || [])) {
      const value = (arg as Record<string, string>).value || "";
      if (value.includes("=")) {
        const varName = value.split("=", 1)[0];
        if (varName && varName === varName.toUpperCase()) {
          result.envVars.push({ name: varName, description: (arg as Record<string, string>).description || "", required: true });
        }
      }
    }
  }

  for (const remote of remotes) {
    const r = remote as Record<string, unknown>;
    if (r.url && !result.url) {
      result.url = r.url as string;
      result.transport = (r.type as string) || "sse";
    }
    for (const [key, meta] of Object.entries((r.variables || {}) as Record<string, unknown>)) {
      const desc = meta && typeof meta === "object" ? ((meta as Record<string, string>).description || "") : "";
      result.envVars.push({ name: key, description: desc, required: true });
    }
  }

  if (!result.url) {
    result.transport = "stdio";
    result.framework = "docker";
  }

  return result;
}

export function unwrapMcpConfig(cfg: Record<string, unknown>): { inner: Record<string, unknown>; serverName?: string } {
  // Shape 1: {mcpServers: {name: config}}
  if (cfg.mcpServers && typeof cfg.mcpServers === "object") {
    const servers = cfg.mcpServers as Record<string, unknown>;
    const keys = Object.keys(servers);
    if (keys.length === 1 && typeof servers[keys[0]] === "object") {
      return { inner: servers[keys[0]] as Record<string, unknown>, serverName: keys[0] };
    }
    return { inner: cfg };
  }
  // Shape 3: bare config
  if (cfg.command || cfg.url || cfg.type) return { inner: cfg };
  // Shape 2: single named key
  const keys = Object.keys(cfg);
  if (keys.length === 1 && typeof cfg[keys[0]] === "object") {
    const inner = cfg[keys[0]] as Record<string, unknown>;
    if (inner.command || inner.url || inner.type) return { inner, serverName: keys[0] };
  }
  return { inner: cfg };
}
