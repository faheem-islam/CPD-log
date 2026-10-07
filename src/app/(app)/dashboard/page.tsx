import { requirePageContext } from "@/lib/auth/context";

export default async function DashboardPage() {
  const ctx = await requirePageContext();
  return <p className="p-6">Signed in as {ctx.user.email}</p>;
}
