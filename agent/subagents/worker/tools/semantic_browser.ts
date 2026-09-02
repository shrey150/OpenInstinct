import { defineDynamic, defineTool } from "eve/tools";
import type { Locator, Page } from "playwright-core";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { withBrowserbasePage } from "@/lib/browserbase-playwright";

/* eslint-disable no-await-in-loop -- Ref actions in a browser plan are intentionally dependent and sequential. */

const sessionId = z.string().min(1).describe("Owned Browserbase session ID.");
const maximumSnapshotCharacters = 16_000;

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ref: z.string().regex(/^r\d+$/u) }),
  z.object({
    type: z.literal("fill"),
    ref: z.string().regex(/^r\d+$/u),
    text: z.string(),
  }),
  z.object({
    type: z.literal("type"),
    ref: z.string().regex(/^r\d+$/u),
    text: z.string(),
  }),
  z.object({
    type: z.literal("select"),
    ref: z.string().regex(/^r\d+$/u),
    value: z.string(),
  }),
  z.object({ type: z.literal("check"), ref: z.string().regex(/^r\d+$/u) }),
  z.object({
    type: z.literal("uncheck"),
    ref: z.string().regex(/^r\d+$/u),
  }),
  z.object({ type: z.literal("hover"), ref: z.string().regex(/^r\d+$/u) }),
  z.object({
    type: z.literal("press"),
    key: z.string().min(1),
    ref: z
      .string()
      .regex(/^r\d+$/u)
      .optional(),
  }),
]);

const playwrightStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: z.url() }),
  z.object({
    type: z.literal("click"),
    selector: z.string().min(1).max(2_000),
  }),
  z.object({
    type: z.literal("fill"),
    selector: z.string().min(1).max(2_000),
    value: z.string(),
  }),
  z.object({
    type: z.literal("type"),
    selector: z.string().min(1).max(2_000),
    value: z.string(),
  }),
  z.object({
    type: z.literal("select"),
    selector: z.string().min(1).max(2_000),
    value: z.string(),
  }),
  z.object({
    type: z.literal("check"),
    selector: z.string().min(1).max(2_000),
  }),
  z.object({
    type: z.literal("uncheck"),
    selector: z.string().min(1).max(2_000),
  }),
  z.object({
    type: z.literal("hover"),
    selector: z.string().min(1).max(2_000),
  }),
  z.object({
    type: z.literal("press"),
    selector: z.string().min(1).max(2_000).optional(),
    key: z.string().min(1).max(100),
  }),
  z.object({
    type: z.literal("wait_for_selector"),
    selector: z.string().min(1).max(2_000),
    state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
  }),
  z.object({
    type: z.literal("wait_for_text"),
    text: z.string().min(1).max(1_000),
  }),
  z.object({
    type: z.literal("wait_for_url"),
    url_contains: z.string().min(1).max(2_000),
  }),
  z.object({
    type: z.literal("wait_for_load"),
    state: z.enum(["domcontentloaded", "load", "networkidle"]),
  }),
]);

const playwrightReadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), selector: z.string().min(1).max(2_000) }),
  z.object({
    type: z.literal("attribute"),
    selector: z.string().min(1).max(2_000),
    name: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("value"),
    selector: z.string().min(1).max(2_000),
  }),
  z.object({
    type: z.literal("count"),
    selector: z.string().min(1).max(2_000),
  }),
]);

export default defineDynamic({
  events: {
    "session.started": () => ({
      browser_snapshot: defineTool({
        description:
          "Inspect the current page and mint short-lived refs for visible interactive elements. Re-snapshot after navigation or a major page change.",
        inputSchema: z.object({
          session_id: sessionId,
          max_characters: z
            .number()
            .int()
            .min(1_000)
            .max(maximumSnapshotCharacters)
            .optional(),
          ref: z
            .string()
            .regex(/^r\d+$/u)
            .optional(),
        }),
        async execute(input, context) {
          await requireSession(input.session_id, context);
          return withBrowserbasePage(
            input.session_id,
            context.abortSignal,
            async ({ page }) =>
              snapshotPage(
                page,
                input.max_characters ?? maximumSnapshotCharacters,
                input.ref
              )
          );
        },
      }),
      browser_text: defineTool({
        description:
          "Read visible text from the current page, a CSS selector, or a current browser ref.",
        inputSchema: z.object({
          session_id: sessionId,
          max_characters: z.number().int().min(500).max(30_000).optional(),
          ref: z
            .string()
            .regex(/^r\d+$/u)
            .optional(),
          selector: z.string().min(1).max(2_000).optional(),
        }),
        async execute(input, context) {
          await requireSession(input.session_id, context);
          return withBrowserbasePage(
            input.session_id,
            context.abortSignal,
            async ({ page }) => {
              const locator = input.ref
                ? locatorForRef(page, input.ref)
                : input.selector
                  ? page.locator(input.selector).first()
                  : page.locator("body");
              const text = await readLocatorText(locator, 10_000);
              return {
                text: truncate(text, input.max_characters ?? 20_000),
                title: await page.title(),
                url: page.url(),
              };
            }
          );
        },
      }),
      browser_find: defineTool({
        description:
          'Find rendered interactive controls whose accessible name, text, placeholder, title, role, value, or state ("checked", "unchecked", "enabled", or "disabled") contains a query. Returns current refs for browser_act.',
        inputSchema: z.object({
          session_id: sessionId,
          query: z.string().trim().min(1).max(500),
          limit: z.number().int().min(1).max(50).optional(),
        }),
        async execute(input, context) {
          await requireSession(input.session_id, context);
          return withBrowserbasePage(
            input.session_id,
            context.abortSignal,
            async ({ page }) => {
              const snapshot = await snapshotPage(page, 30_000);
              const query = input.query.toLocaleLowerCase();
              const matches = snapshot.elements
                .filter((element) =>
                  [
                    element.name,
                    element.role,
                    element.placeholder,
                    element.value,
                    element.checked === undefined
                      ? undefined
                      : element.checked
                        ? "checked"
                        : "unchecked",
                    element.disabled ? "disabled" : "enabled",
                  ].some((value) => value?.toLocaleLowerCase().includes(query))
                )
                .slice(0, input.limit ?? 20);
              return {
                items: matches,
                title: snapshot.title,
                url: snapshot.url,
              };
            }
          );
        },
      }),
      browser_wait_for: defineTool({
        description:
          "Wait for one specific visible ref/text, URL substring, title substring, or page load state. Use bounded waits instead of fixed sleeps.",
        inputSchema: z
          .object({
            session_id: sessionId,
            load_state: z
              .enum(["domcontentloaded", "load", "networkidle"])
              .optional(),
            ref: z
              .string()
              .regex(/^r\d+$/u)
              .optional(),
            text: z.string().min(1).max(1_000).optional(),
            title: z.string().min(1).max(1_000).optional(),
            timeout_ms: z.number().int().min(100).max(20_000).optional(),
            url: z.string().min(1).max(2_000).optional(),
          })
          .refine(
            ({ load_state, ref, text, title, url }) =>
              Boolean(load_state ?? ref ?? text ?? title ?? url),
            "Provide a load state, ref, text, title, or URL condition."
          ),
        async execute(input, context) {
          await requireSession(input.session_id, context);
          return withBrowserbasePage(
            input.session_id,
            context.abortSignal,
            async ({ page }) => {
              const timeout = input.timeout_ms ?? 10_000;
              if (input.load_state) {
                await page.waitForLoadState(input.load_state, { timeout });
              }
              if (input.ref) {
                await locatorForRef(page, input.ref).waitFor({
                  state: "visible",
                  timeout,
                });
              }
              if (input.text) {
                await page
                  .getByText(input.text, { exact: false })
                  .first()
                  .waitFor({
                    state: "visible",
                    timeout,
                  });
              }
              if (input.url) {
                const expectedUrl = input.url;
                await page.waitForURL((url) => url.href.includes(expectedUrl), {
                  timeout,
                });
              }
              if (input.title) {
                await page.waitForFunction(
                  (expected) => document.title.includes(expected),
                  input.title,
                  { timeout }
                );
              }
              return {
                matched: true,
                title: await page.title(),
                url: page.url(),
              };
            }
          );
        },
      }),
      browser_act: defineTool({
        description:
          "Run 1–8 short dependent actions against current refs, then return a compact successor snapshot. Use fresh refs from browser_snapshot or browser_find.",
        inputSchema: z.object({
          session_id: sessionId,
          steps: z.array(actionSchema).min(1).max(8),
        }),
        async execute(input, context) {
          await requireSession(input.session_id, context);
          return withBrowserbasePage(
            input.session_id,
            context.abortSignal,
            async ({ page }) => {
              const completed: { index: number; type: string }[] = [];
              for (const [index, step] of input.steps.entries()) {
                await executeAction(page, step);
                completed.push({ index, type: step.type });
              }
              return {
                completed,
                dispatched_steps: completed.length,
                successor: await snapshotPage(page, 6_000),
              };
            }
          );
        },
      }),
      playwright_execute: defineTool({
        description:
          "Execute a bounded, structured Playwright plan against the current Browserbase page, then return requested text, attributes, values, or counts. Use CSS selectors, keep dependent steps in order, and never read credentials or vault-filled fields.",
        inputSchema: z.object({
          session_id: sessionId,
          steps: z.array(playwrightStepSchema).min(1).max(12),
          reads: z.array(playwrightReadSchema).max(20).optional(),
          timeout_ms: z.number().int().min(100).max(30_000).optional(),
        }),
        async execute(input, context) {
          await requireSession(input.session_id, context);
          return withBrowserbasePage(
            input.session_id,
            context.abortSignal,
            async ({ page }) => {
              const timeout = input.timeout_ms ?? 10_000;
              const completed: { index: number; type: string }[] = [];
              for (const [index, step] of input.steps.entries()) {
                await executePlaywrightStep(page, step, timeout);
                completed.push({ index, type: step.type });
              }
              const reads = await Promise.all(
                (input.reads ?? []).map((read) =>
                  safeReadPlaywrightValue(page, read, timeout)
                )
              );
              return {
                completed,
                reads,
                successor: await snapshotPage(page, 6_000),
                title: await page.title(),
                url: page.url(),
              };
            }
          );
        },
      }),
    }),
  },
});

async function requireSession(
  browserSessionId: string,
  context: Parameters<typeof requireWorkerScope>[0]
) {
  const scope = await requireWorkerScope(context);
  await requireOwnedBrowserSession(scope, browserSessionId);
}

async function snapshotPage(
  page: Page,
  maximumCharacters: number,
  onlyRef?: string
) {
  const elements = await page.evaluate((requestedRef) => {
    const selector = [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "summary",
      "ion-button",
      "ion-checkbox",
      "ion-input",
      "ion-radio",
      "ion-select",
      "ion-textarea",
      "[contenteditable='true']",
      "[role='button']",
      "[role='checkbox']",
      "[role='combobox']",
      "[role='link']",
      "[role='menuitem']",
      "[role='option']",
      "[role='radio']",
      "[role='searchbox']",
      "[role='switch']",
      "[role='tab']",
    ].join(",");
    for (const prior of document.querySelectorAll<HTMLElement>(
      "[data-openinstinct-ref]"
    )) {
      delete prior.dataset.openinstinctRef;
    }
    const semanticCandidates = [
      ...document.querySelectorAll<HTMLElement>(selector),
    ];
    const semanticSet = new Set(semanticCandidates);
    const pointerCandidates = [
      ...document.querySelectorAll<HTMLElement>("body *"),
    ].filter(
      (element) =>
        !semanticSet.has(element) &&
        getComputedStyle(element).cursor === "pointer"
    );
    const candidates = [...semanticCandidates, ...pointerCandidates]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return !(
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.pointerEvents === "none" ||
          rect.width <= 0 ||
          rect.height <= 0
        );
      })
      .toSorted((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const leftInViewport =
          leftRect.bottom > 0 &&
          leftRect.right > 0 &&
          leftRect.top < innerHeight &&
          leftRect.left < innerWidth;
        const rightInViewport =
          rightRect.bottom > 0 &&
          rightRect.right > 0 &&
          rightRect.top < innerHeight &&
          rightRect.left < innerWidth;
        if (leftInViewport !== rightInViewport) return leftInViewport ? -1 : 1;
        const leftSemantic = semanticSet.has(left);
        const rightSemantic = semanticSet.has(right);
        if (leftSemantic !== rightSemantic) return leftSemantic ? -1 : 1;
        const leftIsSeat = left.matches("button[aria-label^='Row ']");
        const rightIsSeat = right.matches("button[aria-label^='Row ']");
        if (leftIsSeat !== rightIsSeat) return leftIsSeat ? 1 : -1;
        const position = left.compareDocumentPosition(right);
        return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      .slice(0, 800);
    return candidates.flatMap((element, index) => {
      const ref = `r${String(index)}`;
      element.dataset.openinstinctRef = ref;
      if (requestedRef && requestedRef !== ref) return [];
      const input = element instanceof HTMLInputElement ? element : undefined;
      const name = (
        [
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
          element.innerText,
          input?.labels?.[0]?.innerText,
          input?.placeholder,
          element.getAttribute("title"),
          input?.value,
        ].find(
          (candidate) =>
            candidate !== undefined &&
            candidate !== null &&
            candidate.length > 0
        ) ?? ""
      )
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 240);
      const implicitRole =
        element instanceof HTMLAnchorElement
          ? "link"
          : element instanceof HTMLButtonElement
            ? "button"
            : element instanceof HTMLSelectElement
              ? "combobox"
              : element instanceof HTMLTextAreaElement
                ? "textbox"
                : (input?.type ?? element.tagName.toLocaleLowerCase());
      return [
        {
          checked:
            input && (input.type === "radio" || input.type === "checkbox")
              ? input.checked
              : undefined,
          disabled: element.matches(":disabled"),
          name,
          placeholder: input?.placeholder,
          ref,
          role: element.getAttribute("role") ?? implicitRole,
          value:
            input && input.type !== "password"
              ? input.value.slice(0, 160)
              : undefined,
        },
      ];
    });
  }, onlyRef);
  const title = await page.title();
  const url = page.url();
  const prefix = [`Title: ${title}`, `URL: ${url}`];
  const boundedElements: typeof elements = [];
  const lines: string[] = [];
  let characterCount = prefix.join("\n").length;
  for (const element of elements) {
    const { checked, disabled, name, placeholder, ref, role, value } = element;
    const line = `[${ref}] ${role}${name ? ` "${name}"` : ""}${placeholder ? ` placeholder="${placeholder}"` : ""}${value ? ` value="${value}"` : ""}${checked === undefined ? "" : checked ? " checked" : " unchecked"}${disabled ? " disabled" : ""}`;
    if (characterCount + line.length + 1 > maximumCharacters) break;
    boundedElements.push(element);
    lines.push(line);
    characterCount += line.length + 1;
  }
  return {
    elements: boundedElements,
    text: [...prefix, ...lines].join("\n"),
    title,
    url,
  };
}

function locatorForRef(page: Page, ref: string) {
  // Snapshot refs are already screened for rendered geometry. Keep the raw
  // element here because design-system radios often use a 1px native input
  // with a visible label, which Playwright does not classify as visible.
  return page.locator(`[data-openinstinct-ref="${ref}"]`).first();
}

async function executeAction(page: Page, step: z.infer<typeof actionSchema>) {
  const locator: Locator | undefined =
    "ref" in step && step.ref ? locatorForRef(page, step.ref) : undefined;
  switch (step.type) {
    case "click":
      return clickWithFallback(requiredLocator(locator, step.type));
    case "fill":
      return requiredLocator(locator, step.type).fill(step.text, {
        timeout: 10_000,
      });
    case "type":
      return requiredLocator(locator, step.type).pressSequentially(step.text, {
        timeout: 10_000,
      });
    case "select":
      return requiredLocator(locator, step.type).selectOption(step.value, {
        timeout: 10_000,
      });
    case "check":
      return setCheckedWithFallback(
        requiredLocator(locator, step.type),
        true,
        10_000
      );
    case "uncheck":
      return setCheckedWithFallback(
        requiredLocator(locator, step.type),
        false,
        10_000
      );
    case "hover":
      return requiredLocator(locator, step.type).hover({ timeout: 10_000 });
    case "press":
      return locator
        ? locator.press(step.key, { timeout: 10_000 })
        : page.keyboard.press(step.key);
  }
}

async function clickWithFallback(locator: Locator, timeout = 10_000) {
  const radio = await locator
    .evaluate(
      (element) =>
        element instanceof HTMLInputElement && element.type === "radio"
    )
    .catch(() => false);
  if (radio) return setCheckedWithFallback(locator, true, timeout);

  let primaryError: unknown;
  try {
    await locator.click({ timeout: Math.min(timeout, 4_000) });
    await settleAfterAction(locator);
    return;
  } catch (error) {
    primaryError = error;
  }
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 2_000) });
    await locator.click({ force: true, timeout: Math.min(timeout, 4_000) });
    await settleAfterAction(locator);
    return;
  } catch {
    // Some custom controls reject Playwright's actionability checks even
    // though their DOM click handler is usable. Fall back to the browser's
    // native click/dispatch path on the currently visible element.
  }

  try {
    const handle = await locator.elementHandle({ timeout });
    try {
      await handle.evaluate((element) => {
        if (element instanceof HTMLElement) {
          element.click();
          return;
        }
        element.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
          })
        );
      });
    } finally {
      await handle.dispose();
    }
    await settleAfterAction(locator);
  } catch (fallbackError) {
    throw new AggregateError(
      [primaryError, fallbackError],
      "Unable to activate the visible browser control. Take a fresh snapshot before retrying.",
      { cause: fallbackError }
    );
  }
}

async function executePlaywrightStep(
  page: Page,
  step: z.infer<typeof playwrightStepSchema>,
  timeout: number
) {
  switch (step.type) {
    case "goto":
      await page.goto(step.url, { timeout, waitUntil: "domcontentloaded" });
      return;
    case "click":
      await clickWithFallback(
        await preferredLocator(page, step.selector),
        timeout
      );
      return;
    case "fill":
      await (
        await preferredLocator(page, step.selector)
      ).fill(step.value, {
        timeout,
      });
      return;
    case "type":
      await (
        await preferredLocator(page, step.selector)
      ).pressSequentially(step.value, { timeout });
      return;
    case "select":
      await (
        await preferredLocator(page, step.selector)
      ).selectOption(step.value, { timeout });
      return;
    case "check":
      await setCheckedWithFallback(
        await preferredLocator(page, step.selector),
        true,
        timeout
      );
      return;
    case "uncheck":
      await setCheckedWithFallback(
        await preferredLocator(page, step.selector),
        false,
        timeout
      );
      return;
    case "hover":
      await (await preferredLocator(page, step.selector)).hover({ timeout });
      return;
    case "press":
      if (step.selector) {
        await (
          await preferredLocator(page, step.selector)
        ).press(step.key, {
          timeout,
        });
      } else {
        await page.keyboard.press(step.key);
      }
      return;
    case "wait_for_selector":
      await page
        .locator(step.selector)
        .first()
        .waitFor({
          state: step.state ?? "visible",
          timeout,
        });
      return;
    case "wait_for_text":
      await page.getByText(step.text, { exact: false }).first().waitFor({
        state: "visible",
        timeout,
      });
      return;
    case "wait_for_url":
      await page.waitForURL((url) => url.href.includes(step.url_contains), {
        timeout,
      });
      return;
    case "wait_for_load":
      await page.waitForLoadState(step.state, { timeout });
  }
}

async function readPlaywrightValue(
  page: Page,
  read: z.infer<typeof playwrightReadSchema>,
  timeout: number
) {
  const locator = page.locator(read.selector).first();
  switch (read.type) {
    case "text":
      return {
        type: read.type,
        value: await readLocatorText(locator, timeout),
      };
    case "attribute":
      return {
        name: read.name,
        type: read.type,
        value: await locator.getAttribute(read.name, { timeout }),
      };
    case "value":
      return { type: read.type, value: await locator.inputValue({ timeout }) };
    case "count":
      return {
        type: read.type,
        value: await page.locator(read.selector).count(),
      };
  }
  throw new Error("Unsupported Playwright read operation.");
}

async function safeReadPlaywrightValue(
  page: Page,
  read: z.infer<typeof playwrightReadSchema>,
  timeout: number
) {
  try {
    return await readPlaywrightValue(page, read, timeout);
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message.split("\n", 1)[0]
          : String(error),
      type: read.type,
    };
  }
}

async function readLocatorText(locator: Locator, timeout: number) {
  return (await locator.textContent({ timeout })) ?? "";
}

async function preferredLocator(page: Page, selector: string) {
  const all = page.locator(selector);
  const visible = all.filter({ visible: true });
  return (await visible.count()) > 0 ? visible.first() : all.first();
}

async function setCheckedWithFallback(
  locator: Locator,
  checked: boolean,
  timeout: number
) {
  let needsFallback = false;
  try {
    if (checked) await locator.check({ timeout: Math.min(timeout, 4_000) });
    else await locator.uncheck({ timeout: Math.min(timeout, 4_000) });
  } catch {
    needsFallback = true;
  }
  if (!needsFallback) {
    needsFallback = (await locator.isChecked({ timeout })) !== checked;
  }
  if (needsFallback) {
    const handle = await locator.elementHandle({ timeout });
    try {
      await handle.evaluate((element, desired) => {
        if (!(element instanceof HTMLInputElement)) {
          throw new Error("Check actions require an input control.");
        }
        if (element.checked !== desired) element.click();
      }, checked);
    } finally {
      await handle.dispose();
    }
  }
  if ((await locator.isChecked({ timeout })) !== checked) {
    throw new Error(
      `Browser control did not become ${checked ? "checked" : "unchecked"}.`
    );
  }
  await settleAfterAction(locator);
}

async function settleAfterAction(locator: Locator) {
  await locator.page().waitForTimeout(1_000);
}

function requiredLocator(locator: Locator | undefined, action: string) {
  if (!locator) throw new Error(`Browser action ${action} requires a ref.`);
  return locator;
}

function truncate(value: string, maximum: number) {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}\n…truncated`;
}
