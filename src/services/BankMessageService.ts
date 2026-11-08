/**
 * BankMessageService (v69→v70) — IMPORTAÇÃO POR NOTIFICAÇÕES BANCÁRIAS.
 *
 * O usuário recebe no celular as NOTIFICAÇÕES do banco (não SMS): compra no
 * débito, compra no crédito, PIX enviado/recebido, assinatura, compra online —
 * Shopee, TikTok Shop, streaming etc. Exemplos REAIS (Banco Inter):
 *  · "Olá Tiago. Você acaba de comprar R$ 126,24 em TikTok Shop. A compra foi
 *    no crédito nacional, com o cartão final 6830."
 *  · "Olá Tiago, você acaba de comprar no débito SORVETERIA GYGABOM o valor de
 *    R$ 59,47."
 * O parser é GENÉRICO (não é preso a banco nem a nome de usuário): extrai
 * VALOR, LOCAL/LOJA, TIPO débito/crédito (forma de pagamento) e CARTÃO FINAL
 * quando houver. A notificação entra na LISTA pelo GRID das capturas da barra
 * do sistema (v71 — módulo nativo modules/bank-notifications; o botão "Colar
 * notificação" da v70 saiu, copiar/colar um por um era inviável) — NUNCA cria
 * lançamento sozinho: cada uma fica esperando o usuário decidir "Lançar" (abre
 * o Novo Lançamento já preenchido, distinguindo débito/crédito) ou "Excluir"
 * (sai do grid/lista).
 *
 * CONCILIAÇÃO COM OFX (data + valor, sem duplicar):
 *  · Lançou a notificação e o OFX vem DEPOIS? O casamento automático do
 *    OfxService (conta + valor + data ±10 dias) acha o lançamento e marca
 *    MATCHED_AUTO — nada vira linha nova.
 *  · O OFX já tinha sido importado ANTES e criou lançamento próprio (NEW_TX)?
 *    No instante em que a notificação é lançada, o serviço PROCURA a linha OFX
 *    em aberto com o mesmo valor e data próxima (±3 dias) na mesma conta,
 *    APAGA o lançamento duplicado que o próprio OFX criou e vincula a linha ao
 *    lançamento do usuário (v70 — nada de dinheiro contado duas vezes).
 */

import type { DbDriver } from '../db/types';
import { genId } from '../lib/id';
import { nowIso, todaySP, spDateOfIso } from '../lib/dates';
import { normalizeText } from '../lib/text';

export type BankMessageKind = 'DEBIT' | 'CREDIT';
export type BankMessageStatus = 'NEW' | 'LANCADO' | 'DESCARTADA';

export interface BankMessageRow {
  id: string;
  sender: string | null;
  body: string;
  received_at: string;
  tx_date: string | null;
  amount_cents: number;
  kind: BankMessageKind;
  description: string | null;
  /** v70 — forma de pagamento extraída da notificação (cartão débito/crédito). */
  payment_method: 'DEBITO' | 'CREDITO' | null;
  /** v70 — 4 últimos dígitos do cartão quando a notificação cita ("cartão final 6830"). */
  card_final: string | null;
  status: BankMessageStatus;
  transaction_id: string | null;
  created_at: string;
}

/** Resultado da leitura de UMA notificação bancária. */
export interface ParsedBankMessage {
  amountCents: number;
  kind: BankMessageKind;
  /** 'YYYY-MM-DD' — null quando a notificação não traz data (fica com a de hoje). */
  date: string | null;
  /** Estabelecimento/origem extraído (ex.: "SHOPEE", "TikTok Shop", "NETFLIX"). */
  description: string | null;
  /** v70 — forma de pagamento citada ("no débito", "no crédito nacional"). */
  paymentMethod: 'DEBITO' | 'CREDITO' | null;
  /** v70 — final do cartão quando citado ("cartão final 6830"). */
  cardFinal: string | null;
}

// ---------------------------------------------------------------- parser ----

/** Converte o texto de valor pt-BR ("1.234,56", "1234,56", "1.234") em centavos. */
export function parseValorTexto(texto: string): number | null {
  const limpo = texto.replace(/r\$/i, '').trim();
  if (!limpo) return null;
  // 1.234,56 → 1234.56 | 1.234 → 1234 | 12,5 → 12.50
  const semMilhar = limpo.replace(/\./g, '').replace(',', '.');
  const num = Number(semMilhar);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100);
}

/** Palavras que indicam DINHEIRO ENTRANDO (crédito). */
const KIND_CREDITO = [
  'recebida', 'recebido', 'recebeu', 'entrada', 'deposito', 'depositado', 'salario',
  'estorno', 'estornada', 'estornado', 'reembolso', 'devolucao', 'devolvido',
  'cashback', 'pix recebido', 'pagamento recebido', 'rendimento', 'resgatado',
  'transferencia recebida', 'chargeback', 'afiliado', 'vendeu', 'venda aprovada',
];

/** Palavras que indicam DINHEIRO SAINDO (débito). */
const KIND_DEBITO = [
  'compra aprovada', 'compra autorizada', 'compra no', 'compra de', 'compra em',
  'compra recusada', 'compra', 'debitada', 'debitado', 'debito', 'pix enviado',
  'pagou', 'pagamento efetuado', 'pagamento realizado', 'cobranca', 'cobrado',
  'assinatura', 'saque', 'boleto', 'enviada', 'enviado', 'gasto', 'fatura',
  'assinou', 'renovou', 'shopee', 'ifood', 'uber', 'netflix', 'spotify', 'amazon',
];

/** v70 — detecção da FORMA DE PAGAMENTO citada na notificação (eixo separado
 *  do débito/crédito do lançamento: "compra no crédito" é DESPESA feita no
 *  cartão de crédito). Genérico: vale para Inter, Nubank, Itaú, C6 etc. */
function detectarFormaPagamento(plano: string): 'DEBITO' | 'CREDITO' | null {
  if (/(?:\bno\s+credito\b|\bcredito nacional\b|\bcredito parcelado\b|\bcompra no credito\b|\bcredito\s+à\s+vista\b)/.test(plano)) return 'CREDITO';
  if (/(?:\bno\s+debito\b|\bcompra no debito\b|\bdebito automatico\b|\bcompra com\s+debito\b)/.test(plano)) return 'DEBITO';
  return null;
}

/** v70 — final do cartão citado na notificação ("cartão final 6830"). */
function detectarCartaoFinal(texto: string): string | null {
  const m = texto.match(/(?:cart[aã]o|cartao|cart\.)\s+final\s*:?,?\s*(\d{4})\b/i)
    ?? texto.match(/\bfinal\s+(?:do\s+cart[aã]o\s+)?(\d{4})\b/i);
  return m ? m[1] : null;
}

/**
 * Lê UMA notificação bancária em português (Inter, Nubank, Itaú, Bradesco,
 * Banco do Brasil, Caixa, C6, Wise, pagamentos, PIX…) e devolve valor, direção,
 * data, estabelecimento, forma de pagamento e final do cartão. O parser é
 * GENÉRICO — não é preso a banco, a nome de usuário nem a formato fixo.
 * Retorna null quando não acha valor (notificação de marketing/segurança não
 * vira lançamento).
 */
export function parseBankMessage(body: string): ParsedBankMessage | null {
  if (!body || !body.trim()) return null;
  const texto = body.replace(/\s+/g, ' ').trim();
  const plano = normalizeText(texto); // sem acentos, minúsculo — para palavras-chave

  // (1) VALOR — primeiro "R$ ..." da notificação (padrão dos bancos: o valor
  //     vem depois das palavras de compra/recebimento, mesmo em "o valor de
  //     R$ 59,47"). Sem R$: procura "RS" colado ou "valor: 123,45".
  let valorBruto: string | null = null;
  const mValor = texto.match(/(?:r\$|rs)\s*([\d.]+(?:,\d{1,2})?)/i);
  if (mValor) {
    valorBruto = mValor[1];
  } else {
    // fallback: "valor: 123,45" ou "123,45 reais"
    const mAlt = texto.match(/([\d.]+,\d{2})\s*(?:reais|brl)?/i) ?? texto.match(/(?:valor|total)\s*:?\s*([\d.,]+)/i);
    valorBruto = mAlt ? mAlt[1] : null;
  }
  const amountCents = valorBruto ? parseValorTexto(valorBruto) : null;
  if (amountCents == null || amountCents <= 0) return null;

  // (2) DIREÇÃO (entrada/saída do dinheiro) — crédito explícito vence; senão
  //     palavras de débito; senão débito. NOTA: "compra no crédito (nacional)"
  //     é DESPESA no cartão de crédito — continua SAÍDA.
  const credito = KIND_CREDITO.some((p) => plano.includes(p));
  const debito = KIND_DEBITO.some((p) => plano.includes(p));
  const kind: BankMessageKind = credito && !debito ? 'CREDIT' : 'DEBIT';

  // (2.1) v70 — FORMA DE PAGAMENTO e FINAL DO CARTÃO citados na notificação
  const paymentMethod = detectarFormaPagamento(plano);
  const cardFinal = detectarCartaoFinal(texto);

  // (3) DATA — "12/05/2026", "12/05", "hoje", "ontem"; fallback: hoje.
  const hoje = todaySP();
  let date: string | null = null;
  const mDataFull = texto.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  const mDataShort = texto.match(/\b(\d{2})\/(\d{2})\b/);
  const mIso = texto.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (mDataFull) {
    date = `${mDataFull[3]}-${mDataFull[2]}-${mDataFull[1]}`;
  } else if (mIso) {
    date = `${mIso[1]}-${mIso[2]}-${mIso[3]}`;
  } else if (mDataShort) {
    const ano = parseInt(hoje.slice(0, 4), 10);
    const tentativa = `${ano}-${mDataShort[2]}-${mDataShort[1]}`;
    // "12/05" sem ano: se caiu no futuro, era do ano passado
    date = tentativa > hoje ? `${ano - 1}-${mDataShort[2]}-${mDataShort[1]}` : tentativa;
  } else if (/\bontem\b/i.test(plano)) {
    const d = new Date(`${hoje}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    date = d.toISOString().slice(0, 10);
  } else if (/\bhoje\b/i.test(plano)) {
    date = hoje;
  }

  // (4) ESTABELECIMENTO/LOCAL — o banco cita o local de 3 jeitos:
  //     a) CAIXA ALTA corrida ("no débito SORVETERIA GYGABOM o valor de…") —
  //        pega a SEQUÊNCIA inteira de palavras em caixa alta (v70: não fica
  //        só na primeira palavra);
  //     b) depois do valor ("comprar R$ 126,24 em TikTok Shop.") — nome
  //        misto até a pontuação;
  //     c) após a forma de pagamento ("compra no débito Padaria do Zé…").
  const STOPWORDS = new Set([
    'PIX', 'ENVIOU', 'ENVIADO', 'RECEBIDO', 'RECEBIDA', 'APROVADA', 'APROVADO',
    'AUTORIZADA', 'AUTORIZADO', 'EFETUADO', 'REALIZADO', 'VALOR', 'BANCO', 'CONTA',
    'EM', 'NO', 'NA', 'DE', 'PARA', 'COM', 'SUA', 'SEU', 'VOCE', 'DIA', 'HOJE',
    'ONTEM', 'AO', 'AS', 'OS', 'DA', 'DO', 'DAS', 'DOS', 'DAT', 'DTO', 'APP',
    'FINAL', 'CARTAO', 'NACIONAL', 'R$', 'OLA', 'OIGA', 'COMPRAR', 'COMPRA',
  ]);
  const temLetra = (w: string) => /[A-ZÀ-Ú]/.test(w);
  let description: string | null = null;
  // a) sequência de palavras TODAS em caixa alta (2+ letras por palavra),
  //    contendo pelo menos uma palavra com letra e fora das stopwords
  const tokens = texto.split(/\s+/);
  let melhorRun: string[] = [];
  let run: string[] = [];
  const flushRun = () => {
    const util = run.filter((w) => !STOPWORDS.has(w.replace(/[.,;:]$/, '')));
    if (run.length > melhorRun.length && util.length > 0 && run.some(temLetra)) {
      melhorRun = run;
    }
    run = [];
  };
  for (const tk of tokens) {
    const limpa = tk.replace(/[^A-Za-zÀ-ú0-9&.\-]/g, '');
    if (/^[A-ZÀ-Ú0-9&.\-]{2,}$/.test(limpa) && temLetra(limpa)) {
      run.push(limpa);
    } else {
      flushRun();
    }
  }
  flushRun();
  if (melhorRun.length > 0 && melhorRun.some((w) => !STOPWORDS.has(w.replace(/[.,;:]$/, '')))) {
    description = melhorRun.join(' ').replace(/[.,;:]+$/, '');
  }
  if (!description) {
    // b) nome misto logo após o valor ("comprar R$ 126,24 em TikTok Shop.")
    const mPosValor = texto.match(/R\$\s*[\d.,]+\s+(?:em|no|na|para)\s+([A-ZÀ-Ú][A-Za-zÀ-ú0-9&.'\- ]{1,48}?)[.,;]/);
    if (mPosValor) {
      description = mPosValor[1].trim().replace(/\s{2,}/g, ' ');
    }
  }
  if (!description) {
    // c) após a forma de pagamento ("compra no débito Padaria do Zé o valor…")
    const mPosForma = texto.match(/(?:no\s+d[eé]bito|no\s+cr[eé]dito|compra\s+de|compra\s+em|assinatura\s+de)\s+([A-ZÀ-Ú][A-Za-zÀ-ú0-9&.'\- ]{2,48}?)(?=\s+(?:o\s+valor|no\s+valor|em\s+|no\s+día|dia|R\$)|[.,;]|$)/i);
    if (mPosForma) {
      description = mPosForma[1].trim().replace(/\s{2,}/g, ' ');
    }
  }
  if (!description) {
    // d) padrões antigos (v69) — primeira maiúscula isolada ou texto após o verbo
    const maiusculas = texto.match(/\b[A-Z][A-Z0-9&.\-]{2,39}\b/g) ?? [];
    const candidata = maiusculas.find((w) => !STOPWORDS.has(w));
    if (candidata) {
      description = candidata;
    } else {
      const mDesc =
        texto.match(/(?:compra|pagamento|cobranca?|assinatura|pix (?:enviado|recebido)|transferencia (?:enviada|recebida))[^A-Za-z0-9]{1,30}([A-Za-z][A-Za-z0-9&.'\- ]{2,48})/i) ??
        texto.match(/\b(?:em|no|na|para)\s+([A-Z][A-Za-z0-9&.'\- ]{2,48})/);
      if (mDesc) {
        description = mDesc[1].trim().replace(/\s{2,}/g, ' ').slice(0, 48);
        description = description.replace(/\s+(no\s+d[ií]a|dia|em|de|com|valor|r\$).*/i, '').trim();
      }
    }
  }

  return {
    amountCents,
    kind,
    date,
    description: description && description.length >= 2 ? description.slice(0, 48) : null,
    paymentMethod,
    cardFinal,
  };
}

// ---------------------------------------------------------------- serviço ----

export interface BankMessageIngestResult {
  inserted: boolean;
  id: string | null;
  motivo: string | null;
  /** v71 — status da linha no banco: NEW (pode abrir o Novo Lançamento),
   *  LANCADO (o botão Lançar do grid avisa "já foi lançada") ou null quando
   *  a notificação nem entrou (sem valor reconhecido). */
  status: BankMessageStatus | null;
}

export class BankMessageService {
  constructor(private db: DbDriver) {}

  /**
   * Coloca a notificação NA LISTA (status NEW). Idempotente: mesma notificação
   * (mesmo corpo + valor + data) não entra duas vezes. NUNCA cria lançamento.
   */
  async ingest(sender: string | null, body: string, receivedAt?: string): Promise<BankMessageIngestResult> {
    const parsed = parseBankMessage(body);
    if (!parsed) {
      return { inserted: false, id: null, motivo: 'Não encontrei valor (R$) nessa notificação', status: null };
    }
    const received = receivedAt ?? nowIso();
    const txDate = parsed.date ?? spDateOfIso(received);
    // dedupe: mesmo corpo + valor + data já na lista (ou já lançada) → não duplica
    // v71: devolve o STATUS do registro existente — o grid usa para saber se a
    // notificação está aguardando (NEW) ou já virou lançamento (LANCADO).
    const dup = await this.db.getFirstAsync<{ id: string; status: BankMessageStatus }>(
      `SELECT id, status FROM bank_messages
        WHERE body = ? AND amount_cents = ? AND COALESCE(tx_date, '') = ? AND status != 'DESCARTADA' LIMIT 1`,
      [body.trim(), parsed.amountCents, txDate]
    );
    if (dup) return { inserted: false, id: dup.id, motivo: 'Essa notificação já está na lista', status: dup.status };
    const id = genId();
    await this.db.runAsync(
      `INSERT INTO bank_messages (id, sender, body, received_at, tx_date, amount_cents, kind, description, payment_method, card_final, status, transaction_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', NULL, ?)`,
      [id, sender, body.trim(), received, txDate, parsed.amountCents, parsed.kind, parsed.description, parsed.paymentMethod, parsed.cardFinal, nowIso()]
    );
    return { inserted: true, id, motivo: null, status: 'NEW' };
  }

  /** Mensagens aguardando decisão (status NEW) — mais recentes primeiro. */
  async listPending(): Promise<BankMessageRow[]> {
    return this.db.getAllAsync<BankMessageRow>(
      `SELECT * FROM bank_messages WHERE status = 'NEW' ORDER BY received_at DESC, created_at DESC`
    );
  }

  /** v71 — corpos das notificações ainda ATIVAS (NEW ou LANCADO): o grid da
   *  barra não mostra de novo a mensagem que já está na lista ou já virou
   *  lançamento (a mesma mensagem nunca aparece duas vezes na tela). */
  async listActiveBodies(): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ body: string }>(
      `SELECT body FROM bank_messages WHERE status IN ('NEW','LANCADO')`
    );
    return rows.map((r) => r.body);
  }

  async getById(id: string): Promise<BankMessageRow | null> {
    return this.db.getFirstAsync<BankMessageRow>('SELECT * FROM bank_messages WHERE id = ?', [id]);
  }

  /** "Deletar" — tira da lista (sai de vista, sem apagar histórico do banco). */
  async discard(id: string): Promise<void> {
    await this.db.runAsync(`UPDATE bank_messages SET status = 'DESCARTADA' WHERE id = ? AND status = 'NEW'`, [id]);
  }

  /**
   * "Lançar" concluído — marca a notificação como LANCADA com o lançamento
   * criado e faz a CONCILIAÇÃO AUTOMÁTICA com o OFX já importado (data + valor,
   * sem duplicar):
   *  · linha UNPROCESSED/AMBIGUOUS de mesmo valor e data próxima (±3 dias) na
   *    MESMA conta vira MATCHED_AUTO apontando para o lançamento do usuário —
   *    o extrato não duplica o lançamento;
   *  · linha NEW_TX (o próprio OFX já tinha criado lançamento) → v70 APAGA o
   *    lançamento duplicado criado pelo OFX (source OFX_BANK) e vincula a linha
   *    ao lançamento do usuário — o mesmo dinheiro deixa de contar duas vezes.
   */
  async markLancado(id: string, transactionId: string, accountId: string | null): Promise<number> {
    await this.db.runAsync(`UPDATE bank_messages SET status = 'LANCADO', transaction_id = ? WHERE id = ?`, [transactionId, id]);
    if (!accountId) return 0;
    const msg = await this.getById(id);
    if (!msg) return 0;
    const sinal = msg.kind === 'CREDIT' ? 1 : -1;
    const dataRef = msg.tx_date;
    if (!dataRef) return 0;
    const linhas = await this.db.getAllAsync<{ id: string; match_status: string; matched_transaction_id: string | null }>(
      `SELECT o.id, o.match_status, o.matched_transaction_id
         FROM ofx_statement_lines o
         JOIN ofx_imports i ON i.id = o.import_id
        WHERE i.account_id = ?
          AND o.amount_cents = ?
          AND o.posted_on IS NOT NULL
          AND julianday(o.posted_on) BETWEEN julianday(?, '-3 days') AND julianday(?, '+3 days')
          AND o.match_status IN ('UNPROCESSED', 'AMBIGUOUS', 'NEW_TX')
        ORDER BY ABS(julianday(o.posted_on) - julianday(?))
        LIMIT 1`,
      [accountId, sinal * msg.amount_cents, dataRef, dataRef, dataRef] as never
    );
    let vinculadas = 0;
    for (const linha of linhas) {
      // v70: a linha NEW_TX criou lançamento PRÓPRIO do extrato — com o
      // lançamento do usuário na mão, aquele é DUPLICADO: sai (movimento +
      // transação) e a linha passa a apontar para o lançamento do usuário.
      // ORDEM IMPORTA: solta a FK da linha (matched_transaction_id referencia
      // transactions) ANTES de apagar o lançamento do OFX.
      if (linha.match_status === 'NEW_TX' && linha.matched_transaction_id) {
        await this.db.runAsync(
          'UPDATE ofx_statement_lines SET matched_transaction_id = NULL WHERE id = ?',
          [linha.id]
        );
        await this.db.runAsync('DELETE FROM financial_moves WHERE transaction_id = ?', [linha.matched_transaction_id]);
        await this.db.runAsync('DELETE FROM transactions WHERE id = ?', [linha.matched_transaction_id]);
      }
      await this.db.runAsync(
        `UPDATE ofx_statement_lines SET match_status = 'MATCHED_AUTO', matched_transaction_id = ? WHERE id = ?`,
        [transactionId, linha.id]
      );
      vinculadas++;
    }
    return vinculadas;
  }

  /**
   * Resumo para a tela inicial (selo de pendências): quantas notificações novas
   * estão na lista esperando decisão.
   */
  async countPending(): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bank_messages WHERE status = 'NEW'`
    );
    return row?.n ?? 0;
  }
}
