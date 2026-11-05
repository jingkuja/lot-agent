import { useEffect, useState } from "react";
import { api } from "../../api/client.js";

/** Stays off when the flag cannot be read: the schedule page then offers only what runs. */
export function useEmployeeDailyScan(): boolean {
  const [dailyScan, setDailyScan] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api.getProductLinks(controller.signal)
      .then((config) => setDailyScan(config.digitalEmployeeDailyScan === true))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return dailyScan;
}
