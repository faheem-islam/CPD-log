import { redirect } from "next/navigation";
import { getOptionalContext } from "@/lib/auth/context";

export default async function Home() {
  const ctx = await getOptionalContext();
  redirect(ctx ? "/dashboard" : "/sign-in");
}
