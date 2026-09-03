import { createHash } from "node:crypto";
import { del, put } from "@vercel/blob";
import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { withBrowserbaseVaultScreenshotMask } from "@/agent/subagents/worker/lib/vault-screenshot-mask";
import {
  finalizeBrowserImageArtifact,
  reserveBrowserImageArtifact,
  type BrowserImageArtifactReservation,
} from "@/db/services/browser-images";
import {
  browserImageArtifactReferenceSchema,
  maximumBrowserImageBytes,
  sniffBrowserImageMediaType,
} from "@/lib/browser-artifact";
import { env } from "@/env";
import { withBrowserbasePage } from "@/lib/browserbase-playwright";

const regionSchema = z.object({
  height: z.number().int().positive(),
  width: z.number().int().positive(),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});
const commonFields = {
  label: z.string().trim().min(1).max(200),
  session_id: z.string().min(1),
};
const inputSchema = z.discriminatedUnion("source", [
  z.object({
    ...commonFields,
    region: regionSchema.optional(),
    source: z.literal("viewport"),
  }),
  z.object({
    ...commonFields,
    source: z.literal("full_page"),
  }),
  z.object({
    ...commonFields,
    selector: z.string().trim().min(1).max(2_000),
    source: z.literal("element"),
  }),
  z.object({
    ...commonFields,
    selector: z.string().trim().min(1).max(2_000),
    source: z.literal("image_resource"),
  }),
]);
const outputSchema = z.object({ image: browserImageArtifactReferenceSchema });

type CaptureInput = z.infer<typeof inputSchema>;

export default defineTool({
  description:
    "Capture one durable, user-visible image from an owned browser. Use only when the assignment requests an image or one image materially improves the final result; never persist routine debugging screenshots. Supports viewport or region screenshots, full-page screenshots, rendered element screenshots, and original image resources selected from the current page. Original resource capture falls back to the rendered element when needed. Does not expose private Blob URLs or page credentials.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);
    const parent = context.session.parent;
    if (!parent)
      throw new Error("Browser image capture requires a delegated worker.");

    const reserved = await reserveBrowserImageArtifact(scope, {
      browserSessionId: input.session_id,
      idempotencyKey: `browser-image:${context.session.id}:${context.callId}`,
      label: input.label,
      rootSessionId: parent.rootSessionId,
      sourceKind: input.source,
      workerSessionId: context.session.id,
    });
    if (reserved.status === "ready") return { image: reserved.image };

    const captured = await captureBrowserImage(input, context.abortSignal);
    const mediaType = sniffBrowserImageMediaType(captured.bytes);
    if (!mediaType) {
      throw new Error(
        "The captured resource is not a supported browser image."
      );
    }
    const image = await persistCapturedImage(
      scope,
      reserved.reservation,
      {
        bytes: captured.bytes,
        filename: safeBrowserImageFilename(input.label, mediaType),
        sourceKind: captured.sourceKind,
      },
      context.abortSignal
    );
    return outputSchema.parse({ image });
  },
  toModelOutput(output) {
    return toolOutput.json({ image: output.image });
  },
});

async function captureBrowserImage(
  input: CaptureInput,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; sourceKind: CaptureInput["source"] }> {
  return withBrowserbasePage(
    input.session_id,
    signal,
    async ({ context, page }) => {
      switch (input.source) {
        case "viewport": {
          const bytes = await withBrowserbaseVaultScreenshotMask(page, () =>
            page.screenshot({
              animations: "disabled",
              caret: "hide",
              clip: input.region,
              type: "png",
            })
          );
          return { bytes, sourceKind: input.source };
        }
        case "full_page": {
          const bytes = await withBrowserbaseVaultScreenshotMask(page, () =>
            page.screenshot({
              animations: "disabled",
              caret: "hide",
              fullPage: true,
              type: "png",
            })
          );
          return { bytes, sourceKind: input.source };
        }
        case "element": {
          const bytes = await withBrowserbaseVaultScreenshotMask(
            page,
            async () => {
              const target = page.locator(input.selector).first();
              await target.waitFor({ state: "visible", timeout: 5_000 });
              return target.screenshot({
                animations: "disabled",
                caret: "hide",
                type: "png",
              });
            }
          );
          return { bytes, sourceKind: input.source };
        }
        case "image_resource": {
          const target = page.locator(input.selector).first();
          try {
            await target.waitFor({ state: "visible", timeout: 5_000 });
            const resolved = await target.evaluate((element) => {
              if (!(element instanceof HTMLImageElement)) {
                throw new Error("The selected element is not an image.");
              }
              return element.currentSrc || element.src;
            });
            const url = new URL(resolved);
            if (url.protocol !== "https:" && url.protocol !== "http:") {
              throw new Error("The selected image does not use an HTTP URL.");
            }
            const response = await context.request.get(url.href, {
              headers: {
                accept: "image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1",
              },
              timeout: 20_000,
            });
            if (!response.ok()) {
              throw new Error(
                `The selected image resource returned HTTP ${String(response.status())}.`
              );
            }
            const bytes = await response.body();
            if (bytes.byteLength > maximumBrowserImageBytes) {
              throw new Error("The browser image exceeds the maximum size.");
            }
            if (!sniffBrowserImageMediaType(bytes)) {
              throw new Error(
                "The selected resource is not a supported image."
              );
            }
            return { bytes, sourceKind: input.source };
          } catch (error) {
            if (signal?.aborted) throw error;
            const bytes = await withBrowserbaseVaultScreenshotMask(page, () =>
              target.screenshot({
                animations: "disabled",
                caret: "hide",
                type: "png",
              })
            );
            return { bytes, sourceKind: "element" };
          }
        }
      }
      throw new Error("Unsupported browser image source.");
    }
  );
}

function safeBrowserImageFilename(
  label: string,
  mediaType: NonNullable<ReturnType<typeof sniffBrowserImageMediaType>>
) {
  const extension = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  }[mediaType];
  const stem = label
    .normalize("NFKD")
    .replace(/(?:\.\.[/\\])+/gu, "")
    .replace(/\p{Cc}+/gu, "")
    .replace(/[^\p{L}\p{N}._() -]+/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+|\.+$/gu, "")
    .slice(0, 160);
  return `${stem || "browser-image"}.${extension}`;
}

async function persistCapturedImage(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  reservation: BrowserImageArtifactReservation,
  input: {
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly sourceKind: string;
  },
  signal?: AbortSignal
) {
  const mediaType = sniffBrowserImageMediaType(input.bytes);
  if (!mediaType)
    throw new Error("The captured resource is not a supported browser image.");
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const storagePathname = `${reservation.storagePathname}/${contentHash}`;
  if (!env.BLOB_STORE_ID && !env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Browser image storage is not configured.");
  }

  await put(storagePathname, Buffer.from(input.bytes), {
    access: "private",
    abortSignal: signal,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 30 * 24 * 60 * 60,
    contentType: mediaType,
    maximumSizeInBytes: maximumBrowserImageBytes,
  });
  try {
    const finalized = await finalizeBrowserImageArtifact(scope, reservation, {
      byteSize: input.bytes.byteLength,
      contentHash,
      filename: input.filename,
      mediaType,
      sourceKind: input.sourceKind,
      storagePathname,
    });
    if (finalized.storagePathname !== storagePathname) {
      await del(storagePathname).catch(() => undefined);
    }
    return finalized.image;
  } catch (error) {
    await del(storagePathname).catch(() => undefined);
    throw error;
  }
}
