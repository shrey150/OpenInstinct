/* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- The page fixture implements the narrow frame-evaluation contract used by the masking helper. */
import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { withVaultScreenshotMask } from "../vault-screenshot-mask";

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
      withVaultScreenshotMask(page, async () => {
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

    await withVaultScreenshotMask(page, async () => undefined);

    expect(evaluate.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ action: "add" }),
      expect.objectContaining({ action: "remove" }),
    ]);
    expect(String(evaluate.mock.calls[0]?.[0])).toContain("vaultMaskRefs");
  });
});
