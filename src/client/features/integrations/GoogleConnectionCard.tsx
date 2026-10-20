import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import { QueryError } from "@/client/components/QueryState";
import { CardShell } from "@/client/components/CardShell";
import { PermissionHint } from "@/client/components/PermissionHint";
import { GoogleConnectedState } from "@/client/features/integrations/GoogleConnectedState";
import { GoogleLinkErrorAlert } from "@/client/features/integrations/GoogleLinkErrorAlert";
import { GoogleOAuthSetupWarning } from "@/client/features/integrations/GoogleOAuthSetupWarning";
import { GoogleProjectEmptyState } from "@/client/features/integrations/GoogleProjectEmptyState";
import {
  GooglePropertyPicker,
  type GooglePickerSelection,
} from "@/client/features/integrations/GooglePropertyPicker";
import {
  googleConnectionOptions,
  googleProviders,
  type GoogleConnection,
  type GoogleProvider,
} from "@/client/features/integrations/googleProviders";
import { useGooglePickerResume } from "@/client/features/integrations/useGooglePickerResume";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  dashboardGa4ReportOptions,
  dashboardGscReportOptions,
} from "@/client/features/dashboard/dashboardReportQueries";

/**
 * Connects one project to Search Console or Google Analytics: link a Google
 * account, pick a property, change it, or disconnect.
 */
export function GoogleConnectionCard({
  provider,
  projectId,
  onDismiss,
  dismissing = false,
  prominent,
}: {
  provider: GoogleProvider;
  projectId: string;
  /** Shows the connect button as a large primary call to action. */
  prominent?: boolean;
  /** Adds a Dismiss button while the project is not connected. */
  onDismiss?: () => void;
  dismissing?: boolean;
}) {
  const config = googleProviders[provider];
  const { Logo } = config;
  const queryClient = useQueryClient();
  const { picking, setPicking, linkAccount, linking } = useGooglePickerResume(
    provider,
    projectId,
  );
  const [selection, setSelection] =
    React.useState<GooglePickerSelection | null>(null);

  const connectionOptions = googleConnectionOptions(provider, projectId);
  const connectionKey = connectionOptions.queryKey;
  const connectionQuery = useQuery(connectionOptions);
  const connection = connectionQuery.data;
  const connectionUnavailable = connectionQuery.isError && !connection;
  const connected = Boolean(connection?.connected);
  const hasGrant = Boolean(connection?.currentUserHasGrant);
  const canManage = connection?.canManage === true;
  const needsGoogleOAuthSetup =
    connectionQuery.isSuccess && !connection?.googleOAuthConfigured;

  const reconnectRequired = useGrantRejected(provider, projectId, connection);

  const showPicker = picking ?? (!connected && hasGrant && canManage);
  const accountsKey = [config.accountsKey, projectId];
  const accountsQuery = useQuery({
    queryKey: accountsKey,
    queryFn: () => config.listAccounts(projectId),
    enabled: Boolean(showPicker && !needsGoogleOAuthSetup),
  });
  const accounts = accountsQuery.data?.accounts ?? [];
  const savedSelection = accountsQuery.data?.selected ?? null;
  const requiresReconnect = accounts.some(
    (account) => account.requiresReconnect,
  );

  React.useEffect(() => {
    if (!requiresReconnect) return;
    void queryClient.invalidateQueries({
      queryKey: googleConnectionOptions(provider, projectId).queryKey,
    });
    if (provider === "gsc")
      void queryClient.invalidateQueries({ queryKey: ["gscGrantStatus"] });
  }, [requiresReconnect, queryClient, provider, projectId]);

  React.useEffect(() => {
    if (picking && connected && !selection && savedSelection)
      setSelection(savedSelection);
  }, [savedSelection, selection, picking, connected]);

  const afterChange = () => {
    queryClient.removeQueries({ queryKey: accountsKey });
    void queryClient.invalidateQueries({ queryKey: connectionKey });
    for (const queryKey of config.dependentKeys(projectId))
      void queryClient.invalidateQueries({ queryKey });
    setPicking(false);
  };
  const setPropertyMutation = useMutation({
    meta: { errorToast: false },
    mutationFn: (selected: GooglePickerSelection) =>
      config.save(projectId, selected),
    onSuccess: (saved) => {
      queryClient.setQueryData(
        connectionKey,
        (current: GoogleConnection | undefined) =>
          current ? { ...current, ...saved } : current,
      );
      toast.success(`${config.name} connected`);
      afterChange();
    },
  });
  const disconnectMutation = useMutation({
    meta: { errorToast: false },
    mutationFn: () => config.disconnect(projectId),
    onSuccess: () => {
      toast.success(`${config.name} disconnected from this project`);
      queryClient.setQueryData(
        connectionKey,
        (current: GoogleConnection | undefined) =>
          current ? { ...current, connected: false } : current,
      );
      setSelection(null);
      afterChange();
    },
  });

  const changingConnection =
    setPropertyMutation.isPending || disconnectMutation.isPending || linking;
  const dismissButton = onDismiss ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      onClick={onDismiss}
      disabled={dismissing || changingConnection}
    >
      Dismiss
    </Button>
  ) : null;
  const handleConnect = () => void linkAccount(window.location.href);
  const startPicking = () => {
    setPropertyMutation.reset();
    disconnectMutation.reset();
    setSelection(null);
    setPicking(true);
  };

  return (
    <CardShell
      title={config.title}
      icon={<Logo className="size-5" />}
      action={
        connectionQuery.isPending || connectionUnavailable ? undefined : (
          <ConnectionStatusPill
            setupRequired={needsGoogleOAuthSetup}
            reconnectRequired={reconnectRequired}
            connected={connected}
          />
        )
      }
    >
      <GoogleLinkErrorAlert provider={provider} className="mb-4" />
      {connectionQuery.isPending ? (
        <div
          role="status"
          aria-label="Loading connection"
          className="space-y-3"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9 w-24" />
        </div>
      ) : connectionUnavailable ? (
        <QueryError
          error={connectionQuery.error}
          fallback="Couldn't check this project's connection."
          onRetry={() => void connectionQuery.refetch()}
          isRetrying={connectionQuery.isFetching}
        />
      ) : needsGoogleOAuthSetup ? (
        <div className="flex flex-1 flex-col items-start justify-between gap-3">
          <GoogleOAuthSetupWarning
            integrationName={config.name}
            docsUrl={config.docsUrl}
          />
          {dismissButton}
        </div>
      ) : connected && !picking ? (
        <div className="space-y-4">
          {reconnectRequired ? (
            <GoogleReconnectAlert
              canManage={canManage}
              linking={linking}
              onReconnect={handleConnect}
            />
          ) : null}
          <GoogleConnectedState
            property={connection?.property ?? ""}
            detail={connection?.propertyDetail}
            canManageAccounts={hasGrant}
            email={connection?.connectedByEmail}
            onChange={startPicking}
            onDisconnect={() => {
              setPropertyMutation.reset();
              disconnectMutation.mutate();
            }}
            disconnecting={disconnectMutation.isPending}
            disabled={linking}
            canManage={canManage}
          />
        </div>
      ) : showPicker ? (
        <fieldset disabled={changingConnection}>
          <GooglePropertyPicker
            provider={provider}
            readOnly={!canManage}
            linking={linking}
            loading={accountsQuery.isLoading}
            error={accountsQuery.isError}
            accounts={accounts}
            selection={selection}
            onSelect={setSelection}
            onSave={() => selection && setPropertyMutation.mutate(selection)}
            saving={setPropertyMutation.isPending}
            secondaryAction={{
              label: "Cancel",
              disabled: setPropertyMutation.isPending,
              onClick: () => {
                setPicking(false);
                setSelection(null);
                setPropertyMutation.reset();
              },
            }}
            onRetry={() => void accountsQuery.refetch()}
            onReconnect={handleConnect}
          />
          {connected ? null : dismissButton}
        </fieldset>
      ) : (
        <GoogleProjectEmptyState
          name={config.name}
          hasGrant={hasGrant}
          canManage={canManage}
          disabled={linking}
          prominent={prominent}
          onLink={handleConnect}
          onChoose={startPicking}
        >
          {dismissButton}
        </GoogleProjectEmptyState>
      )}
      {setPropertyMutation.isError || disconnectMutation.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {getStandardErrorMessage(
            setPropertyMutation.error ?? disconnectMutation.error,
          )}
        </p>
      ) : null}
      {connectionQuery.isSuccess && !needsGoogleOAuthSetup && !canManage ? (
        <PermissionHint
          action="change this project's connection"
          className="mt-3"
        />
      ) : null}
    </CardShell>
  );
}

/** Whether Google rejects this saved connection. A dead grant (revoked,
 *  expired, or lost property access) is only learned from a report call, so
 *  read the dashboard's cached report rather than calling Google again. An
 *  invalidated result predates the latest change and no longer counts. */
function useGrantRejected(
  provider: GoogleProvider,
  projectId: string,
  connection: GoogleConnection | undefined,
): boolean {
  const queryClient = useQueryClient();
  const reportKey =
    provider === "gsc"
      ? dashboardGscReportOptions(projectId, connection?.property ?? null)
          .queryKey
      : dashboardGa4ReportOptions(projectId).queryKey;
  const cachedReport = useQuery<{ connected: boolean }>({
    queryKey: reportKey,
    enabled: false,
  }).data;
  return (
    connection?.connected === true &&
    cachedReport?.connected === false &&
    !queryClient.getQueryState(reportKey)?.isInvalidated
  );
}

function GoogleReconnectAlert({
  canManage,
  linking,
  onReconnect,
}: {
  canManage: boolean;
  linking: boolean;
  onReconnect: () => void;
}) {
  return (
    <Alert variant="warning">
      <AlertTriangle className="size-4" />
      <AlertTitle>Google rejected this connection</AlertTitle>
      <AlertDescription>
        <p>
          The access was revoked or expired, or the Google account lost access
          to this property. Reconnect to see your data again.
        </p>
        {canManage ? (
          <Button
            size="sm"
            className="mt-2"
            onClick={onReconnect}
            disabled={linking}
          >
            {linking ? "Opening Google…" : "Reconnect Google account"}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function ConnectionStatusPill({
  setupRequired,
  reconnectRequired,
  connected,
}: {
  setupRequired: boolean;
  reconnectRequired: boolean;
  connected: boolean;
}) {
  const [label, variant] = setupRequired
    ? (["Setup required", "warning"] as const)
    : reconnectRequired
      ? (["Reconnect needed", "warning"] as const)
      : connected
        ? (["Connected", "success"] as const)
        : (["Not connected", "outline"] as const);
  return (
    <Badge variant={variant}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
