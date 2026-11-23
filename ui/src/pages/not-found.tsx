import { ErrorAlert, usePageTitle } from "@/components/receipt-bits";
import { ApiError } from "@/lib/api";

export function NotFound() {
  usePageTitle("Not found");
  return <ErrorAlert error={new ApiError("There is no page at this address.", 404)} />;
}
