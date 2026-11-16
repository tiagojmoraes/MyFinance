/**
 * (v80) Parte de v69.test.ts — limpeza de dados com as tabelas novas.
 * v69 — TESTES: mensagens bancárias, Lista de Desejos, poupança do Fluxo e
 * formato "Orçado • Previsto • Gasto".
 *
 * 1. PARSER de mensagens (débito/crédito, valor pt-BR, data, estabelecimento);
 * 2. INGEST na lista — idempotente, NUNCA cria lançamento sozinho;
 * 3. "Lançar" + CONCILIAÇÃO OFX automática por data + valor (nos DOIS sentidos:
 *    OFX já importado → vincula na hora; OFX depois → casamento padrão);
 * 4. "Deletar" tira da lista;
 * 5. LISTA DE DESEJOS — cadastro/alteração/exclusão, reserva na CAIXINHA fora
 *    do saldo geral, reserva na POUPANÇA em fatia separada, barra 100% = pronto,
 *    comprar vira lançamento normal;
 * 6. METODOLOGIA (5.2) — sobra 1.500 x Prioridade 3.000 → 2 meses; as outras
 *    classificações nem começam; frases pedidas pelo usuário;
 * 7. POUPANÇA do Fluxo — cabeçalho não fica em R$ 0,00 (programado inclui a
 *    estimativa do Fechamento), "Falta transferir" = programado − transferido;
 * 8. FORMATO da linha "Orçado • Previsto • Gasto" — uma linha, % redonda.
 */

import { makeCtx, seedAccount, expectRejects, type TestCtx } from '../helpers';
import {
  BankMessageService, parseBankMessage, parseValorTexto,
} from '../../services/BankMessageService';
import {
  WishlistService, RESERVA_ACCOUNT_NAME, CLASS_LABELS,
  type WishlistMethodology,
} from '../../services/WishlistService';
import { pctOf, orcadoPrevistoGastoLinha } from '../../lib/fluxoFormat';
import { TransactionService } from '../../services/TransactionService';
import { formatBRL } from '../../lib/money';
import { clearLancamentos } from '../../db/seed';

let ctx: TestCtx;
let bank: BankMessageService;
let wish: WishlistService;
let tx: TransactionService;

beforeEach(async () => {
  ctx = await makeCtx();
  bank = new BankMessageService(ctx.db);
  wish = new WishlistService(ctx.db, ctx.services.transactions, ctx.services.balance);
  tx = ctx.services.transactions;
});
describe('v69 · 8 — limpeza de dados com as tabelas novas', () => {
  test('limpar lançamentos: mensagens LANCADAS saem, pendentes voltam; reservas zeram', async () => {
    const acc = await seedAccount(ctx.db, 'L1', 100_000);
    const m1 = await bank.ingest(null, 'Compra aprovada: A R$ 10,00 em 12/07/2026');
    const m2 = await bank.ingest(null, 'Compra aprovada: B R$ 20,00 em 13/07/2026');
    const t = await tx.createAccountExpense({ description: 'A', amountCents: 1_000, date: '2026-07-12', accountId: acc });
    await bank.markLancado(m1.id!, t.id, acc);
    const itemId = await wish.addItem({ classificacao: 'DESEJO', description: 'X', targetCents: 5_000 });
    await wish.reserve({ itemId, amountCents: 1_000, fromAccountId: acc, destination: { kind: 'BOX' } });

    await clearLancamentos(ctx.db);

    // m1 (LANCADO) sai; m2 (NEW) continua na lista
    expect(await bank.getById(m1.id!)).toBeNull();
    const pend = await bank.listPending();
    expect(pend).toHaveLength(1);
    expect(pend[0].id).toBe(m2.id);
    // item aberto volta com reservado 0
    const item = await wish.getById(itemId);
    expect(item?.reserved_cents).toBe(0);
    expect(item?.status).toBe('OPEN');
    // saldo da conta volta ao inicial (transferência da reserva foi apagada)
    expect(await ctx.services.balance.getAccountBalance(acc)).toBe(100_000);
  });
});
