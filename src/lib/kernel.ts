import Kernel from "@onkernel/sdk";
import { env } from "@/env";

let client: Kernel | undefined;

export function getKernel() {
  const apiKey = env.KERNEL_API_KEY;
  if (!apiKey) {
    throw new Error("KERNEL_API_KEY is required to use the Kernel provider.");
  }
  client ??= new Kernel({ apiKey });
  return client;
}
