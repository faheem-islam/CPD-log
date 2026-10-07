import "server-only";
import { cookies } from "next/headers";

/** Local demo mode only: the cookie holds the random account id from the local database. */
export const LOCAL_COOKIE = "cpd_session";

export async function setLocalSessionCookie(id: string, secure: boolean): Promise<void> {
  const jar = await cookies();
  jar.set(LOCAL_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearLocalSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(LOCAL_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

export async function readLocalSessionCookie(): Promise<string | null> {
  const jar = await cookies();
  const v = jar.get(LOCAL_COOKIE)?.value;
  return v && v.length >= 8 && v.length <= 64 ? v : null;
}
