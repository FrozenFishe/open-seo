// Cell normalization shared by CSV export and copy-to-clipboard. Kept out of
// csv.ts so the clipboard path, which loads with the app shell, doesn't pull
// in papaparse.

export type CsvValue = string | number | boolean | null | undefined;

export type ExportValue = string | number | boolean;

export function normalizeExportValue(value: CsvValue): ExportValue {
  const normalized =
    typeof value === "number" ? roundExportNumber(value) : value;
  return sanitizeCsvValue(normalized ?? "");
}

function roundExportNumber(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Prevent CSV/TSV injection (formula injection) by prefixing dangerous
// characters with a single quote. See OWASP guidance:
// https://owasp.org/www-community/attacks/CSV_Injection
function sanitizeCsvValue(
  value: string | number | boolean,
): string | number | boolean {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  if (["=", "+", "-", "@", "\t", "\r", "\n"].includes(value[0])) {
    return `'${value}`;
  }

  return value;
}
