import { Browserbase } from "@browserbasehq/sdk";
import { env } from "@/env";

let client: Browserbase | undefined;

export function getBrowserbase() {
  const apiKey = env.BROWSERBASE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "BROWSERBASE_API_KEY is required to use the Browserbase provider."
    );
  }
  client ??= new Browserbase({ apiKey, maxRetries: 4 });
  return client;
}

export function getBrowserbaseProjectId() {
  return env.BROWSERBASE_PROJECT_ID;
}
