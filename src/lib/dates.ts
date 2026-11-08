/**
 * Utilitários de data — fuso America/Sao_Paulo (regra de corte de fatura).
 * Datas (DATE) são strings 'YYYY-MM-DD'; comparáveis lexicograficamente.
 * Datetimes (DATETIME) são ISO-8601 UTC ('2026-05-01T12:00:00.000Z').
 */

export type Ymd = string; // 'YYYY-MM-DD'
export type Ym = string; // 'YYYY-MM'

const TZ = 'America/Sao_Paulo';

const enCA = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** v26: monta 'YYYY-MM-DD' pelas PARTES — não depende do formato que o motor
 *  (Hermes/Android) devolve para o locale; cai para UTC-3 fixo se o fuso falhar. */
function ymdInSP(d: Date): Ymd {
  try {
    const parts = enCA.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    const y = get('year'), m = get('month'), day = get('day');
    if (y && m && day) return `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
  } catch {
    // segue para o fallback
  }
  const sp = new Date(d.getTime() - 3 * 3600 * 1000);
  return sp.toISOString().slice(0, 10);
}

/** Data de hoje no fuso de São Paulo. */
export function todaySP(): Ymd {
  return ymdInSP(new Date());
}

/** Converte um instante ISO-UTC na data local (São Paulo) 'YYYY-MM-DD'. */
export function spDateOfIso(iso: string): Ymd {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return ymdInSP(d);
}

/** Agora em ISO-UTC. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Extrai (ano, mês, dia) de 'YYYY-MM-DD'. */
export function partsOf(ymd: Ymd): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  return { y, m, d };
}

/** Último dia do mês (1-based month). */
export function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' de ano/mês/dia com clamp de dia. */
export function makeYmd(y: number, m: number, d: number): Ymd {
  const last = lastDayOfMonth(y, m);
  const dd = Math.min(Math.max(d, 1), last);
  const mm = String(m).padStart(2, '0');
  const ddd = String(dd).padStart(2, '0');
  return `${y}-${mm}-${ddd}`;
}

/** Soma n meses a 'YYYY-MM-DD', com clamp do dia (ex.: 31/01 + 1M => 28/02). */
export function addMonths(ymd: Ymd, n: number): Ymd {
  const { y, m, d } = partsOf(ymd);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return makeYmd(ny, nm, d);
}

/** 'YYYY-MM' de uma data. */
export function monthOf(ymd: Ymd): Ym {
  return ymd.slice(0, 7);
}

/** Soma n meses a 'YYYY-MM' (mantém 'YYYY-MM'). */
export function monthAdd(ym: Ym, n: number): Ym {
  const [y, m] = ym.split('-').map((x) => parseInt(x, 10));
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** Primeiro dia de um 'YYYY-MM'. */
export function firstDayOf(ym: Ym): Ymd {
  return `${ym}-01`;
}

/** Último dia de um 'YYYY-MM' como dia (número). */
export function lastDayNumberOf(ym: Ym): number {
  const [y, m] = ym.split('-').map((x) => parseInt(x, 10));
  return lastDayOfMonth(y, m);
}

/** Dia efetivo de fechamento: min(closing_day, último dia do mês). */
export function effectiveClosingDay(ym: Ym, closingDay: number): number {
  return Math.min(closingDay, lastDayNumberOf(ym));
}

/** 'YYYY-MM-DD' do dia d no mês ym (com clamp). */
export function dayInMonth(ym: Ym, day: number): Ymd {
  const [y, m] = ym.split('-').map((x) => parseInt(x, 10));
  return makeYmd(y, m, day);
}

/** Rótulo pt-BR de um 'YYYY-MM' (ex.: 'mai 2026'). */
export function monthLabel(ym: Ym): string {
  const [y, m] = ym.split('-').map((x) => parseInt(x, 10));
  const date = new Date(Date.UTC(y, m - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** Formata 'YYYY-MM-DD' como dd/mm/aaaa. */
export function ymdToBr(ymd: Ymd): string {
  const { y, m, d } = partsOf(ymd);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

/**
 * Converte texto digitado em 'YYYY-MM-DD' (padrão do sistema: dd/mm/aaaa).
 * Aceita: 'dd/mm/aaaa', 'ddmmyyyy' (máscara) e 'aaaa-mm-dd' (colar de fora).
 * Retorna null se incompleto ou data inválida (ex.: 31/02/2026).
 */
export function brToYmd(text: string): Ymd | null {
  const t = text.trim();
  if (!t) return null;
  let d: number, m: number, y: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const digits = /^(\d{2})(\d{2})(\d{4})$/.exec(t.replace(/\D/g, ''));
  if (iso) {
    y = +iso[1]; m = +iso[2]; d = +iso[3];
  } else if (br) {
    d = +br[1]; m = +br[2]; y = +br[3];
  } else if (digits && t.replace(/\D/g, '').length === 8) {
    d = +digits[1]; m = +digits[2]; y = +digits[3];
  } else {
    return null;
  }
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  if (d > lastDayOfMonth(y, m)) return null;
  return makeYmd(y, m, d);
}

/** Aplica máscara dd/mm/aaaa enquanto o usuário digita (só dígitos). */
export function maskBrDate(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/** Data de hoje como instante ISO ao meio-dia UTC (neutro para eventos sem hora). */
export function noonUtcIsoOf(ymd: Ymd): string {
  const { y, m, d } = partsOf(ymd);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).toISOString();
}

/** Intervalo de N dias atrás/adiante em 'YYYY-MM-DD'. */
export function addDays(ymd: Ymd, n: number): Ymd {
  const { y, m, d } = partsOf(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
