/**
 * bankNotificationGrid (v71) — lógica PURA do GRID de notificações do banco
 * (a parte da tela que pode ser testada sem módulo nativo):
 *
 *  · ordenação das capturas da barra (mais recentes primeiro);
 *  · filtro do que NÃO deve aparecer no grid: mensagem que JÁ está na lista
 *    do banco de dados (status NEW — aguardando salvar o lançamento) ou que
 *    JÁ FOI LANCADA — a mesma mensagem nunca vira dois cards na tela;
 *  · montagem dos cards: parse da notificação (valor, direção, forma de
 *    pagamento, final do cartão) e a flag "lanccavel" (o parse achou R$ —
 *    só então o botão Lançar preenche o Novo Lançamento).
 */

import { parseBankMessage, type ParsedBankMessage } from '../services/BankMessageService';
import type { CapturedBankNotification } from './bankNotifications';

/** Um card do grid de notificações capturadas. */
export interface GridBankNotification {
  id: string;
  appPackage: string;
  /** Nome do app do banco ("Banco Inter") — entra como remetente da mensagem. */
  appName: string | null;
  title: string | null;
  body: string;
  postTime: number;
  count: number;
  /** Parse da notificação — null quando não há valor (R$) reconhecido. */
  parsed: ParsedBankMessage | null;
  /** true quando o parse achou valor: o "Lançar" pode preencher o formulário. */
  lanccavel: boolean;
}

/** Corpo canônico para casar captura da barra com linha do banco (o ingest trims). */
export function corpoCanonico(body: string): string {
  return (body ?? '').trim();
}

/** Grid em ordem de chegada: a notificação mais recente em cima. */
export function ordenarCapturadas(
  list: CapturedBankNotification[]
): CapturedBankNotification[] {
  return [...list].sort((a, b) => (b?.postTime ?? 0) - (a?.postTime ?? 0));
}

/** Monta um card do grid a partir da captura bruta (parse + lanccável). */
export function gridItem(c: CapturedBankNotification): GridBankNotification {
  const parsed = parseBankMessage(c.body);
  return {
    id: c.id,
    appPackage: c.appPackage,
    appName: c.appName ?? null,
    title: c.title,
    body: c.body,
    postTime: c.postTime,
    count: c.count ?? 1,
    parsed,
    lanccavel: parsed != null,
  };
}

/**
 * v71 — SEPARA as capturas da barra para a tela:
 *  · `grid`       — notificações que ainda NÃO estão no banco de dados
 *    (status NEW/LANCADO) → ganham card com os botões Lançar/Excluir;
 *  · `jaNaLista`  — quantas foram ignoradas porque já estão na lista (NEW) ou
 *    já foram lançadas (LANCADO) — evita a mesma mensagem duas vezes na tela;
 *    elas continuam visíveis na "Lista para lançar" logo abaixo do grid.
 */
export function separarCapturadas(
  capturadas: CapturedBankNotification[],
  bodiesNoBanco: Iterable<string>
): { grid: GridBankNotification[]; jaNaLista: number } {
  const conhecidos = new Set([...bodiesNoBanco].map(corpoCanonico));
  let jaNaLista = 0;
  const grid: GridBankNotification[] = [];
  for (const c of ordenarCapturadas(capturadas)) {
    if (!c || !c.body || conhecidos.has(corpoCanonico(c.body))) {
      jaNaLista++;
      continue;
    }
    grid.push(gridItem(c));
  }
  return { grid, jaNaLista };
}
