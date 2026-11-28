/**
 * calcularFluxo — v36: 1 CARGA, 1 LISTA, 1 CÁLCULO (pedido do usuário).
 *
 * O Saldo do dia do Fluxo sai de UMA função PURA, em memória:
 *  · NÃO recebe db, NÃO faz await, NÃO faz SELECT;
 *  · recebe a lista em memória (lançamentos + Orçamento + Poupança +
 *    Programação como itens) e 1 número: o saldo de abertura do mês visto
 *    (fechamento do mês anterior, lido do livro-razão);
 *  · devolve os dias com o Saldo do dia Previsto e o Efetivado de cada dia.
 *
 * Regras de cálculo (em centavos inteiros, nunca float):
 *  · itens CANCELADOS ficam fora (não descontam);
 *  · os dias são acumulados em ordem de data; dentro do mesmo dia a ordem
 *    da lista é mantida (é a ordem da tela);
 *  · Saldo do dia Previsto  = abertura + soma de TUDO até aquele dia (pago + pendente);
 *  · Saldo do dia Efetivado = abertura + soma de SÓ O QUE JÁ FOI PAGO até aquele dia;
 *  · primeiro dia NÃO começa do zero — começa do saldo de abertura;
 *  · último dia é o fechamento do mês;
 *  · mês vazio: o saldo do mês é o próprio saldo de abertura (nunca zero).
 *
 * Vigências (regra do usuário — vale NA GERAÇÃO DA LISTA, antes do cálculo):
 *  · POUPANÇA: a ocorrência só existe quando `data da ocorrência >= data de
 *    criação do plano` — plano criado em 28/11 para o dia 05 NÃO gera nada
 *    em novembro; a primeira ocorrência é 05/12. `gerarOcorrenciasPoupanca`
 *    é a fonte única dessa regra (geração do banco e da lista em memória);
 *  · ORÇAMENTO e PROGRAMAÇÃO: valem a partir do mês em que foram planejados
 *    — mês anterior ao planejado não gera ocorrência e não desconta.
 */

/** Origem do item na lista em memória. */
export type OrigemFluxo = 'LANCAMENTO' | 'ORCAMENTO' | 'POUPANCA' | 'PROGRAMACAO';

/** PAGO entra no Efetivado e no Previsto · PENDENTE só no Previsto · CANCELADO sai do cálculo. */
export type StatusFluxo = 'PAGO' | 'PENDENTE' | 'CANCELADO';

/** Um item da lista em memória do Fluxo — lançamento OU ocorrência de
 *  Orçamento / Poupança / Programação (mesma forma para os quatro). */
export interface ItemFluxo {
  /** Chave estável do item (`mv:<moveId>`, `inv:<invoiceId>`, `bud:<txId>`,
   *  `budrev:<txId>`, `poup:<entryId>`, `prog:<month>`). */
  id: string;
  origem: OrigemFluxo;
  /** 'YYYY-MM-DD' */
  data: string;
  /** Assinado: entrada soma, saída subtrai. Centavos inteiros. */
  valorCents: number;
  status: StatusFluxo;
  descricao: string;
  /** Vínculo com a origem (transactionId, txId do compromisso, entryId, mês). */
  refId?: string;
}

/** Saldo de um dia: as duas visões vêm do MESMO cálculo, na MESMA hora. */
export interface SaldoDia {
  /** 'YYYY-MM-DD' */
  data: string;
  previstoCents: number;
  efetivadoCents: number;
}

export interface ResultadoFluxo {
  /** O número de abertura usado ( eco para a tela/livro-razão ). */
  saldoAberturaCents: number;
  /** Dias que têm itens, em ordem DECRESCENTE (mesma ordem da lista da tela). */
  dias: SaldoDia[];
  /** Saldo do fim do mês (fechamento) — igual à abertura quando o mês está vazio. */
  fechamentoCents: number;
}

/**
 * O ÚNICO cálculo do Saldo do dia. Puro: nada de banco, nada de await.
 */
export function calcularFluxo(
  listaEmMemoria: ItemFluxo[],
  saldoAberturaCents: number
): ResultadoFluxo {
  // 1) CANCELADO fica fora — se não está na lista, não desconta.
  const ativos = listaEmMemoria.filter((i) => i.status !== 'CANCELADO');

  // 2) Agrupa por dia, mantendo a ordem de inserção dentro do dia (ordem da tela).
  const porDia = new Map<string, ItemFluxo[]>();
  for (const item of ativos) {
    const lista = porDia.get(item.data);
    if (lista) lista.push(item);
    else porDia.set(item.data, [item]);
  }

  // 3) Acumula em ordem de data (soma independe da ordem DENTRO do dia).
  const diasAsc: SaldoDia[] = [];
  let prev = saldoAberturaCents;
  let efet = saldoAberturaCents;
  const chaves = Array.from(porDia.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const dia of chaves) {
    for (const item of porDia.get(dia)!) {
      // centavos inteiros — Math.round de guarda (entradas já são inteiras)
      const v = Math.round(item.valorCents);
      prev += v;
      if (item.status === 'PAGO') efet += v;
    }
    diasAsc.push({ data: dia, previstoCents: prev, efetivadoCents: efet });
  }

  // 4) A tela lista do dia mais recente para o mais antigo.
  const dias = diasAsc.slice().reverse();
  return {
    saldoAberturaCents: saldoAberturaCents,
    dias,
    // último dia é o fechamento; mês vazio → fechamento = abertura (nunca zero em branco)
    fechamentoCents: diasAsc.length > 0 ? diasAsc[diasAsc.length - 1].previstoCents : saldoAberturaCents,
  };
}

/** true quando a ocorrência respeita a vigência: data da ocorrência >= criação. */
export function ocorrenciaNaVigencia(dataOcorrencia: string, dataCriacao: string): boolean {
  return dataOcorrencia >= dataCriacao;
}

export interface OcorrenciaPoupanca {
  /** 'YYYY-MM' da ocorrência. */
  month: string;
  /** 'YYYY-MM-DD' (dia do plano dentro do mês, com clamp). */
  data: string;
  valorCents: number;
}

/**
 * Ocorrências de um plano MENSAL de poupança, com a regra de VIGÊNCIA:
 *  · vale para todos os meses PRA FRENTE, nunca pra trás;
 *  · data da ocorrência >= data de criação do plano — criado em 28/11 para
 *    o dia 05: novembro não gera nada, a primeira é 05/12;
 *  · se o dia ainda não passou no mês da criação, aquele mês já tem a primeira.
 *
 * Pura (sem banco). O dia 29/30/31 em mês curto cai no último dia do mês.
 * `horizonteMeses` limita a janela (padrão 24 — mesma janela do banco).
 */
export function gerarOcorrenciasPoupanca(
  plano: { dayOfMonth?: number | null; amountCents?: number | null; mode?: string | null },
  dataCriacao: string,
  horizonteMeses: number = 24
): OcorrenciaPoupanca[] {
  // Plano FECHAMENTO não gera ocorrências mensais (a estimativa é do saldo).
  if (plano.mode === 'CLOSING') return [];
  const dia = Math.min(31, Math.max(1, Math.trunc(plano.dayOfMonth ?? NaN)));
  const valor = Math.round(plano.amountCents ?? 0);
  if (!Number.isFinite(dia) || valor <= 0 || !dataCriacao) return [];

  const criacao = dataCriacao.slice(0, 10);
  const [ay, am] = criacao.split('-').map((x) => parseInt(x, 10));
  const out: OcorrenciaPoupanca[] = [];
  for (let i = 0; i <= horizonteMeses; i++) {
    const total = ay * 12 + (am - 1) + i;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    const month = `${y}-${String(m).padStart(2, '0')}`;
    const data = diaNoMes(month, dia);
    // VIGÊNCIA: nunca volta pra trás — ocorrência anterior à criação não existe.
    if (!ocorrenciaNaVigencia(data, criacao)) continue;
    out.push({ month, data, valorCents: valor });
  }
  return out;
}

/** 'YYYY-MM-DD' com clamp do dia (31/02 → 28/02). */
function diaNoMes(month: string, dia: number): string {
  const [y, m] = month.split('-').map((x) => parseInt(x, 10));
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(Math.max(dia, 1), ultimo);
  return `${month}-${String(d).padStart(2, '0')}`;
}
