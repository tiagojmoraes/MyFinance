/**
 * Parser OFX (Banking) — suporta OFX v1 (SGML) e v2 (XML).
 * Saída: linhas de extrato normalizadas (fitid, posted_on 'YYYY-MM-DD',
 * amount_cents inteiro, memo). Conciliação em si fica no OfxService (batch v7).
 *
 * v70 — ROBUSTEZ PARA OFX REAL (arquivo oficial do banco anexado pelo usuário):
 *  · MEMO "sujo" não quebra: aspas, GUIDs, cidades coladas no NAME, caracteres
 *    de controle, entidades HTML (&amp; &lt; …) e texto CP1252 lido como UTF-8
 *    (mojibake "FondatÃ§Ã£o" → "Fundação") são normalizados;
 *  · não depende de LEDGERBAL/AVAILBAL — arquivos sem os saldos finais (e sem
 *    BALAMT/DTASOF) parseiam normalmente;
 *  · DTPOSTED com hora, fuso (-0300) e sufixo entre colchetes ([−03:EST]);
 *  · blocos STMTTRN sem fechamento (SGML puro) e CRLF do Windows;
 *  · FITID único por importação (dedupeByFitid) + amarração por data+valor —
 *    reimportar arquivo atualizado NÃO duplica NFC-e, notificações lançadas
 *    nem lançamentos manuais (OfxService casa por valor + janela de datas).
 */

export interface OfxLine {
  fitid: string;
  postedOn: string | null; // 'YYYY-MM-DD'
  amountCents: number | null;
  memo: string;
  type: string | null; // TRNTYPE bruto
}

export interface ParsedOfx {
  lines: OfxLine[];
  errors: string[];
  currency: string | null;
  bankId: string | null;
  accountId: string | null;
}

/** Converte "123.45" | "-1.234,56" | "1.234,56" em centavos inteiros. */
export function parseOfxAmount(raw: string): number | null {
  let s = raw.trim().replace(/\s/g, '');
  if (!s) return null;
  // v70: o sinal vem separado — formato BR com milhar ("−1.234,56") não casa
  // na regex de positivo e caía na ramificação ambígua perdendo o milhar.
  const negativo = s.startsWith('-') || s.startsWith('(') && s.endsWith(')');
  s = s.replace(/^[-+]/, '').replace(/^\(/, '').replace(/\)$/, '');
  const brFormat = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s);
  if (brFormat) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',') && s.includes('.')) {
    // ambíguo: assume padrão OFX (ponto decimal)
    s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const value = Number.parseFloat(s);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) * (negativo ? -1 : 1);
}

/** DTPOSTED '20250101' | '20250101120000' | '20250101120000-0300' => '2025-01-01'. O OFX também aceita sufixo de fuso entre colchetes após a hora (ex.: -03:00). */
export function parseOfxDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo}-${d}`;
}

/**
 * v70 — normaliza o TEXTO do OFX (MEMO/NAME sujos de arquivo real):
 *  · entidades HTML do OFX v2 (&amp; &lt; &gt; &quot; &apos; &#NNN;);
 *  · mojibake de CP1252/ISO-8859-1 lido como UTF-8 ("Ã§Ã£o" → "ção") — o
 *    parser não pode quebrar nem entregar texto ilegível;
 *  · caracteres de controle e U+FFFD (byte inválido) viram espaço;
 *  · espaços repetidos colapsam.
 */
export function sanitizeOfxText(raw: string): string {
  if (!raw) return '';
  let s = raw
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => {
      const code = parseInt(d, 10);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ' ';
    });
  // Mojibake mais comum do pt-BR (CP1252 lido como UTF-8) — só as sequências
  // seguras; o que não casa permanece como veio (nunca derruba o parse).
  const mojibake: Array<[RegExp, string]> = [
    [/Ã£/g, 'ã'], [/Ã¡/g, 'á'], [/Ã /g, 'à'], [/Ã¢/g, 'â'], [/Ã©/g, 'é'],
    [/Ãª/g, 'ê'], [/Ã­/g, 'í'], [/Ã³/g, 'ó'], [/Ã´/g, 'ô'], [/Ãµ/g, 'õ'],
    [/Ãº/g, 'ú'], [/Ã§/g, 'ç'], [/Ã/g, 'Ã'], [/Ã/g, 'Á'], [/Ã/g, 'Ê'],
    [/Ã/g, 'Í'], [/Ã/g, 'Ó'], [/Ã/g, 'Ô'], [/Ã/g, 'Õ'], [/Ã/g, 'Ú'],
    [/Ã/g, 'Ç'],
  ];
  for (const [re, to] of mojibake) s = s.replace(re, to);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g, ' ');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function stripTagContent(text: string, tag: string): string | null {
  // Suporta SGML sem fechamento (<TAG>valor\n) e XML (<TAG>valor</TAG>)
  const re = new RegExp(`<${tag}>\\s*([^<\\r\\n]+)`, 'i');
  const m = text.match(re);
  // v70: MEMO/NAME sujos são normalizados (entidades, mojibake, controles)
  return m ? sanitizeOfxText(m[1]) : null;
}

/** Faz o parse de um arquivo OFX completo. */
export function parseOfx(content: string): ParsedOfx {
  const errors: string[] = [];
  const lines: OfxLine[] = [];

  // v70: aceita CRLF/CR do Windows e BOM — o banco gera como der na vontade.
  const normalizado = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  const blocks = normalizado.match(/<STMTTRN>([\s\S]*?)<\/STMTTRN>|<STMTTRN>([\s\S]*?)(?=<STMTTRN>|$)/gi) || [];
  for (const block of blocks) {
    const b = block.toUpperCase().includes('<STMTTRN>') ? block : block;
    const fitid = stripTagContent(b, 'FITID');
    const dtposted = stripTagContent(b, 'DTPOSTED');
    const trnamt = stripTagContent(b, 'TRNAMT');
    const memo = stripTagContent(b, 'MEMO') ?? stripTagContent(b, 'NAME') ?? '';
    const trntype = stripTagContent(b, 'TRNTYPE');

    if (!fitid) {
      errors.push(`Linha OFX sem FITID: ${b.slice(0, 60)}`);
      continue;
    }
    if (!dtposted || trnamt == null) {
      errors.push(`Linha OFX incompleta (FITID ${fitid})`);
      continue;
    }
    const amountCents = parseOfxAmount(trnamt);
    if (amountCents == null) {
      errors.push(`TRNAMT inválido (FITID ${fitid}): ${trnamt}`);
      continue;
    }
    lines.push({
      fitid,
      postedOn: parseOfxDate(dtposted),
      amountCents,
      memo,
      type: trntype,
    });
  }

  const currency =
    stripTagContent(content, 'CURDEF') ??
    stripTagContent(content, 'CURRENCY') ??
    null;
  const bankId = stripTagContent(content, 'BANKID');
  const accountId = stripTagContent(content, 'ACCTID');

  return { lines, errors, currency, bankId, accountId };
}

/** Dedup por fitid dentro do mesmo arquivo (mantém a primeira). */
export function dedupeByFitid(lines: OfxLine[]): { unique: OfxLine[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: OfxLine[] = [];
  let duplicates = 0;
  for (const line of lines) {
    if (seen.has(line.fitid)) {
      duplicates++;
      continue;
    }
    seen.add(line.fitid);
    unique.push(line);
  }
  return { unique, duplicates };
}

/** v54 — OFX de CARTÃO: <CCSTMTTRN> tem o mesmo formato de <STMTTRN>, mas o ACCTID é o cartão.
 *  Se o arquivo tem CCSTMTTRN, é cartão. Se tem STMTTRN, é conta. */
export function ofxKind(content: string): 'CARD' | 'BANK' | 'UNKNOWN' {
  const u = content.toUpperCase();
  if (u.includes('<CCSTMTTRN>') || u.includes('<CCACCTFROM>') || u.includes('<CREDITCARDMSGSRSV1>')) return 'CARD';
  if (u.includes('<STMTTRN>') || u.includes('<BANKMSGSRSV1>')) return 'BANK';
  return 'UNKNOWN';
}
/** v54 — extrai ACCTID do cartão (últimos 4) para amarrar ao cartão cadastrado. */
export function ofxCardLast4(content: string): string | null {
  const acct = stripTagContent(content, 'ACCTID');
  if (!acct) return null;
  const digits = acct.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}
