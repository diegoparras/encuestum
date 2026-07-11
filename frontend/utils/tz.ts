// Conversión entre instantes UTC (lo que se guarda) y la "hora de pared" en una
// zona IANA fija (la que configura el operador en ENCUESTUM_TIMEZONE). Así las
// fechas de apertura/cierre se ingresan y muestran siempre en esa zona, sin
// importar el navegador de cada quien. Usa Intl, sin dependencias extra.

// Minutos que la zona `tz` está adelantada respecto de UTC en el instante `date`.
function tzOffsetMinutes(date: Date, tz: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
    let hour = Number(map.hour);
    if (hour === 24) hour = 0; // algunos motores devuelven "24" a medianoche
    const asUTC = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      hour,
      Number(map.minute),
      Number(map.second)
    );
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch {
    return 0; // zona inválida → tratar como UTC
  }
}

// UTC ISO → valor para <input type="datetime-local"> ("YYYY-MM-DDTHH:mm") en `tz`.
export function utcToLocalInput(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const shifted = new Date(d.getTime() + tzOffsetMinutes(d, tz) * 60000);
  return shifted.toISOString().slice(0, 16);
}

// Valor del <input datetime-local> (hora de pared en `tz`) → UTC ISO.
export function localInputToUtc(local: string, tz: string): string | null {
  if (!local) return null;
  const [datePart, timePart] = local.split("T");
  if (!datePart || !timePart) return null;
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) return null;
  const guessUTC = Date.UTC(y, mo - 1, d, h, mi);
  const off = tzOffsetMinutes(new Date(guessUTC), tz);
  return new Date(guessUTC - off * 60000).toISOString();
}

// Etiqueta corta de la zona (ej. "GMT-3") para mostrar junto a los campos.
export function tzLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date(0));
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    return name || tz;
  } catch {
    return tz;
  }
}
