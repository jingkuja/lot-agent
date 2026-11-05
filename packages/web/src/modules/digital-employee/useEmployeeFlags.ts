import { useEffect, useState } from "react";
import { api } from "../../api/client.js";

export interface EmployeeFlags {
  ready: boolean;
  unified: boolean;
  workspace: boolean;
  dailyScan: boolean;
}

/** Both stay off when the flags cannot be read, which keeps the older interface usable. */
export function useEmployeeFlags(): EmployeeFlags {
  const [flags, setFlags] = useState<EmployeeFlags>({ ready: false, unified: false, workspace: false, dailyScan: false });
  useEffect(() => {
    const controller = new AbortController();
    void api.getProductLinks(controller.signal)
      .then((config) => setFlags({
        ready: true,
        unified: config.digitalEmployeeUnified === true,
        workspace: config.digitalEmployeeWorkspace === true,
        dailyScan: config.digitalEmployeeDailyScan === true,
      }))
      .catch(() => { if (!controller.signal.aborted) setFlags((current) => ({ ...current, ready: true })); });
    return () => controller.abort();
  }, []);
  return flags;
}
