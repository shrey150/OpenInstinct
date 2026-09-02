/* oxlint-disable vitest/require-mock-type-parameters -- Fixtures implement the narrow Browserbase and Playwright surfaces exercised by the tool. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toolContextFor } from "@/tests/helpers/tool-context";

const mocks = vi.hoisted(() => ({
  contextCreate: vi.fn(),
  contextRetrieve: vi.fn(),
  createBrowser: vi.fn(),
  createBrowserSession: vi.fn(),
  debugBrowser: vi.fn(),
  deleteBrowserSession: vi.fn(),
  harvestBrowserTraceDomains: vi.fn(),
  listBrowserSessions: vi.fn(),
  listRemoteBrowsers: vi.fn(),
  recordBrowserTraceDomains: vi.fn(),
  requireOwnedBrowserSession: vi.fn(),
  requireWorkerScope: vi.fn(),
  retrieveBrowser: vi.fn(),
  setViewportSize: vi.fn(),
  updateBrowser: vi.fn(),
  withBrowserbasePage: vi.fn(),
  withBrowserProfileWriteLock: vi.fn(),
}));

vi.mock("@/lib/browserbase", () => ({
  browserbase: {
    contexts: {
      create: mocks.contextCreate,
      retrieve: mocks.contextRetrieve,
    },
    sessions: {
      create: mocks.createBrowser,
      debug: mocks.debugBrowser,
      list: mocks.listRemoteBrowsers,
      retrieve: mocks.retrieveBrowser,
      update: mocks.updateBrowser,
    },
  },
  browserbaseProjectId: undefined,
}));
vi.mock("@/lib/browserbase-playwright", () => ({
  isActiveBrowserbaseStatus: (status: string) =>
    status === "PENDING" || status === "RUNNING",
  withBrowserbasePage: mocks.withBrowserbasePage,
}));
vi.mock("@/db/services/browsers", () => ({
  createBrowserSession: mocks.createBrowserSession,
  deleteBrowserSession: mocks.deleteBrowserSession,
  listBrowserSessions: mocks.listBrowserSessions,
  withBrowserProfileWriteLock: mocks.withBrowserProfileWriteLock,
}));
vi.mock("@/db/services/browser-traces", () => ({
  recordBrowserTraceDomains: mocks.recordBrowserTraceDomains,
}));
vi.mock("@/agent/subagents/worker/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));
vi.mock("@/agent/subagents/worker/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.requireOwnedBrowserSession,
}));
vi.mock("@/agent/subagents/worker/lib/trace/domains", () => ({
  domainFromUrl: (url: string) => new URL(url).hostname,
  harvestBrowserTraceDomains: mocks.harvestBrowserTraceDomains,
}));

import manageBrowsers, {
  browserbaseContextKeyForWorkspace,
} from "@/agent/subagents/worker/tools/manage_browsers";

type BrowserPageOperation = (resources: {
  page: {
    goto: ReturnType<typeof vi.fn>;
    setViewportSize: ReturnType<typeof vi.fn>;
    viewportSize: () => { height: number; width: number };
  };
}) => Promise<object | undefined>;

interface WorkspaceScope {
  userId: string;
  workspaceId: string;
}

const browser = {
  contextId: "context-1",
  createdAt: "2026-08-27T00:00:00.000Z",
  expiresAt: "2026-08-27T01:00:00.000Z",
  id: "browser-1",
  keepAlive: true,
  projectId: "project-1",
  proxyBytes: 0,
  region: "us-east-1",
  startedAt: "2026-08-27T00:00:00.000Z",
  status: "RUNNING",
  updatedAt: "2026-08-27T00:00:00.000Z",
  userMetadata: { openinstinctProfileWriter: "false" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.listRemoteBrowsers.mockResolvedValue([
    {
      contextId: "context-1",
      createdAt: "2026-08-26T00:00:00.000Z",
    },
  ]);
  mocks.contextRetrieve.mockResolvedValue({ id: "context-1" });
  mocks.createBrowser.mockResolvedValue(browser);
  mocks.retrieveBrowser.mockResolvedValue(browser);
  mocks.debugBrowser.mockResolvedValue({
    debuggerFullscreenUrl: "https://www.browserbase.com/live/browser-1",
    pages: [],
  });
  mocks.withBrowserbasePage.mockImplementation(
    async (
      _sessionId: string,
      _signal: AbortSignal | undefined,
      operation: BrowserPageOperation
    ) =>
      operation({
        page: {
          goto: vi.fn(),
          setViewportSize: mocks.setViewportSize,
          viewportSize: () => ({ height: 720, width: 1280 }),
        },
      })
  );
  mocks.createBrowserSession.mockResolvedValue(undefined);
  mocks.deleteBrowserSession.mockResolvedValue(true);
  mocks.harvestBrowserTraceDomains.mockResolvedValue(undefined);
  mocks.listBrowserSessions.mockResolvedValue([]);
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: browser.createdAt,
    sessionId: browser.id,
    workerSessionId: "worker-session-1",
  });
  mocks.recordBrowserTraceDomains.mockResolvedValue(undefined);
  mocks.updateBrowser.mockResolvedValue({ ...browser, status: "COMPLETED" });
  mocks.withBrowserProfileWriteLock.mockImplementation(
    async (_scope: WorkspaceScope, operation: () => Promise<object>) =>
      operation()
  );
});

const workerContext = toolContextFor({ sessionId: "worker-session-1" });

describe("Browserbase browser contract", () => {
  it("keeps agent-created browsers alive for at least 15 minutes", () => {
    const inputSchema = manageBrowsers.inputSchema;
    if (!(inputSchema instanceof z.ZodType)) {
      throw new Error("manage_browsers must use a Zod input schema.");
    }
    expect(
      inputSchema.safeParse({ action: "create", timeout_seconds: 120 }).success
    ).toBe(false);
    expect(
      inputSchema.safeParse({ action: "create", timeout_seconds: 900 }).success
    ).toBe(true);
  });

  it("starts a Verified, CAPTCHA-solving, proxied browser in the workspace context", async () => {
    const result = await manageBrowsers.execute(
      { action: "create", start_url: "https://example.com/checkout" },
      workerContext
    );

    expect(result).toMatchObject({
      browser: {
        browser_live_view_url: "https://www.browserbase.com/live/browser-1",
      },
    });
    const createInput = z
      .object({
        browserSettings: z.object({
          context: z.object({
            id: z.literal("context-1"),
            persist: z.literal(false),
          }),
          solveCaptchas: z.literal(true),
          verified: z.literal(true),
        }),
        keepAlive: z.literal(true),
        proxies: z.array(
          z.object({
            geolocation: z.object({ country: z.literal("US") }),
            type: z.literal("browserbase"),
          })
        ),
      })
      .parse(mocks.createBrowser.mock.calls[0]?.[0]);
    expect(createInput).toMatchObject({
      browserSettings: {
        context: { id: "context-1", persist: false },
        solveCaptchas: true,
        verified: true,
      },
      keepAlive: true,
      proxies: [{ geolocation: { country: "US" }, type: "browserbase" }],
    });
    expect(mocks.createBrowser.mock.calls[0]?.[0]).not.toHaveProperty(
      "browserSettings.advancedStealth"
    );
    expect(mocks.createBrowser.mock.calls[0]?.[0]).not.toHaveProperty(
      "browserSettings.viewport"
    );
    expect(
      z
        .object({ maxRetries: z.literal(8) })
        .parse(mocks.createBrowser.mock.calls[0]?.[1])
    ).toEqual({ maxRetries: 8 });
    expect(mocks.createBrowserSession).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        createdAt: browser.createdAt,
        sessionId: browser.id,
        workerSessionId: "worker-session-1",
      }
    );
    expect(mocks.recordBrowserTraceDomains).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "worker-session-1",
      ["example.com"]
    );
    expect(mocks.withBrowserProfileWriteLock).not.toHaveBeenCalled();
  });

  it("accepts but does not apply viewport hints to Verified sessions", async () => {
    await manageBrowsers.execute(
      {
        action: "create",
        viewport_height: 720,
        viewport_width: 1280,
      },
      workerContext
    );

    expect(mocks.createBrowser).toHaveBeenCalledOnce();
    expect(mocks.createBrowser.mock.calls[0]?.[0]).not.toHaveProperty(
      "browserSettings.viewport"
    );
    expect(mocks.setViewportSize).not.toHaveBeenCalled();
  });

  it("harvests visited domains before releasing a session", async () => {
    mocks.requireOwnedBrowserSession.mockResolvedValue({
      createdAt: browser.createdAt,
      sessionId: browser.id,
      workerSessionId: "worker-session-9",
    });

    const result = await manageBrowsers.execute(
      { action: "delete", session_id: browser.id },
      workerContext
    );

    expect(result).toBe("Browser session deleted successfully");
    expect(mocks.harvestBrowserTraceDomains).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "worker-session-9",
      { createdAt: browser.createdAt, sessionId: browser.id },
      expect.any(AbortSignal)
    );
    expect(
      mocks.harvestBrowserTraceDomains.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.updateBrowser.mock.invocationCallOrder[0] ?? 0);
  });

  it("allows only one writable context browser", async () => {
    mocks.listBrowserSessions.mockResolvedValue([
      { createdAt: browser.createdAt, sessionId: "browser-active" },
    ]);
    mocks.retrieveBrowser.mockResolvedValueOnce({
      ...browser,
      id: "browser-active",
      userMetadata: { openinstinctProfileWriter: "true" },
    });

    await expect(
      manageBrowsers.execute(
        { action: "create", save_changes: true },
        toolContextFor()
      )
    ).rejects.toThrow(/browser-active.*saving login state/i);
    expect(mocks.createBrowser).not.toHaveBeenCalled();
    expect(mocks.withBrowserProfileWriteLock).toHaveBeenCalledOnce();
  });

  it("prunes stale owned records when Browserbase reports a missing session", async () => {
    mocks.listBrowserSessions.mockResolvedValue([
      { createdAt: browser.createdAt, sessionId: "stale-browser" },
    ]);
    mocks.retrieveBrowser.mockRejectedValue({ status: 404 });

    const result = await manageBrowsers.execute(
      { action: "list" },
      toolContextFor()
    );

    expect(result).toEqual({ has_more: false, items: [], next_offset: null });
    expect(mocks.deleteBrowserSession).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "stale-browser"
    );
  });

  it("derives opaque, stable, workspace-specific context keys", () => {
    const workspace = "personal:+15555550123";
    const key = browserbaseContextKeyForWorkspace(workspace);

    expect(key).toBe(browserbaseContextKeyForWorkspace(workspace));
    expect(key).toMatch(/^[a-f0-9]{40}$/u);
    expect(key).not.toContain("15555550123");
    expect(key).not.toBe(
      browserbaseContextKeyForWorkspace("personal:+15555550124")
    );
  });
});
