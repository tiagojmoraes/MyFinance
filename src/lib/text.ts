/**
 * Normalização de texto e similaridade fuzzy (Passo 3 da hierarquia de produtos v7).
 * Threshold da spec: Levenshtein > 0.90 OU Jaro-Winkler > 0.92.
 */

/** Normaliza: lowercase, remove acentos, colapsa espaços duplos/trim. */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Distância de Levenshtein (DP clássico, duas linhas). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/** Similaridade Levenshtein em [0,1]. */
export function levenshteinSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

/** Similaridade Jaro em [0,1]. */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aFlags = new Array<boolean>(a.length).fill(false);
  const bFlags = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (!bFlags[j] && a[i] === b[j]) {
        aFlags[i] = true;
        bFlags[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (aFlags[i]) {
      while (!bFlags[k]) k++;
      if (a[i] !== b[k]) transpositions++;
      k++;
    }
  }
  transpositions /= 2;
  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

/** Jaro-Winkler com escala de prefixo 0.1 (máx 4 chars), boost threshold 0.7. */
export function jaroWinkler(a: string, b: string): number {
  const jaroScore = jaro(a, b);
  if (jaroScore < 0.7) return jaroScore;
  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  return jaroScore + prefix * 0.1 * (1 - jaroScore);
}

export const FUZZY_LEVENSHTEIN_THRESHOLD = 0.9;
export const FUZZY_JARO_WINKLER_THRESHOLD = 0.92;

/** Regra da spec: Levenshtein > 0.90 OU Jaro-Winkler > 0.92 (sobre textos normalizados). */
export function isFuzzyMatch(candidate: string, target: string): boolean {
  const c = normalizeText(candidate);
  const t = normalizeText(target);
  if (!c || !t) return false;
  return (
    levenshteinSimilarity(c, t) > FUZZY_LEVENSHTEIN_THRESHOLD ||
    jaroWinkler(c, t) > FUZZY_JARO_WINKLER_THRESHOLD
  );
}

/** Score composto para heurística de desempate do OFX (memo + proximidade de data). */
export function memoSimilarity(memo: string | null | undefined, description: string | null | undefined): number {
  const m = normalizeText(memo);
  const d = normalizeText(description);
  if (!m || !d) return 0;
  return Math.max(jaroWinkler(m, d), levenshteinSimilarity(m, d));
}

// ═══════════════════════════════════════════════════════════════════════════
// v37 — TABELA DA VERDADE: similaridade por TOKENS de produto
//
// O fuzzy v7 (max(lev, jw) sobre a string inteira) confunde "MANGA PALMER"
// com "MANGA TOMMY"? Não com scores compostos. A v37 compara PRODUTOS:
//  · descarta tokens de ruído (unidades kg/g/ml/un, embalagem, artigos);
//  · descarta números curtos (gramatura/"300" não é identidade);
//  · score = 0.65 · sequência (lev/jw dos tokens juntos) + 0.35 · Jaccard
//    (interseção de tokens) — exige que o NÚCLEO do nome coincida.
//
// Zonas de decisão (TABELA DA VERDADE):
//  · score >= FUZZY_AUTO_THRESHOLD -> UNIFICA sozinho (grava a decisão);
//  · score >= FUZZY_ASK_THRESHOLD  -> PERGUNTA (candidato na revisão);
//  · abaixo                        -> produto NOVO (classificar uma vez).
// ═══════════════════════════════════════════════════════════════════════════

/** Tokens que NÃO identificam produto (unidades, embalagem, conectivos). */
export const PRODUCT_NOISE_TOKENS = new Set([
  'kg', 'kgs', 'g', 'gr', 'grs', 'grama', 'gramas', 'quilo', 'quilos',
  'ml', 'l', 'lt', 'litro', 'litros', 'cl',
  'un', 'und', 'unid', 'unidade', 'unidades', 'cx', 'pc', 'pct', 'pcte',
  'fd', 'emb', 'embalagem', 'bdj', 'bj', 'bd', 'fr', 'frasco', 'lata', 'latas',
  'c', 's', 'com', 'sem', 'tipo', 'type', 'extra', 'granel',
]);

/**
 * Tokens de IDENTIDADE de um nome de produto (v37):
 * normaliza, remove ruído e números curtos ("300", "500" — gramatura/código).
 */
export function productTokens(input: string | null | undefined): string[] {
  const norm = normalizeText(input);
  if (!norm) return [];
  return norm
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !PRODUCT_NOISE_TOKENS.has(t))
    .filter((t) => !/^\d+$/.test(t) || t.length >= 6) // número longo = EAN no nome (identidade)
    .filter((t) => t.length > 1);
}

/** Score de igualdade de PRODUTO em [0,1] (v37 — tokens + sequência). */
export function productSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = productTokens(a);
  const tb = productTokens(b);
  if (!ta.length || !tb.length) {
    // sem tokens úteis (ex.: só "500G") — cai para o fuzzy clássico
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return 0;
    return Math.max(levenshteinSimilarity(na, nb), jaroWinkler(na, nb));
  }
  const ja = ta.join(' ');
  const jb = tb.join(' ');
  const seq = Math.max(levenshteinSimilarity(ja, jb), jaroWinkler(ja, jb));
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = new Set([...setA, ...setB]).size;
  const jac = union ? inter / union : 0;
  return 0.65 * seq + 0.35 * jac;
}

/** v37: >= isto UNIFICA sozinho (mesmo produto em lojas diferentes). */
export const FUZZY_AUTO_THRESHOLD = 0.94;
/** v37: >= isto PERGUNTA na revisão (candidato provável); abaixo, produto novo. */
export const FUZZY_ASK_THRESHOLD = 0.84;

/**
 * Nome curto para botões de diálogo (v7.0.6): trunca em `max` caracteres
 * com reticências para caber em "Excluir apenas este — {nome} - {valor}".
 */
export function truncateLabel(text: string | null | undefined, max = 20): string {
  const t = (text ?? '').trim();
  if (!t) return '—';
  if (t.length <= max) return t;
  return `${t.slice(0, max).trimEnd()}…`;
}

/**
 * Rótulo pt-BR da origem do lançamento (regra: app 100% em português — v10).
 * Os valores brutos do banco (source_system) são técnicos; na tela sempre
 * aparece o rótulo traduzido.
 */
export function sourceLabel(source: string | null | undefined): string {
  switch (source) {
    case 'MANUAL':
      return 'Manual';
    case 'RECURRENCE':
      return 'Fixa';
    case 'INSTALLMENT':
      return 'Parcelado';
    case 'OFX_BANK':
    case 'OFX_CARD':
      return 'OFX';
    case 'NFCE':
      return 'NFC-e';
    default:
      return source ?? '—';
  }
}
