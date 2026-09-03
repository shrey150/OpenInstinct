import { createHash } from "node:crypto";
import type {
  Session,
  SessionRetrieveResponse,
} from "@browserbasehq/sdk/resources/sessions/sessions";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  createBrowserSession,
  deleteBrowserSession,
  listBrowserSessions,
  withBrowserProfileWriteLock,
} from "@/db/services/browsers";
import { recordBrowserTraceDomains } from "@/db/services/browser-traces";
import { getBrowserbase, getBrowserbaseProjectId } from "@/lib/browserbase";
import {
  isActiveBrowserbaseStatus,
  withBrowserbasePage,
} from "@/lib/browserbase-playwright";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import {
  domainFromUrl,
  harvestBrowserTraceDomains,
} from "@/agent/subagents/worker/lib/trace/domains";

const browserTimeoutFloorSeconds = 15 * 60;
const browserTimeoutMaximumSeconds = 6 * 60 * 60;
const workspaceContextPromises = new Map<string, Promise<string>>();

const inputSchema = z.object({
  action: z.enum(["create", "update", "list", "get", "delete"]),
  save_changes: z.boolean().optional(),
  session_id: z.string().optional(),
  start_url: z.url().optional(),
  timeout_seconds: z
    .number()
    .int()
    .min(browserTimeoutFloorSeconds)
    .max(browserTimeoutMaximumSeconds)
    .optional(),
  viewport_width: z.number().int().min(1).optional(),
  viewport_height: z.number().int().min(1).optional(),
  status: z.enum(["active", "deleted", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

const manageBrowsers = defineTool({
  description:
    'Manage Browserbase Verified sessions backed by the workspace persistent context. Sessions use managed residential proxies and CAPTCHA solving. Browserbase controls the viewport as part of the Verified fingerprint, so viewport hints are accepted for compatibility but ignored. Create read-only browsers by default so tasks can run in parallel. Immediately before a login, replace that task browser with one created using save_changes: true, then delete it after authentication so the context is saved. Only one context writer may be active. Use "list" or "get" to inspect sessions.',
  inputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    const signal = context.abortSignal;

    switch (input.action) {
      case "create": {
        const create = async () => {
          const contextId = await ensureWorkspaceContext(
            scope.workspaceId,
            signal
          );
          if (input.save_changes) {
            const activeWriter = await findActiveContextWriter(scope, signal);
            if (activeWriter) {
              throw new Error(
                `Browser session ${activeWriter.id} is already saving login state for this workspace. Retry after it finishes.`
              );
            }
          }

          // Validate paired viewport hints for contract compatibility, but do
          // not apply them: Browserbase Verified owns the viewport as part of
          // its fingerprint.
          browserViewport(input);
          const browser = await getBrowserbase().sessions.create(
            {
              api_timeout: input.timeout_seconds ?? browserTimeoutFloorSeconds,
              browserSettings: {
                blockAds: false,
                context: {
                  id: contextId,
                  persist: input.save_changes ?? false,
                },
                logSession: true,
                recordSession: true,
                solveCaptchas: true,
                verified: true,
                // Verified sessions use a Browserbase-managed viewport as part
                // of their fingerprint. Passing a custom viewport weakens that
                // identity and is intentionally avoided.
              },
              keepAlive: true,
              projectId: getBrowserbaseProjectId(),
              proxies: [
                {
                  geolocation: {
                    city: "New York",
                    country: "US",
                    state: "NY",
                  },
                  type: "browserbase",
                },
              ],
              region: "us-east-1",
              userMetadata: {
                openinstinctContext: browserbaseContextKeyForWorkspace(
                  scope.workspaceId
                ),
                openinstinctProfileWriter: String(input.save_changes ?? false),
                provider: "browserbase",
              },
            },
            { maxRetries: 8, signal }
          );

          try {
            const startUrl = input.start_url;
            if (startUrl) {
              await withBrowserbasePage(
                browser.id,
                signal,
                async ({ page }) => {
                  await page.goto(startUrl, {
                    timeout: 45_000,
                    waitUntil: "domcontentloaded",
                  });
                }
              );
            }
            await createBrowserSession(scope, {
              createdAt: browser.createdAt,
              sessionId: browser.id,
              workerSessionId: context.session.id,
            });
          } catch (error) {
            await releaseBrowserbaseSession(browser.id, signal).catch(
              () => undefined
            );
            throw error;
          }

          const startDomain = input.start_url
            ? domainFromUrl(input.start_url)
            : undefined;
          if (startDomain) {
            await recordBrowserTraceDomains(scope, context.session.id, [
              startDomain,
            ]).catch(() => undefined);
          }
          return lifecycleResult(await browserDescriptor(browser, signal));
        };
        return input.save_changes
          ? withBrowserProfileWriteLock(scope, create)
          : create();
      }
      case "list": {
        const records = await listBrowserSessions(scope);
        const browsers = await Promise.all(
          records.map(async ({ sessionId }) => {
            try {
              const browser = await getBrowserbase().sessions.retrieve(
                sessionId,
                {
                  signal,
                }
              );
              const value = await browserDescriptor(browser, signal);
              if (input.status === "deleted" && value.status !== "deleted") {
                return null;
              }
              if (input.status === "active" && value.status !== "active") {
                return null;
              }
              return value;
            } catch (error) {
              if (isNotFoundError(error)) {
                await deleteBrowserSession(scope, sessionId);
              }
              return null;
            }
          })
        );
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          has_more: false,
          items: browsers
            .filter((browser) => browser !== null)
            .slice(offset, offset + limit),
          next_offset: null,
        };
      }
      case "get": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowserSession(scope, sessionId);
        return browserDescriptor(
          await retrieveBrowser(scope, sessionId, signal),
          signal
        );
      }
      case "update": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowserSession(scope, sessionId);
        browserViewport(input);
        return lifecycleResult(
          await browserDescriptor(
            await retrieveBrowser(scope, sessionId, signal),
            signal
          )
        );
      }
      case "delete": {
        const sessionId = requireSessionId(input.session_id);
        const record = await requireOwnedBrowserSession(scope, sessionId);
        await harvestBrowserTraceDomains(
          scope,
          record.workerSessionId ?? context.session.id,
          { createdAt: record.createdAt, sessionId: record.sessionId },
          signal
        );
        await releaseBrowserbaseSession(sessionId, signal).catch(
          (cause: unknown) => {
            if (!isNotFoundError(cause)) throw cause;
          }
        );
        await deleteBrowserSession(scope, sessionId);
        return "Browser session deleted successfully";
      }
    }
    throw new Error("Unsupported browser management action.");
  },
});

export default manageBrowsers;

function requireSessionId(sessionId: string | undefined) {
  if (!sessionId) throw new Error("A browser session ID is required.");
  return sessionId;
}

async function retrieveBrowser(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  sessionId: string,
  signal?: AbortSignal
) {
  try {
    const browser = await getBrowserbase().sessions.retrieve(sessionId, {
      signal,
    });
    if (!isActiveBrowserbaseStatus(browser.status)) {
      await deleteBrowserSession(scope, sessionId);
      throw new Error(
        "Browser session no longer exists. Its stale record was removed; create a fresh browser instead of retrying this session ID."
      );
    }
    return browser;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    await deleteBrowserSession(scope, sessionId);
    throw new Error(
      "Browser session no longer exists. Its stale record was removed; create a fresh browser instead of retrying this session ID.",
      { cause: error }
    );
  }
}

function isNotFoundError(cause: unknown) {
  return z.object({ status: z.literal(404) }).safeParse(cause).success;
}

function browserViewport(input: z.infer<typeof inputSchema>) {
  const height = input.viewport_height;
  const width = input.viewport_width;
  if (height === undefined && width === undefined) return undefined;
  if (height === undefined || width === undefined) {
    throw new Error("Viewport width and height must be provided together.");
  }
  return { height, width };
}

async function browserDescriptor(
  browser: Session | SessionRetrieveResponse,
  signal?: AbortSignal
) {
  const active = isActiveBrowserbaseStatus(browser.status);
  const liveView = active
    ? await getBrowserbase().sessions.debug(browser.id, { signal })
    : undefined;
  const viewport = active
    ? await withBrowserbasePage(browser.id, signal, async ({ page }) =>
        page.viewportSize()
      ).catch(() => undefined)
    : undefined;
  return {
    browser_live_view_url:
      liveView?.debuggerFullscreenUrl ??
      `https://browserbase.com/sessions/${browser.id}`,
    session_id: browser.id,
    status: active ? ("active" as const) : ("deleted" as const),
    viewport: viewport ?? undefined,
  };
}

function lifecycleResult(value: Awaited<ReturnType<typeof browserDescriptor>>) {
  return {
    browser: value,
    next_actions: [
      `Use playwright_execute with session_id "${value.session_id}" as the primary surface for deterministic selector-based inspection and interaction, including related safe actions and compact reads.`,
      `If Playwright is unreliable or semantic interaction is more suitable, call browser_snapshot with session_id "${value.session_id}" to mint current refs; use browser_find or browser_text to narrow large pages.`,
      `Then use browser_act with session_id "${value.session_id}" as a relaxed fallback for short ref-based click, fill, and submit plans; inspect its successor state.`,
      `Use computer_action with session_id "${value.session_id}" only when visual reasoning or coordinate control is necessary.`,
      `Use manage_browsers with action "delete" and session_id "${value.session_id}" when finished.`,
    ],
  };
}

export function browserbaseContextKeyForWorkspace(workspaceId: string) {
  return createHash("sha256")
    .update(`browserbase-context\0${workspaceId}`)
    .digest("hex")
    .slice(0, 40);
}

async function ensureWorkspaceContext(
  workspaceId: string,
  signal?: AbortSignal
) {
  const existing = workspaceContextPromises.get(workspaceId);
  if (existing) return existing;
  const pending = discoverOrCreateWorkspaceContext(workspaceId, signal);
  workspaceContextPromises.set(workspaceId, pending);
  try {
    return await pending;
  } catch (error) {
    if (workspaceContextPromises.get(workspaceId) === pending) {
      workspaceContextPromises.delete(workspaceId);
    }
    throw error;
  }
}

async function discoverOrCreateWorkspaceContext(
  workspaceId: string,
  signal?: AbortSignal
) {
  const key = browserbaseContextKeyForWorkspace(workspaceId);
  const matchingSessions = await getBrowserbase().sessions.list(
    { q: `user_metadata['openinstinctContext']:'${key}'` },
    { signal }
  );
  const priorContextIds = matchingSessions
    .filter(
      (session): session is typeof session & { contextId: string } =>
        session.contextId !== undefined
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((session) => session.contextId);
  const availableContextIds = await Promise.all(
    priorContextIds.map(async (contextId) => {
      try {
        await getBrowserbase().contexts.retrieve(contextId, { signal });
        return contextId;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        return undefined;
      }
    })
  );
  const priorContextId = availableContextIds.find(
    (contextId) => contextId !== undefined
  );
  if (priorContextId) return priorContextId;

  const created = await getBrowserbase().contexts.create(
    { projectId: getBrowserbaseProjectId() },
    { signal }
  );
  return created.id;
}

async function findActiveContextWriter(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  signal?: AbortSignal
) {
  const records = await listBrowserSessions(scope);
  const browsers = await Promise.all(
    records.map(async (record) => {
      try {
        return await getBrowserbase().sessions.retrieve(record.sessionId, {
          signal,
        });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        return undefined;
      }
    })
  );
  return browsers.find(
    (browser) =>
      browser !== undefined &&
      isActiveBrowserbaseStatus(browser.status) &&
      browser.userMetadata?.openinstinctProfileWriter === "true"
  );
}

async function releaseBrowserbaseSession(
  sessionId: string,
  signal?: AbortSignal
) {
  const browser = await getBrowserbase().sessions.retrieve(sessionId, {
    signal,
  });
  if (!isActiveBrowserbaseStatus(browser.status)) return browser;
  return getBrowserbase().sessions.update(
    sessionId,
    {
      projectId: getBrowserbaseProjectId(),
      status: "REQUEST_RELEASE",
    },
    { signal }
  );
}
