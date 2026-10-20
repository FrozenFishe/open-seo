import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getSessionCookie } from "better-auth/cookies";
import { useEffect, useState } from "react";
import {
  AuthPageShell,
  authRedirectSearchSchema,
} from "@/client/features/auth/AuthPage";
import { useSession } from "@/lib/auth-client";
import { PageLoading } from "@/client/components/Spinner";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { getCurrentAuthRedirect, isDocumentRoute } from "@/lib/auth-redirect";

// True only on the server, for a request with no session cookie: that visitor
// is certainly signed out, so the server HTML can carry the form instead of
// the session spinner. On the client the session check decides, as before.
const requestHasNoSessionCookie = createIsomorphicFn()
  .server(() => !getSessionCookie(getRequest()))
  .client(() => false);

export const Route = createFileRoute("/_auth")({
  staticData: { renderOnServer: true },
  validateSearch: authRedirectSearchSchema,
  // A loader, not beforeLoad: its result is sent with the HTML, so the
  // hydrating client renders the same form the server did.
  loader: () => ({ signedOutAtRequest: requestHasNoSessionCookie() }),
  component: AuthPageLayout,
});

function AuthPageLayout() {
  const search = Route.useSearch();
  const { signedOutAtRequest } = Route.useLoaderData();
  const navigate = useNavigate();
  const { data: session, isPending } = useSession();
  const [hasResolvedSession, setHasResolvedSession] = useState(false);
  const isHostedMode = isHostedClientAuthMode();
  const redirectTo = getCurrentAuthRedirect(search.redirect);

  useEffect(() => {
    if (!isPending) setHasResolvedSession(true);
  }, [isPending]);

  useEffect(() => {
    if (!session?.user?.id) {
      return;
    }

    // Already authenticated: hand off to the destination. If the user is
    // unverified, that route's useHostedAuthRouteGuard bounces them to
    // /verify-email — this layout doesn't duplicate that rule.
    //
    // A document route (a report at /r/<id>) has no client component, so an SPA
    // navigation there would render an empty shell; ask for a real page load.
    void navigate({
      href: redirectTo,
      replace: true,
      reloadDocument: isDocumentRoute(redirectTo),
    });
  }, [navigate, redirectTo, session?.user?.id]);

  // Loading the session, or handing a signed-in user off to the destination.
  if (
    isHostedMode &&
    ((isPending && !hasResolvedSession && !signedOutAtRequest) ||
      session?.user?.id)
  ) {
    return <PageLoading />;
  }

  return (
    <AuthPageShell>
      <Outlet />
    </AuthPageShell>
  );
}
