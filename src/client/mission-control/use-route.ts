import { useCallback, useEffect, useState } from "react";
import { parseRoute, pathFor, type Route } from "./route";

// The screen follows the address. Going to a screen adds it to the browser's history, so Back
// works; an old ?teammate= link is rewritten to its new address without adding a step.
export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname, window.location.search));

  useEffect(() => {
    const path = pathFor(route);
    if (window.location.pathname + window.location.search !== path) window.history.replaceState(null, "", path);
    const onBack = () => setRoute(parseRoute(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, [route]);

  const goTo = useCallback((next: Route) => {
    // A tab can report the same choice twice, on focus and on click; that is one step, not two.
    const path = pathFor(next);
    if (window.location.pathname + window.location.search !== path) window.history.pushState(null, "", path);
    setRoute(next);
  }, []);

  return [route, goTo];
}
