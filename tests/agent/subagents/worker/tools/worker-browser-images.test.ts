/* oxlint-disable vitest/require-mock-type-parameters -- The fixtures implement only the Playwright surface exercised by the image tool. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { toolContextFor } from "@/tests/helpers/tool-context";

type ImagePageOperation = (resources: {
  context: { request: { get: ReturnType<typeof vi.fn> } };
  page: {
    locator: () => {
      evaluate: ReturnType<typeof vi.fn>;
      first: () => object;
      screenshot: ReturnType<typeof vi.fn>;
      waitFor: ReturnType<typeof vi.fn>;
    };
    screenshot: ReturnType<typeof vi.fn>;
  };
}) => Promise<object>;

const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const image = {
  byteSize: png.byteLength,
  filename: "Product.png",
  id: artifactId,
  label: "Product",
  mediaType: "image/png" as const,
  url: `/artifacts/${artifactId}`,
};

const mocks = vi.hoisted(() => ({
  del: vi.fn(),
  imageBody: vi.fn(),
  imageEvaluate: vi.fn(),
  imageGet: vi.fn(),
  imageOk: vi.fn(),
  imageStatus: vi.fn(),
  locatorScreenshot: vi.fn(),
  locatorWaitFor: vi.fn(),
  mask: vi.fn(),
  pageScreenshot: vi.fn(),
  persist: vi.fn(),
  put: vi.fn(),
  reserve: vi.fn(),
  requireOwnedBrowserSession: vi.fn(),
  requireWorkerScope: vi.fn(),
  withBrowserbasePage: vi.fn(),
}));

vi.mock("@/agent/subagents/worker/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));
vi.mock("@/agent/subagents/worker/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.requireOwnedBrowserSession,
}));
vi.mock("@/agent/subagents/worker/lib/vault-screenshot-mask", () => ({
  withBrowserbaseVaultScreenshotMask: mocks.mask,
}));
vi.mock("@/lib/browserbase-playwright", () => ({
  withBrowserbasePage: mocks.withBrowserbasePage,
}));
vi.mock("@/db/services/browser-images", () => ({
  finalizeBrowserImageArtifact: mocks.persist,
  reserveBrowserImageArtifact: mocks.reserve,
}));
vi.mock("@vercel/blob", () => ({ del: mocks.del, put: mocks.put }));

import captureBrowserImage from "@/agent/subagents/worker/browser-providers/browserbase/capture-browser-image";

const scope = { userId: "user-1", workspaceId: "workspace-1" };
const reservation = {
  id: artifactId,
  storagePathname: `browser-images/workspace/${artifactId}`,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue(scope);
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: "2026-08-31T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-session-1",
  });
  mocks.reserve.mockResolvedValue({ reservation, status: "pending" });
  mocks.persist.mockResolvedValue({ image, storagePathname: "stored/image" });
  mocks.del.mockResolvedValue(undefined);
  mocks.put.mockResolvedValue({ pathname: "stored/image" });
  mocks.mask.mockImplementation(
    async (_page: Page, capture: () => Promise<Buffer>) => capture()
  );
  mocks.pageScreenshot.mockResolvedValue(png);
  mocks.locatorScreenshot.mockResolvedValue(png);
  mocks.locatorWaitFor.mockResolvedValue(undefined);
  mocks.imageEvaluate.mockResolvedValue(
    "https://images.example/product.png?private=ignored"
  );
  mocks.imageOk.mockReturnValue(true);
  mocks.imageStatus.mockReturnValue(200);
  mocks.imageBody.mockResolvedValue(png);
  mocks.imageGet.mockResolvedValue({
    body: mocks.imageBody,
    ok: mocks.imageOk,
    status: mocks.imageStatus,
  });
  mocks.withBrowserbasePage.mockImplementation(
    async (
      _sessionId: string,
      _signal: AbortSignal | undefined,
      operation: ImagePageOperation
    ) =>
      operation({
        context: { request: { get: mocks.imageGet } },
        page: {
          locator: () => ({
            evaluate: mocks.imageEvaluate,
            first() {
              return this;
            },
            screenshot: mocks.locatorScreenshot,
            waitFor: mocks.locatorWaitFor,
          }),
          screenshot: mocks.pageScreenshot,
        },
      })
  );
});

describe("capture_browser_image", () => {
  it("captures a masked viewport and returns only the artifact descriptor", async () => {
    const result = await captureBrowserImage.execute(
      {
        label: "Product",
        region: { height: 200, width: 300, x: 10, y: 20 },
        session_id: "browser-1",
        source: "viewport",
      },
      context()
    );

    expect(mocks.pageScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        clip: { height: 200, width: 300, x: 10, y: 20 },
        type: "png",
      })
    );
    expect(mocks.persist).toHaveBeenCalledWith(
      scope,
      reservation,
      expect.objectContaining({ sourceKind: "viewport" })
    );
    expect(result).toEqual({ image });
    expect(JSON.stringify(result)).not.toContain("base64");
  });

  it("captures full-page and element screenshots", async () => {
    await captureBrowserImage.execute(
      { label: "Full", session_id: "browser-1", source: "full_page" },
      context()
    );
    await captureBrowserImage.execute(
      {
        label: "Element",
        selector: "#landingImage",
        session_id: "browser-1",
        source: "element",
      },
      context()
    );

    expect(mocks.pageScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ fullPage: true })
    );
    expect(mocks.locatorScreenshot).toHaveBeenCalledOnce();
  });

  it("fetches an image resource through the Browserbase context", async () => {
    await captureBrowserImage.execute(
      {
        label: "Product",
        selector: "#landingImage",
        session_id: "browser-1",
        source: "image_resource",
      },
      context()
    );

    expect(mocks.imageGet).toHaveBeenCalledWith(
      "https://images.example/product.png?private=ignored",
      expect.objectContaining({ timeout: 20_000 })
    );
    expect(mocks.persist).toHaveBeenCalledWith(
      scope,
      reservation,
      expect.objectContaining({ sourceKind: "image_resource" })
    );
    expect(JSON.stringify(mocks.persist.mock.calls)).not.toContain(
      "private=ignored"
    );
  });

  it("falls back to an element screenshot when the resource is blocked", async () => {
    mocks.imageOk.mockReturnValue(false);
    mocks.imageStatus.mockReturnValue(403);

    await captureBrowserImage.execute(
      {
        label: "Product",
        selector: "#landingImage",
        session_id: "browser-1",
        source: "image_resource",
      },
      context()
    );

    expect(mocks.locatorScreenshot).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenCalledWith(
      scope,
      reservation,
      expect.objectContaining({ sourceKind: "element" })
    );
  });

  it("reuses a ready idempotent artifact without another capture", async () => {
    mocks.reserve.mockResolvedValue({ image, status: "ready" });

    const result = await captureBrowserImage.execute(
      { label: "Product", session_id: "browser-1", source: "viewport" },
      context()
    );

    expect(result).toEqual({ image });
    expect(mocks.withBrowserbasePage).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});

function context(abortSignal?: AbortSignal) {
  return toolContextFor({
    abortSignal: abortSignal ?? new AbortController().signal,
    callId: "call-image",
    parentSessionId: "root-session",
    sessionId: "worker-session",
    toolName: "capture_browser_image",
  });
}
