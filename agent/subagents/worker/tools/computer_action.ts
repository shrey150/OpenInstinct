import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import type { Page } from "playwright-core";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { withVaultScreenshotMask } from "@/agent/subagents/worker/lib/vault-screenshot-mask";
import { withBrowserbasePage } from "@/lib/browserbase-playwright";

/* eslint-disable no-await-in-loop -- Browser input and modifier-key transitions must execute in order. */

const mousePositions = new Map<string, { x: number; y: number }>();

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click_mouse"),
    click_mouse: z.object({
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "right", "middle"]).optional(),
      click_type: z.enum(["down", "up", "click"]).optional(),
      num_clicks: z.number().int().min(1).optional(),
      hold_keys: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    type: z.literal("move_mouse"),
    move_mouse: z.object({
      x: z.number(),
      y: z.number(),
      hold_keys: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    type: z.literal("type_text"),
    type_text: z.object({
      text: z.string(),
      delay: z.number().int().min(0).max(250).optional(),
    }),
  }),
  z.object({
    type: z.literal("press_key"),
    press_key: z.object({
      keys: z.array(z.string()),
      duration: z.number().int().min(0).max(2_000).optional(),
      hold_keys: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    type: z.literal("scroll"),
    scroll: z.object({
      x: z.number(),
      y: z.number(),
      delta_x: z.number().optional(),
      delta_y: z.number().optional(),
      hold_keys: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    type: z.literal("drag_mouse"),
    drag_mouse: z.object({
      path: z.array(z.array(z.number()).length(2)).min(2),
      button: z.enum(["left", "middle", "right"]).optional(),
      delay: z.number().int().min(0).max(2_000).optional(),
      steps_per_segment: z.number().int().min(1).optional(),
      step_delay_ms: z.number().int().min(0).max(250).optional(),
      hold_keys: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    type: z.literal("set_cursor"),
    set_cursor: z.object({ hidden: z.boolean() }),
  }),
  z.object({
    type: z.literal("sleep"),
    sleep: z.object({ duration_ms: z.number().int().min(0).max(2_000) }),
  }),
  z.object({
    type: z.literal("write_clipboard"),
    write_clipboard: z.object({ text: z.string() }),
  }),
  z.object({ type: z.literal("read_clipboard") }),
  z.object({
    type: z.literal("screenshot"),
    screenshot: z
      .object({
        region: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number().int().min(1),
            height: z.number().int().min(1),
          })
          .optional(),
      })
      .optional(),
  }),
  z.object({ type: z.literal("get_mouse_position") }),
]);

const inputSchema = z.object({
  session_id: z.string().min(1),
  actions: z.array(actionSchema).min(1).max(20),
});

const outputSchema = z.object({
  data: z.unknown().optional(),
  message: z.string(),
  mimeType: z.literal("image/png").optional(),
  screenshotBase64: z.string().optional(),
});

export default defineTool({
  description:
    "Execute a bounded sequence of coordinate-level actions on one Browserbase session. Prefer semantic and Playwright tools; use this only for visual controls. Include a screenshot last only when visual inspection is needed.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);

    return withBrowserbasePage(
      input.session_id,
      context.abortSignal,
      async ({ context: browserContext, page }) => {
        const data: unknown[] = [];
        let screenshotBase64: string | undefined;
        for (const action of input.actions) {
          switch (action.type) {
            case "click_mouse": {
              const value = requiredAction(action.click_mouse, action.type);
              await withHeldKeys(page, value.hold_keys, async () => {
                await page.mouse.move(value.x, value.y);
                mousePositions.set(input.session_id, {
                  x: value.x,
                  y: value.y,
                });
                const button = value.button ?? "left";
                if (value.click_type === "down") {
                  await page.mouse.down({ button });
                } else if (value.click_type === "up") {
                  await page.mouse.up({ button });
                } else {
                  await page.mouse.click(value.x, value.y, {
                    button,
                    clickCount: value.num_clicks ?? 1,
                  });
                }
              });
              break;
            }
            case "move_mouse": {
              const value = requiredAction(action.move_mouse, action.type);
              await withHeldKeys(page, value.hold_keys, async () => {
                await page.mouse.move(value.x, value.y);
              });
              mousePositions.set(input.session_id, { x: value.x, y: value.y });
              break;
            }
            case "type_text": {
              const value = requiredAction(action.type_text, action.type);
              await page.keyboard.type(value.text, { delay: value.delay });
              break;
            }
            case "press_key": {
              const value = requiredAction(action.press_key, action.type);
              await withHeldKeys(page, value.hold_keys, async () => {
                await page.keyboard.press(value.keys.join("+"), {
                  delay: value.duration,
                });
              });
              break;
            }
            case "scroll": {
              const value = requiredAction(action.scroll, action.type);
              await withHeldKeys(page, value.hold_keys, async () => {
                await page.mouse.move(value.x, value.y);
                await page.mouse.wheel(value.delta_x ?? 0, value.delta_y ?? 0);
              });
              mousePositions.set(input.session_id, { x: value.x, y: value.y });
              break;
            }
            case "drag_mouse": {
              const value = requiredAction(action.drag_mouse, action.type);
              await withHeldKeys(page, value.hold_keys, async () => {
                const [start, ...rest] = value.path;
                const [startX = 0, startY = 0] = start ?? [];
                await page.mouse.move(startX, startY);
                await page.mouse.down({ button: value.button ?? "left" });
                for (const point of rest) {
                  const [x = 0, y = 0] = point;
                  await page.mouse.move(x, y, {
                    steps: value.steps_per_segment,
                  });
                  if (value.step_delay_ms) {
                    await delay(value.step_delay_ms);
                  }
                }
                await page.mouse.up({ button: value.button ?? "left" });
                const [endX = 0, endY = 0] = value.path.at(-1) ?? [];
                mousePositions.set(input.session_id, { x: endX, y: endY });
                if (value.delay) await delay(value.delay);
              });
              break;
            }
            case "set_cursor": {
              const value = requiredAction(action.set_cursor, action.type);
              await page.addStyleTag({
                content: value.hidden
                  ? "html, body, * { cursor: none !important; }"
                  : "html, body, * { cursor: auto !important; }",
              });
              break;
            }
            case "sleep":
              await delay(
                requiredAction(action.sleep, action.type).duration_ms
              );
              break;
            case "write_clipboard": {
              const value = requiredAction(action.write_clipboard, action.type);
              await browserContext.grantPermissions(
                ["clipboard-read", "clipboard-write"],
                { origin: new URL(page.url()).origin }
              );
              await page.evaluate(
                (text) => navigator.clipboard.writeText(text),
                value.text
              );
              break;
            }
            case "read_clipboard":
              await browserContext.grantPermissions(
                ["clipboard-read", "clipboard-write"],
                { origin: new URL(page.url()).origin }
              );
              data.push(
                await page.evaluate(() => navigator.clipboard.readText())
              );
              break;
            case "get_mouse_position":
              data.push(mousePositions.get(input.session_id) ?? { x: 0, y: 0 });
              break;
            case "screenshot": {
              const value = action.screenshot;
              const screenshot = await withVaultScreenshotMask(page, () =>
                page.screenshot({
                  animations: "disabled",
                  caret: "hide",
                  clip: value?.region,
                  type: "png",
                })
              );
              screenshotBase64 = screenshot.toString("base64");
              break;
            }
          }
        }

        return outputSchema.parse({
          data: data.length > 0 ? data : undefined,
          message: `Executed ${String(input.actions.length)} computer action${input.actions.length === 1 ? "" : "s"}.`,
          mimeType: screenshotBase64 ? "image/png" : undefined,
          screenshotBase64,
        });
      }
    );
  },
  toModelOutput(output) {
    if (!output.screenshotBase64) {
      return toolOutput.json({ data: output.data, message: output.message });
    }
    return toolOutput.content([
      toolOutputPart.text(output.message),
      toolOutputPart.file(output.screenshotBase64, {
        mediaType: output.mimeType ?? "image/png",
      }),
    ]);
  },
});

function requiredAction<T>(value: T | undefined, action: string): T {
  if (value === undefined) {
    throw new Error(`Computer action ${action} is missing its payload.`);
  }
  return value;
}

async function withHeldKeys<T>(
  page: Page,
  keys: readonly string[] | undefined,
  operation: () => Promise<T>
) {
  for (const key of keys ?? []) await page.keyboard.down(key);
  try {
    return await operation();
  } finally {
    for (const key of (keys ?? []).toReversed()) {
      await page.keyboard.up(key).catch(() => undefined);
    }
  }
}

function delay(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
