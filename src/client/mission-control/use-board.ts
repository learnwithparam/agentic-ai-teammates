import { useCallback, useEffect, useRef, useState } from "react";
import { Board, get } from "./api";

// The board asks the server again every few seconds. The teammates run in other processes, so
// this is the one way the page learns that a run started or an approval arrived. A hidden tab
// stops asking, and asks at once when it is shown again.

const EVERY_MS = 4000;

type State = { board: Board | null; error: string | null; refresh: () => Promise<void> };

export function useBoard(): State {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setBoard(await get("/api/board", Board));
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, EVERY_MS);
    const onShow = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [refresh]);

  return { board, error, refresh };
}
