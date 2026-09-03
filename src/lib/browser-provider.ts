import { env } from "@/env";

export type BrowserProvider = "browserbase" | "kernel";

export const browserProvider: BrowserProvider = env.BROWSER_PROVIDER;

export function selectBrowserProvider<Browserbase, Kernel>(
  implementations: {
    readonly browserbase: Browserbase;
    readonly kernel: Kernel;
  },
  provider: BrowserProvider = browserProvider
): Browserbase | Kernel {
  return provider === "browserbase"
    ? implementations.browserbase
    : implementations.kernel;
}
