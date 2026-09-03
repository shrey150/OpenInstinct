import { describe, expect, it } from "vitest";
import { selectBrowserProvider } from "@/lib/browser-provider";

const implementations = {
  browserbase: { name: "browserbase" },
  kernel: { name: "kernel" },
};

describe("browser provider selection", () => {
  it("uses Kernel by default", () => {
    expect(selectBrowserProvider(implementations)).toBe(implementations.kernel);
  });

  it("selects Browserbase explicitly", () => {
    expect(selectBrowserProvider(implementations, "browserbase")).toBe(
      implementations.browserbase
    );
  });
});
