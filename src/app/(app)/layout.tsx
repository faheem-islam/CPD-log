import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { requirePageContext } from "@/lib/auth/context";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageContext();
  return (
    <ToastProvider>
      <AppShell email={ctx.user.email} modeLabel={ctx.mode === "local" ? "Local demo mode" : undefined}>
        {children}
      </AppShell>
    </ToastProvider>
  );
}
