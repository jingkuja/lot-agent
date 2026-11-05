import { useEffect, useState } from "react";
import { api } from "../../api/client.js";

/** Stays false when the flag cannot be read: the server still decides the real scope. */
export function useDigitalEmployeeUnified(enabled: boolean): boolean {
  const [unified, setUnified] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void api.getProductLinks(controller.signal)
      .then((config) => setUnified(config.digitalEmployeeUnified === true))
      .catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  return unified;
}
