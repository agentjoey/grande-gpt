import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import type { Layout } from "./layout.ts";
import { createOAuth, OAuthError, type OAuthConfig } from "./oauth.ts";
import { registeredIds } from "./registry.ts";
import { reconcileRunningJobs } from "./jobs.ts";
import { buildTools, type ToolDef } from "./tools.ts";

export interface AppConfig {
  issuer: string;
  layout: Layout;
  db: DatabaseSync;
}

const VALID_REPO_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function toZodSchema(schema: ToolDef["inputSchema"]): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const p = prop as { type?: string; description?: string };
    let zodType: z.ZodTypeAny;
    switch (p.type) {
      case "string": zodType = z.string(); break;
      case "number": zodType = z.number(); break;
      case "array": zodType = z.array(z.any()); break;
      case "boolean": zodType = z.boolean(); break;
      default: zodType = z.any(); break;
    }
    if (p.description) zodType = zodType.describe(p.description);
    shape[key] = (schema.required ?? []).includes(key) ? zodType : zodType.optional();
  }
  return z.object(shape as z.ZodRawShape);
}

function unauthorized(repoId: string) {
  const encoded = encodeURIComponent(repoId);
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="/.well-known/oauth-protected-resource/mcp/${encoded}"`,
    },
  });
}

function oauthErrorStatus(e: OAuthError): number {
  switch (e.code) {
    case "invalid_request": return 400;
    case "invalid_client": return 401;
    case "invalid_grant": return 400;
    case "invalid_target": return 400;
    case "unsupported_grant_type": return 400;
    case "invalid_client_metadata": return 400;
    default: return 400;
  }
}

export function createApp(cfg: AppConfig): Hono {
  const { issuer, layout, db } = cfg;

  const oauthCfg: OAuthConfig = {
    issuer,
    endpointFor: (repoId) => `${issuer}/mcp/${repoId}`,
    isRegistered: (repoId) => registeredIds(layout).has(repoId),
    keyPath: join(layout.controlRoot, "secrets", "oauth-key"),
  };
  const oauth = createOAuth(oauthCfg);

  const app = new Hono();

  app.post("/register", async (c) => {
    try {
      const body = await c.req.json();
      const result = await oauth.register(body);
      return c.json(result);
    } catch (e) {
      if (e instanceof OAuthError) {
        return c.json({ error: e.code, error_description: e.message }, oauthErrorStatus(e) as 200 | 400 | 401);
      }
      throw e;
    }
  });

  app.get("/authorize", async (c) => {
    const q = c.req.query();
    try {
      const code = await oauth.authorize({
        client_id: q.client_id!,
        redirect_uri: q.redirect_uri!,
        code_challenge: q.code_challenge,
        code_challenge_method: q.code_challenge_method,
        resource: q.resource,
        scope: q.scope,
      });
      const redirect = new URL(q.redirect_uri!);
      redirect.searchParams.set("code", code);
      if (q.state) redirect.searchParams.set("state", q.state);
      return c.redirect(redirect.toString(), 302);
    } catch (e) {
      if (e instanceof OAuthError) {
        if (q.redirect_uri) {
          const redirect = new URL(q.redirect_uri);
          redirect.searchParams.set("error", e.code);
          redirect.searchParams.set("error_description", e.message);
          if (q.state) redirect.searchParams.set("state", q.state);
          return c.redirect(redirect.toString(), 302);
        }
        return c.json({ error: e.code, error_description: e.message }, oauthErrorStatus(e) as 200 | 400 | 401);
      }
      throw e;
    }
  });

  app.post("/token", async (c) => {
    try {
      const text = await c.req.text();
      const form = new URLSearchParams(text);
      const result = await oauth.token({
        grant_type: form.get("grant_type")!,
        code: form.get("code") ?? undefined,
        code_verifier: form.get("code_verifier") ?? undefined,
        client_id: form.get("client_id") ?? undefined,
        redirect_uri: form.get("redirect_uri") ?? undefined,
        resource: form.get("resource") ?? undefined,
        refresh_token: form.get("refresh_token") ?? undefined,
        scope: form.get("scope") ?? undefined,
      });
      return c.json(result);
    } catch (e) {
      if (e instanceof OAuthError) {
        return c.json({ error: e.code, error_description: e.message }, oauthErrorStatus(e) as 200 | 400 | 401);
      }
      throw e;
    }
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    return c.json(oauth.authServerMetadata());
  });

  app.get("/jwks", (c) => {
    return c.json({ keys: [] });
  });

  app.get("/.well-known/oauth-protected-resource/mcp/:repoId", (c) => {
    const repoId = c.req.param("repoId");
    const meta = oauth.protectedResourceMetadata(repoId);
    return c.json(meta);
  });

  app.all("/mcp/:repoId", async (c) => {
    const repoId = c.req.param("repoId");
    if (!VALID_REPO_ID.test(repoId)) return c.json({ error: "not_found" }, 404);

    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!bearer) return unauthorized(repoId);

    try {
      await oauth.verifyBearer(bearer, oauthCfg.endpointFor(repoId));
    } catch {
      return unauthorized(repoId);
    }

    if (!registeredIds(layout).has(repoId)) return c.json({ error: "not_found" }, 404);

    const transport = new WebStandardStreamableHTTPServerTransport();
    const mcpServer = new McpServer(
      { name: `grande-gpt/${repoId}`, version: "0.0.0" },
      { capabilities: { tools: {} } },
    );

    const tools = buildTools({ db, layout, repoId });
    for (const tool of tools) {
      mcpServer.registerTool(tool.name, {
        description: tool.description,
        inputSchema: toZodSchema(tool.inputSchema),
        annotations: tool.annotations as any,
      }, async (args) => {
        const result = await tool.handler(args as Record<string, unknown>);
        const sc = result.structuredContent as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(sc) }],
          structuredContent: sc,
        };
      });
    }

    await mcpServer.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    return response;
  });

  return app;
}

export async function startGateway(cfg: AppConfig): Promise<{ app: Hono; close: () => Promise<void> }> {
  reconcileRunningJobs(cfg.db, (pgid) => {
    try { process.kill(-pgid, 0); return true; } catch { return false; }
  });

  const app = createApp(cfg);
  const port = Number(process.env.PORT || "8787");
  const srv = serve({ fetch: app.fetch, port });

  return {
    app,
    close: () => new Promise<void>((resolve, reject) => {
      srv.close((err) => err ? reject(err) : resolve());
    }),
  };
}
