import { Browserbase } from "@browserbasehq/sdk";
import { env } from "@/env";

export const browserbase = new Browserbase({
  apiKey: env.BROWSERBASE_API_KEY,
  maxRetries: 4,
});

export const browserbaseProjectId = env.BROWSERBASE_PROJECT_ID;
