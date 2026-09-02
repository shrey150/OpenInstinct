import browserbase from "@/agent/subagents/worker/browser-providers/browserbase/manage-browsers";
import kernel from "@/agent/subagents/worker/browser-providers/kernel/manage-browsers";
import { selectBrowserProvider } from "@/lib/browser-provider";

export default selectBrowserProvider({ browserbase, kernel });
