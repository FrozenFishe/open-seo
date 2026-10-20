import { useHydrated, useMatches } from "@tanstack/react-router";
import * as React from "react";

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
 * Renders the page itself once that is safe (see useRenderPageNow), and
 * `fallback` in the server HTML and during hydration otherwise. The same
 * element wraps the page in both cases, so switching between a server-rendered
 * page and a client-only one never remounts the tree.
 */
export function PageAfterHydration({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback: React.ReactNode;
}) {
  return <>{useRenderPageNow() ? children : fallback}</>;
}
