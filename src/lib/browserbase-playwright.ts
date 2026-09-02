import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { browserbase } from "@/lib/browserbase";

const lockTailsBySession = new Map<string, Promise<void>>();

export async function withBrowserbasePage<T>(
  sessionId: string,
  signal: AbortSignal | undefined,
  operation: (resources: {
    readonly browser: Browser;
    readonly context: BrowserContext;
    readonly page: Page;
  }) => Promise<T>
) {
  return withBrowserbaseSessionLock(sessionId, async () => {
    const remote = await browserbase.sessions.retrieve(sessionId, { signal });
    if (!remote.connectUrl || !isActiveBrowserbaseStatus(remote.status)) {
      throw new Error("Browserbase session is no longer active.");
    }

    const browser = await chromium.connectOverCDP(remote.connectUrl, {
      timeout: 30_000,
    });
    const abort = () => void browser.close().catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const context = browser.contexts()[0];
      if (!context)
        throw new Error("Browserbase session has no browser context.");
      const pages = context.pages();
      const page =
        pages.findLast((candidate) => candidate.url() !== "about:blank") ??
        pages.at(-1) ??
        (await context.newPage());
      return await operation({ browser, context, page });
    } finally {
      signal?.removeEventListener("abort", abort);
      await browser.close().catch(() => undefined);
    }
  });
}

export function isActiveBrowserbaseStatus(status: string) {
  return status === "PENDING" || status === "RUNNING";
}

async function withBrowserbaseSessionLock<T>(
  sessionId: string,
  operation: () => Promise<T>
) {
  const previous = lockTailsBySession.get(sessionId) ?? Promise.resolve();
  let release: () => void = noop;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  lockTailsBySession.set(sessionId, tail);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (lockTailsBySession.get(sessionId) === tail) {
      lockTailsBySession.delete(sessionId);
    }
  }
}

function noop() {
  return undefined;
}
