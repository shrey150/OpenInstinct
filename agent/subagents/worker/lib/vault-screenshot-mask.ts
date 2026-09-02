import type { Page } from "playwright-core";

export async function withVaultScreenshotMask<T>(
  page: Page,
  capture: () => Promise<T>
) {
  await setVaultScreenshotMask(page, "add");
  try {
    return await capture();
  } finally {
    await setVaultScreenshotMask(page, "remove").catch(() => undefined);
  }
}

async function setVaultScreenshotMask(page: Page, action: "add" | "remove") {
  const styleId = "vault-screenshot-mask";
  const selector = '[data-vault-secret="true"]';
  const frames = page.frames();
  await Promise.all(
    frames.map((frame) =>
      frame
        .evaluate(
          ({ action: operation, selector: vaultSelector, styleId: id }) => {
            const existing = document.getElementById(id);
            if (operation === "add") {
              if (existing) {
                const refs = Number.parseInt(
                  existing.dataset.vaultMaskRefs ?? "0",
                  10
                );
                existing.dataset.vaultMaskRefs = String(
                  (Number.isFinite(refs) ? refs : 0) + 1
                );
                return;
              }
              const style = document.createElement("style");
              style.id = id;
              style.dataset.vaultMaskRefs = "1";
              style.textContent = `${vaultSelector} { color: transparent !important; text-shadow: 0 0 8px black !important; -webkit-text-security: disc !important; }`;
              document.documentElement.append(style);
              return;
            }
            if (!existing) return;
            const refs = Number.parseInt(
              existing.dataset.vaultMaskRefs ?? "1",
              10
            );
            const remaining = Math.max(
              0,
              (Number.isFinite(refs) ? refs : 1) - 1
            );
            if (remaining > 0) {
              existing.dataset.vaultMaskRefs = String(remaining);
            } else {
              existing.remove();
            }
          },
          { action, selector, styleId }
        )
        .catch(() => undefined)
    )
  );
}
