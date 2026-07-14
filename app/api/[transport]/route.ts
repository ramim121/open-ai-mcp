import { createMcpHandler } from "mcp-handler";
import { put } from "@vercel/blob";
import { z } from "zod";

/**
 * Remote MCP server for image generation.
 *
 * Exposed by Vercel at:
 *   POST /api/mcp   (Streamable HTTP — this is the URL you give claude.ai)
 *   GET  /api/sse   (legacy SSE, also handled)
 *
 * Auth: every request must carry the shared secret, either as
 *   ?k=<MCP_SECRET>   query param   (this is what the connector URL uses)
 *   Authorization: Bearer <MCP_SECRET>   header
 * Missing/wrong secret -> 401. This keeps strangers from spending your OpenAI credits.
 *
 * Required env vars (set in Vercel project settings):
 *   OPENAI_API_KEY          your OpenAI key
 *   MCP_SECRET              a long random string you invent
 *   BLOB_READ_WRITE_TOKEN   auto-added when you enable Vercel Blob on the project
 * Optional:
 *   OPENAI_IMAGE_MODEL      default "gpt-image-1.5"
 */

const API_BASE = "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1.5";

// Image generation can take a while; give the function room (seconds).
export const maxDuration = 300;

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
};

/** Pull base64 payloads out of an OpenAI images response (also handles url-style responses). */
async function extractImages(json: OpenAIImageResponse): Promise<string[]> {
  const out: string[] = [];
  for (const item of json.data ?? []) {
    if (item.b64_json) out.push(item.b64_json);
    else if (item.url) {
      const buf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
      out.push(buf.toString("base64"));
    }
  }
  if (!out.length) throw new Error("OpenAI returned no image data.");
  return out;
}

/** Upload each base64 image to Vercel Blob and return public URLs. */
async function hostImages(b64List: string[], prompt: string): Promise<string[]> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug =
    prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
  const urls: string[] = [];
  for (let i = 0; i < b64List.length; i++) {
    const name = `images/${stamp}-${slug}${b64List.length > 1 ? `-${i + 1}` : ""}.png`;
    const { url } = await put(name, Buffer.from(b64List[i], "base64"), {
      access: "public",
      contentType: "image/png",
      // BLOB_READ_WRITE_TOKEN is read from env automatically.
    });
    urls.push(url);
  }
  return urls;
}

function ok(urls: string[], b64List: string[]) {
  const text =
    urls.length === 1
      ? `Image generated. Public URL (use this in <img src> / markdown):\n${urls[0]}`
      : `Images generated. Public URLs:\n${urls.join("\n")}`;
  return {
    content: [
      { type: "text" as const, text },
      // First image inline so the model can also see what it made.
      { type: "image" as const, data: b64List[0], mimeType: "image/png" },
    ],
  };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Image request failed: ${message}` }],
    isError: true,
  };
}

const handler = createMcpHandler((server) => {
  server.tool(
    "generate_image",
    "Generate an image from a text prompt using OpenAI, host it, and return a PUBLIC URL you can embed " +
      "directly in HTML pages, slides, or markdown. Write a detailed prompt — subject, style, lighting, composition.",
    {
      prompt: z.string().describe("Detailed description of the image to generate."),
      size: z
        .enum(["1024x1024", "1024x1536", "1536x1024", "auto"])
        .optional()
        .describe("Square, portrait, or landscape."),
      quality: z
        .enum(["low", "medium", "high", "auto"])
        .optional()
        .describe("Higher quality costs more. Use low for drafts."),
      n: z.number().int().min(1).max(4).optional().describe("How many variations (default 1)."),
    },
    async ({ prompt, size, quality, n }) => {
      try {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error("OPENAI_API_KEY not set on the server.");
        const body: Record<string, unknown> = { model: MODEL, prompt, n: n ?? 1 };
        if (size) body.size = size;
        if (quality) body.quality = quality;

        const res = await fetch(`${API_BASE}/images/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as OpenAIImageResponse;
        if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);

        const images = await extractImages(json);
        return ok(await hostImages(images, prompt), images);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "edit_image",
    "Edit or extend an existing image (given by its public URL) using a text instruction, host the result, " +
      "and return a new PUBLIC URL. Optionally supply a mask URL (transparent pixels mark the region to change).",
    {
      image_url: z.string().url().describe("Public URL of the source image to edit."),
      prompt: z.string().describe("What to change."),
      mask_url: z.string().url().optional().describe("Public URL of an optional PNG mask."),
      size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).optional(),
      quality: z.enum(["low", "medium", "high", "auto"]).optional(),
    },
    async ({ image_url, prompt, mask_url, size, quality }) => {
      try {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error("OPENAI_API_KEY not set on the server.");

        const imgBuf = Buffer.from(await (await fetch(image_url)).arrayBuffer());
        const form = new FormData();
        form.append("model", MODEL);
        form.append("prompt", prompt);
        form.append("image", new Blob([imgBuf], { type: "image/png" }), "image.png");
        if (mask_url) {
          const maskBuf = Buffer.from(await (await fetch(mask_url)).arrayBuffer());
          form.append("mask", new Blob([maskBuf], { type: "image/png" }), "mask.png");
        }
        if (size) form.append("size", size);
        if (quality) form.append("quality", quality);

        const res = await fetch(`${API_BASE}/images/edits`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        });
        const json = (await res.json()) as OpenAIImageResponse;
        if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);

        const images = await extractImages(json);
        return ok(await hostImages(images, prompt), images);
      } catch (err) {
        return fail(err);
      }
    },
  );
}, {}, {
  // The route lives at app/api/[transport]/route.ts, so it is mounted under /api.
  // mcp-handler needs to know this prefix to map /api/mcp and /api/sse correctly.
  basePath: "/api",
  maxDuration: 300,
});

/** Shared-secret gate. Accepts ?k=<secret> or Authorization: Bearer <secret>. */
function authorized(req: Request): boolean {
  const secret = process.env.MCP_SECRET;
  if (!secret) return false; // fail closed if the server is misconfigured
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("k");
  const fromHeader = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return fromQuery === secret || fromHeader === secret;
}

async function guarded(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="openai-image-mcp"' },
    });
  }
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
