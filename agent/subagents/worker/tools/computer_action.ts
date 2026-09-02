import browserbase from "@/agent/subagents/worker/browser-providers/browserbase/computer-action";
import kernel from "@/agent/subagents/worker/browser-providers/kernel/computer-action";
import { selectBrowserProvider } from "@/lib/browser-provider";

export default selectBrowserProvider({ browserbase, kernel });
