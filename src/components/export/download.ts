import { ApiClientError } from "@/lib/api/client";
import type { ApiErrorBody } from "@/lib/api/route-types";

/** The file name the server chose, from `attachment; filename="cpd-log-all-years-2026-10-08.xlsx"`. */
function fileNameFrom(header: string | null): string | null {
  if (!header) return null;
  const quoted = /filename="([^"]+)"/i.exec(header);
  const bare = /filename=([^;]+)/i.exec(header);
  const name = (quoted?.[1] ?? bare?.[1] ?? "").trim();
  // Only the last part, whatever the server sent: this becomes the name of a file on the person's device.
  const last = name.split(/[\\/]/).pop() ?? "";
  return last === "" ? null : last;
}

/**
 * Asks for the Excel file and hands it to the browser as a download.
 *
 * Why this is not api(): that helper reads every reply as JSON text, and a spreadsheet is binary. The rest of its
 * behaviour is kept: the same sign-in redirect when the session has ended, and a failure comes back as an
 * ApiClientError whose message can be shown as it is. Nothing here replaces the plain HTML form, which still posts to the
 * same route if script is off.
 */
export async function downloadExportFile(body: { profiles: string[]; year: number | "all" }): Promise<{ filename: string }> {
  let res: Response;
  try {
    res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiClientError("We couldn't reach the server. Check your connection and try again.", "network", 0);
  }

  if (res.status === 401) {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/sign-in?next=${encodeURIComponent(here)}`);
    throw new ApiClientError("You need to sign in again.", "unauthorised", 401);
  }

  if (!res.ok) {
    let err: ApiErrorBody["error"] | undefined;
    try {
      err = ((await res.json()) as ApiErrorBody | null)?.error;
    } catch {
      err = undefined;
    }
    throw new ApiClientError(
      err?.message ?? "We couldn't build the file. Try again in a moment.",
      err?.code ?? "internal",
      res.status,
      err?.retryAfterSeconds,
    );
  }

  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    throw new ApiClientError("The download was interrupted. Check your connection and try again.", "network", 0);
  }
  const filename = fileNameFrom(res.headers.get("Content-Disposition")) ?? "cpd-log.xlsx";

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start reading the file before the address is released.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { filename };
}
