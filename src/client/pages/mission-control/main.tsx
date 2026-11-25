import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { get, SignedIn } from "@/mission-control/api";
import { App } from "@/mission-control/App";
import "@/styles/app.css";

// Who is signed in comes first. Without a session, the first call sends the person to sign in.
function Start() {
  const [me, setMe] = useState<SignedIn | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    get("/api/me", SignedIn)
      .then(setMe)
      .catch((error) => setProblem(error instanceof Error ? error.message : String(error)));
  }, []);
  if (!me) return <main className="grid min-h-svh place-items-center p-6 text-muted-foreground">{problem ?? "Signing you in."}</main>;
  return (
    <TooltipProvider>
      <App me={me} />
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element.");
createRoot(root).render(
  <StrictMode>
    <Start />
  </StrictMode>,
);
