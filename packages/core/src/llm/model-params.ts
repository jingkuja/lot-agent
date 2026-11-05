/** Models that accept only their own fixed temperature: any other value is a 400. */
const FIXED_TEMPERATURE_MODELS = new Set(["kimi-k3.1-pro"]);

/** Callers tune temperature per task without knowing the model, so it is dropped here. */
export function requestTemperature(model: string, temperature: number | undefined): number | undefined {
  return FIXED_TEMPERATURE_MODELS.has(model) ? undefined : temperature;
}
