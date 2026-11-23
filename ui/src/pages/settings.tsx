import type { SettingsResponse } from "@api";
import { AlertCircleIcon, CheckIcon, CopyIcon, PlugIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { ErrorAlert, PageTitle, ToneBadge, usePageTitle } from "@/components/receipt-bits";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/lib/api";

// The OAuth callback sends back a fixed code, never free text.
const OAUTH_ERRORS: Record<string, string> = {
  invalid: "The sign-in link is not valid or has expired. Start again.",
  no_code: "FreeAgent did not give an authorisation code. Start again.",
};

export function SettingsPage() {
  usePageTitle("Settings");
  const { data, error } = useApi<SettingsResponse>("/api/settings");
  const [params, setParams] = useSearchParams();
  const oauth = params.get("oauth");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (oauth === "connected") {
      toast.success("FreeAgent is connected");
      setParams({}, { replace: true });
    }
  }, [oauth, setParams]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy. Select the address and copy it by hand.");
    }
  };

  return (
    <>
      <PageTitle>Settings</PageTitle>
      {error && <ErrorAlert error={error} />}
      {oauth && OAUTH_ERRORS[oauth] && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircleIcon aria-hidden />
          <AlertTitle>FreeAgent was not connected</AlertTitle>
          <AlertDescription>{OAUTH_ERRORS[oauth]}</AlertDescription>
        </Alert>
      )}
      {!error && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle><h2>Forwarding address</h2></CardTitle>
              <CardDescription>Forward receipt emails here. Keep it private: anyone who knows it can send receipts in.</CardDescription>
            </CardHeader>
            <CardContent>
              {!data ? <Skeleton className="h-9 w-full" /> : data.forwardAddress ? (
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 rounded-md border bg-muted px-3 py-2 text-sm break-all">{data.forwardAddress}</code>
                  <Button variant="outline" size="icon" onClick={() => copy(data.forwardAddress!)} aria-label={copied ? "Copied" : "Copy address"}>
                    {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                  </Button>
                </div>
              ) : <p className="text-sm text-muted-foreground">Not set.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <h2>FreeAgent</h2>
                {data && <ToneBadge tone={data.connected ? "ok" : "warn"}>{data.connected ? "Connected" : "Not connected"}</ToneBadge>}
              </CardTitle>
              <CardDescription className="break-all">{data?.baseUrl ?? " "}</CardDescription>
            </CardHeader>
            <CardFooter className="mt-auto">
              {/* a full-page link, not fetch: the browser must follow the redirect to FreeAgent */}
              <Button asChild variant={data?.connected ? "outline" : "default"}>
                <a href="/oauth/start"><PlugIcon aria-hidden />{data?.connected ? "Reconnect FreeAgent" : "Connect FreeAgent"}</a>
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}
    </>
  );
}
