import browserbase from "@/agent/subagents/worker/browser-providers/browserbase/semantic-browser";
import kernel from "@/agent/subagents/worker/browser-providers/kernel/semantic-browser";
import { selectBrowserProvider } from "@/lib/browser-provider";

export default selectBrowserProvider({ browserbase, kernel });
