/** Keep catalog selection and inference requests in the same deployment mode. */
export function internationalModelsEnabled(): boolean {
  const value = Number(process.env.globle);
  return Number.isFinite(value) && value > 0;
}

export function gatewayModelHeaders(): Record<string, string> {
  return internationalModelsEnabled() ? { "X-Agent-Globle": "1" } : {};
}
