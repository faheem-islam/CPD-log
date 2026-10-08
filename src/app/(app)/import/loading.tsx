import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeader
        title="Import"
        intro="Bring in a CPD record you already keep in Excel or CSV. You check every row before anything is saved."
      />
      <PageBody>
        <LoadingRegion label="Loading the import page">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Skeleton className="h-72" />
            <Skeleton className="h-56" />
          </div>
        </LoadingRegion>
      </PageBody>
    </>
  );
}
