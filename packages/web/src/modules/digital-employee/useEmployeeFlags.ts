import { useEffect, useState } from "react";
import { api } from "../../api/client.js";

export interface EmployeeFlags {
  dailyScan: boolean;
  schedules: boolean;
}

/** Stays off when the flags cannot be read: the schedule page then offers only what runs. */
export function useEmployeeFlags(): EmployeeFlags {
  const [flags, setFlags] = useState<EmployeeFlags>({ dailyScan: false, schedules: false });
  useEffect(() => {
    const controller = new AbortController();
    void api.getProductLinks(controller.signal)
      .then((config) => setFlags({ dailyScan: config.digitalEmployeeDailyScan === true, schedules: config.digitalEmployeeSchedules === true }))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return flags;
}
