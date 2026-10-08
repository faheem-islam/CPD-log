import "server-only";
import { getOptionalContext } from "@/lib/auth/context";

/**
 * Whether the person reading a public page is signed in, so the page can offer the right way back. A failure to find
 * out is treated as signed out: these pages must always load.
 */
export async function isSignedIn(): Promise<boolean> {
  try {
    return (await getOptionalContext()) !== null;
  } catch {
    return false;
  }
}
