import { useI18n } from "../../i18n/index.js";

/** In Chinese these two read as things you do with your employee, by its name; other languages keep plain labels. */
export function useEmployeeLabels(name: string) {
  const { locale, t } = useI18n();
  return locale === "zh"
    ? { schedule: `培养${name}`, assignments: `交给${name}` }
    : { schedule: t("工作安排"), assignments: t("任务分派") };
}
