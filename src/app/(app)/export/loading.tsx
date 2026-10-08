import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeader title="Export" intro="Download your log as an Excel file, after checking what is in it." />
      <PageBody>
        <LoadingRegion label="Loading your export options">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Skeleton className="h-64" />
            <Skeleton className="h-48" />
          </div>
        </LoadingRegion>
      </PageBody>
    </>
  );
}
