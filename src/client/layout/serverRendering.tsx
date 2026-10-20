import { useHydrated, useMatches } from "@tanstack/react-router";
import * as React from "react";
import { SkeletonPage } from "@/client/components/SkeletonPresets";
import { PageLoading } from "@/client/components/Spinner";
import { Skeleton } from "@/client/components/ui/skeleton";
import { LAST_PROJECT_KEY } from "@/client/lib/active-project";
import { isHostedClientAuthMode } from "@/lib/auth-mode";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /**
     * This route's component is safe to render on the server: it reads no
     * browser-only state (localStorage, window) during render and loads no
     * account data through the module-scoped query client. A page is server
     * rendered only when every route in its match chain sets this; the rest of
     * the app renders after hydration, behind the root fallback.
     */
    renderOnServer?: true;
  }
}

/**
 * Whether the current page renders on the server and during hydration, or only
 * once the client has hydrated. Most of the app reads localStorage and other
 * browser-only state synchronously during render, so it stays client-only;
 * the public auth and status screens opt in with `staticData.renderOnServer`
 * so their first paint arrives with the HTML.
 */
function useRenderPageNow() {
  const hydrated = useHydrated();
  const serverRenderable = useMatches({
    select: (matches) =>
      matches.length > 1 &&
      matches.every(
        (match, index) =>
          index === 0 || match.staticData.renderOnServer === true,
      ),
  });
  return hydrated || serverRenderable;
}

/**
 * Renders the page itself once that is safe (see useRenderPageNow), and a
 * loading stand-in in the server HTML and during hydration otherwise: the app
 * shell skeleton on app pages, a spinner elsewhere. The same element wraps the
 * page in both cases, so moving between a server-rendered page and a
 * client-only one never remounts the tree.
 */
export function PageAfterHydration({
  children,
}: {
  children: React.ReactNode;
}) {
  const renderPage = useRenderPageNow();
  const isAppPage = useMatches({
    select: (matches) => matches.some((match) => match.routeId === "/_app"),
  });
  if (renderPage) return <>{children}</>;
  return isAppPage ? <AppPageFallback /> : <PageLoading />;
}

// In hosted mode the app layout first shows a plain spinner unless this browser
// has opened a project (see the onboarding gate in the /_app route), so a new
// account on its way to onboarding never sees the app flash. The fallback has
// to make the same choice before any JavaScript runs, so this head script
// marks the document when a remembered project exists.
export const appShellHintScript = isHostedClientAuthMode()
  ? `try{if(localStorage.getItem(${JSON.stringify(LAST_PROJECT_KEY)}))document.documentElement.setAttribute("data-app-shell","")}catch(e){}`
  : null;

function AppPageFallback() {
  if (!appShellHintScript) return <AppShellSkeleton />;
  return (
    <>
      <div className="hidden [html[data-app-shell]_&]:contents">
        <AppShellSkeleton />
      </div>
      <div className="[html[data-app-shell]_&]:hidden">
        <PageLoading />
      </div>
    </>
  );
}

/**
 * Static stand-in for the app shell: the sidebar frame, the mobile top bar and
 * a page skeleton, laid out like AuthenticatedAppLayout so the hydrated shell
 * replaces it without a jump.
 */
function AppShellSkeleton() {
  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-sidebar">
      <aside
        aria-label="Sidebar"
        className="hidden w-60 shrink-0 flex-col gap-2 px-3 pt-3 md:flex"
      >
        <span className="px-1 pb-2 text-base font-semibold text-sidebar-foreground">
          OpenSEO
        </span>
        <Skeleton className="h-12 w-full" />
        <div className="mt-3 space-y-3">
          {Array.from({ length: 7 }, (_, index) => (
            <Skeleton key={index} className="h-4 w-36" />
          ))}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-background md:mt-2 md:rounded-tl-lg md:border-t md:border-l md:border-sidebar-border">
        <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1.5 md:hidden">
          <Skeleton className="size-7" />
          <span className="ml-1 font-semibold text-foreground">OpenSEO</span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <SkeletonPage />
        </div>
      </main>
    </div>
  );
}
