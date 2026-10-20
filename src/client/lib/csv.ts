import Papa from "papaparse";
import { normalizeExportValue, type CsvValue } from "./exportValue";

export type { CsvValue } from "./exportValue";

export function buildCsv(headers: string[], rows: CsvValue[][]): string {
  const normalizedRows = rows.map((row) =>
    row.map((value) => normalizeExportValue(value ?? "")),
  );

  return Papa.unparse(
    {
      fields: headers,
      data: normalizedRows,
    },
    {
      quotes: true,
      newline: "\n",
    },
  );
}
