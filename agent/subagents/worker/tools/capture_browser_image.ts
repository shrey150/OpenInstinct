import browserbase from "@/agent/subagents/worker/browser-providers/browserbase/capture-browser-image";
import kernel from "@/agent/subagents/worker/browser-providers/kernel/capture-browser-image";
import { selectBrowserProvider } from "@/lib/browser-provider";

export default selectBrowserProvider({ browserbase, kernel });
