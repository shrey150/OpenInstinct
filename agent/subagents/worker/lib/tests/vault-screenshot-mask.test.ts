/* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- The page fixture implements the narrow frame-evaluation contract used by the masking helper. */
import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import {
  withBrowserbaseVaultScreenshotMask,
  withKernelVaultScreenshotMask,
} from "../vault-screenshot-mask";

const mocks = vi.hoisted(() => ({
  execute:
    vi.fn<
      (
        sessionId: string,
        body: { readonly code: string; readonly timeout_sec: number },
        options: { readonly signal?: AbortSignal }
      ) => Promise<{ readonly success: boolean }>
    >(),
}));

vi.mock("@/lib/kernel", () => ({
  getKernel: () => ({
    browsers: { playwright: { execute: mocks.execute } },
  }),
}));

describe("Vault screenshot masking", () => {
  it("removes the mask after capture cancellation", async () => {
    const evaluate = vi
      .fn<
        (
          pageFunction: () => void,
          payload: { action: "add" | "remove"; css: string; id: string }
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    // SAFETY: This fixture implements the sole Page method exercised by withVaultScreenshotMask.
    const page = { frames: () => [{ evaluate }] } as unknown as Page;

    await expect(
      withBrowserbaseVaultScreenshotMask(page, async () => {
        throw new Error("Capture cancelled");
      })
    ).rejects.toThrow("Capture cancelled");

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({ action: "add" });
    expect(evaluate.mock.calls[1]?.[1]).toMatchObject({ action: "remove" });
  });

  it("uses a reference-counted mask implementation", async () => {
    const evaluate = vi
      .fn<
        (
          pageFunction: () => void,
          payload: { action: "add" | "remove"; css: string; id: string }
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    // SAFETY: This fixture implements the sole Page method exercised by withVaultScreenshotMask.
    const page = { frames: () => [{ evaluate }] } as unknown as Page;

    await withBrowserbaseVaultScreenshotMask(page, async () => undefined);

    expect(evaluate.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ action: "add" }),
      expect.objectContaining({ action: "remove" }),
    ]);
    expect(String(evaluate.mock.calls[0]?.[0])).toContain("vaultMaskRefs");
  });

  it("removes the Kernel mask with a fresh request after cancellation", async () => {
    const controller = new AbortController();
    mocks.execute.mockResolvedValue({ success: true });

    await expect(
      withKernelVaultScreenshotMask(
        "browser-1",
        controller.signal,
        async () => {
          controller.abort();
          throw new Error("Capture cancelled");
        }
      )
    ).rejects.toThrow("Capture cancelled");

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[0]?.[2]).toEqual({
      signal: controller.signal,
    });
    expect(mocks.execute.mock.calls[1]?.[2]).toEqual({ signal: undefined });
  });
});
