import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeader title="Settings" intro="Your details for the ICE export, the logs you keep, and how the app looks." />
      <PageBody>
        <LoadingRegion label="Loading your settings">
          <div className="space-y-4">
            <Skeleton className="h-72" />
            <Skeleton className="h-56" />
          </div>
        </LoadingRegion>
      </PageBody>
    </>
  );
}
