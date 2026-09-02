/* oxlint-disable vitest/require-mock-type-parameters -- The Playwright fixture is intentionally limited to the surface exercised by the tool. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toolContextFor } from "@/tests/helpers/tool-context";

type ComputerPageOperation = (resources: {
  context: { grantPermissions: ReturnType<typeof vi.fn> };
  page: {
    evaluate: ReturnType<typeof vi.fn>;
    keyboard: {
      down: ReturnType<typeof vi.fn>;
      press: ReturnType<typeof vi.fn>;
      type: ReturnType<typeof vi.fn>;
      up: ReturnType<typeof vi.fn>;
    };
    mouse: {
      click: ReturnType<typeof vi.fn>;
      move: ReturnType<typeof vi.fn>;
      wheel: ReturnType<typeof vi.fn>;
    };
    url: () => string;
  };
}) => Promise<object>;

const mocks = vi.hoisted(() => ({
  click: vi.fn(),
  evaluate: vi.fn(),
  grantPermissions: vi.fn(),
  keyboardType: vi.fn(),
  mouseMove: vi.fn(),
  mouseWheel: vi.fn(),
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
vi.mock("@/lib/browserbase-playwright", () => ({
  withBrowserbasePage: mocks.withBrowserbasePage,
}));

import computerAction from "@/agent/subagents/worker/browser-providers/browserbase/computer-action";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: "2026-08-31T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-session-1",
  });
  mocks.evaluate.mockResolvedValue("clipboard value");
  mocks.withBrowserbasePage.mockImplementation(
    async (
      _sessionId: string,
      _signal: AbortSignal | undefined,
      operation: ComputerPageOperation
    ) =>
      operation({
        context: { grantPermissions: mocks.grantPermissions },
        page: {
          evaluate: mocks.evaluate,
          keyboard: {
            down: vi.fn(),
            press: vi.fn(),
            type: mocks.keyboardType,
            up: vi.fn(),
          },
          mouse: {
            click: mocks.click,
            move: mocks.mouseMove,
            wheel: mocks.mouseWheel,
          },
          url: () => "https://example.com",
        },
      })
  );
});

describe("worker browser tools", () => {
  it("requires the payload belonging to each coordinate action", () => {
    if (!(computerAction.inputSchema instanceof z.ZodType)) {
      throw new Error("computer_action must expose a Zod input schema.");
    }

    expect(
      computerAction.inputSchema.safeParse({
        actions: [{ type: "scroll" }],
        session_id: "browser-1",
      }).success
    ).toBe(false);
    expect(
      computerAction.inputSchema.safeParse({
        actions: [{ scroll: { x: 10, y: 20, delta_y: 4 }, type: "scroll" }],
        session_id: "browser-1",
      }).success
    ).toBe(true);
  });

  it("executes Browserbase computer actions in order and returns observations", async () => {
    const result = await computerAction.execute(
      {
        actions: [
          { click_mouse: { x: 10, y: 20 }, type: "click_mouse" },
          { type: "type_text", type_text: { text: "hello" } },
          { type: "read_clipboard" },
          { scroll: { x: 10, y: 20, delta_y: 4 }, type: "scroll" },
        ],
        session_id: "browser-1",
      },
      toolContextFor()
    );

    expect(mocks.click).toHaveBeenCalledWith(10, 20, {
      button: "left",
      clickCount: 1,
    });
    expect(mocks.keyboardType).toHaveBeenCalledWith("hello", {
      delay: undefined,
    });
    expect(mocks.grantPermissions).toHaveBeenCalledWith(
      ["clipboard-read", "clipboard-write"],
      { origin: "https://example.com" }
    );
    expect(mocks.mouseWheel).toHaveBeenCalledWith(0, 4);
    expect(result).toMatchObject({ data: ["clipboard value"] });
  });
});
