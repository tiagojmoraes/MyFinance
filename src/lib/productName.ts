/**
 * v100 — NOME SEMÂNTICO DOS PRODUTOS (pedido do usuário).
 *
 *  · EXIBIÇÃO  = "CAFÉ • GOURMET • 500G"  (MÁIÚSCULAS, com acento, com ` • `)
 *  · CHAVE     = "cafe gourmet 500g"        (minúsculas, sem acento, sem ` • `)
 *
 * Regras (conferidas com o prompt):
 *  · Usuário NÃO digita ` • `. O sistema quebra o nome em pedaços e remonta.
 *  · Nunca exibir nome sem ` • ` em Catálogo, Despensa, Lista de Compra e
 *    histórico. A partir daqui, `displayName()` é a única forma de renderizar.
 *  · A chave é derivada do nome em minúscula sem acento; comparar pela chave
 *    é estável mesmo se a exibição tiver acento/caixa diferentes.
 *  · Qualificadores: 1º termo = o que é; token de tamanho (500G, 1L, 12X350ML)
 *    vira seu próprio qualificador; os demais termos do meio viram UM
 *    qualificador (previsibilidade > criatividade — não inventa palavra).
 *
 * A função `displayProductName` é o ÚNICO ponto usado nas telas para mostrar
 * nome de produto. `productKey` é o ÚNICO ponto usado para casar/cruzar.
 */

const SIZE_RE = /^\d+(?:[,.]\d+)?(?:X\d+(?:[,.]\d+)?)?\s*(?:KG|G|GR|L|ML|MG|UN|UNID(?:ADE)?S?)$/i;
const CONTAGEM_RE = /^\d+\s*X\s*\d+(?:[,.]\d+)?\s*(?:G|ML|KG|L|MG)$/i;

/** Tira acentos (NFD), mantém caixa/dígitos/espaço/•. */
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/** Limpa texto cru (descrição da NF ou digitação do usuário). */
function cleanRaw(raw: string): string {
  return raw
    .replace(/\u2022/g, '*') // unifica bullets em marcador temporário
    .replace(/[|]/g, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Separa os Qualificadores EM CAIXA ALTA, com acento (forma de exibição). */
function qualifies(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    const upper = part.toUpperCase().trim();
    if (!upper) continue;
    out.push(upper);
  }
  return out;
}

/**
 * v100 — displayName a partir de QUALQUER texto cru.
 *  · "CAFÉ 500G" → "CAFÉ • 500G"
 *  · "CAFÉ TORRADO E MOÍDO 500G" → "CAFÉ • TORRADO MOÍDO • 500G"
 *  · "LEITE INTEGRAL 1L" → "LEITE • INTEGRAL • 1L"
 *  · "Papel Higiênico Folha Dupla c/ 12 rolos" → "PAPEL HIGIÊNICO • FOLHA DUPLA C • 12 ROLOS" ??
 *    Heurística simples: 1º termo = o que é; token de tamanho vai sozinho;
 *    o resto vira um qualificador único.
 */
export function displayName(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = cleanRaw(raw);
  if (!cleaned) return '';
  // Se já tem marcadores (vindo de re-edição do user), quebra por eles.
  const byStar = cleaned.split('*').map((s) => s.trim()).filter(Boolean);
  let tokens: string[] = [];
  if (byStar.length > 1) {
    tokens = byStar.flatMap((seg) => seg.split(/\s+/).filter(Boolean));
  } else {
    tokens = cleaned.split(/\s+/).filter(Boolean);
  }
  if (tokens.length === 0) return '';
  // 1º = o que é; tamanho separado; resto = um qualificador único.
  const noun = tokens[0];
  const rest = tokens.slice(1);
  const sizeIdx = rest.findIndex((t) => SIZE_RE.test(t) || CONTAGEM_RE.test(t));
  const sizeToken = sizeIdx >= 0 ? rest.splice(sizeIdx, 1)[0] : '';
  const mid = rest.join(' ');
  const quals = qualifies(mid ? [mid] : []).concat(sizeToken ? [sizeToken] : []);
  return qualifies([noun]).concat(quals).join(' • ');
}

/**
 * v100 — CHAVE interna (matching). Minúscula, sem acento, sem ` • `,
 * dígitos preservados, espaços colapsados. Único ponto usado para cruzar
 * nomes no banco.
 *
 *  · "CAFÉ • GOURMET • 500G" → "cafe gourmet 500g"
 *  · "ARROZ BRANCO 5KG" → "arroz branco 5kg"
 */
export function productKey(raw: string | null | undefined): string {
  if (!raw) return '';
  const noBullet = raw.replace(/\u2022/g, ' ').replace(/[*|_-]/g, ' ');
  const flat = stripAccents(noBullet).toLowerCase();
  return flat.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * v100 — separa os qualificadores em CAIXA ALTA (mesma forma que aparece na
 * exibição). Compare por posição; o 1º é o que é, os demais são qualificadores.
 */
export function qualifiers(display: string | null | undefined): string[] {
  if (!display) return [];
  return display.split('\u2022').map((q) => q.trim()).filter(Boolean);
}

/** v100 — similaridade ponderada POR QUALIFICADOR (mesma posição).
 *  Compara por posição; quanto mais qualificadores em comum na MESMA posição,
 *  maior a nota. 1º termo (o que é) vale mais.
 */
export function qualifierSimilarity(a: string, b: string): number {
  const qa = qualifiers(a).map(productKey);
  const qb = qualifiers(b).map(productKey);
  if (qa.length === 0 || qb.length === 0) return 0;
  const len = Math.max(qa.length, qb.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const A = qa[i] ?? '';
    const B = qb[i] ?? '';
    if (!A || !B) { sum += 0; continue; }
    if (A === B) { sum += 1; continue; }
    sum += Math.min(setJaccard(A, B), levenshteinSim(A, B));
  }
  return sum / len;
}

function setJaccard(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter(Boolean));
  const tb = new Set(b.split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (inter * 2) / (ta.size + tb.size);
}

function levenshteinSim(a: string, b: string): number {
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const dp: number[] = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return 1 - dp[n] / Math.max(m, n);
}

/**
 * v100 — editamento pelo usuário: o usuário digita o nome SEM bullet; a tela
 * e o salvamento passam por aqui antes de gravar, garantindo que o nome
 * sempre tenha ` • `.
 */
export function normalizeForSave(raw: string | null | undefined): string {
  return displayName(raw);
}

/** v100 — seletor de exibição universal para Catálogo/Despensa/Lista. */
export function displayProductName(raw: string | null | undefined): string {
  return displayName(raw);
}
