import { useI18n } from "../../../i18n/index.js";

export function TextRows({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  return <label className="marketing-form-wide">
    <span>{t(label)} <small>{t(hint)}</small></span>
    <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} />
  </label>;
}

export function splitLines(value: string): string[] {
  return value.split(/\n/).map((item) => item.trim()).filter(Boolean);
}

export function lines(value?: string[]): string {
  return value?.join("\n") ?? "";
}
