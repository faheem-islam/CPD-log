import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeader title="Your log" intro="Search every entry you've saved, change a detail, or take one out." />
      <PageBody>
        <LoadingRegion label="Loading your log">
          <div className="space-y-4">
            <Skeleton className="h-44 sm:h-40" />
            <Skeleton className="h-8 w-56" />
            <div className="space-y-3">
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </div>
          </div>
        </LoadingRegion>
      </PageBody>
    </>
  );
}
