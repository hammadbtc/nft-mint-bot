const IMMEDIATE_LABEL = "Runs immediately (mint is live)";
const UNAVAILABLE_LABEL = "Contract schedule unavailable";

export function formatContractTime(value: string | null): string {
  if (!value) return IMMEDIATE_LABEL;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return UNAVAILABLE_LABEL;

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}
