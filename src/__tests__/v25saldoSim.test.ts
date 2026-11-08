/**
 * v25 — 400 SIMULAÇÕES DE DATAS (pedido explícito do usuário):
 * "faça 400 simulações mexendo nas datas para frente e para trás dentro de um
 *  mês, de todos os tipos de movimentação — fixa, parcelada, consolidada — e
 *  veja se o cálculo do saldo previsto funciona".
 *
 * Cada simulação:
 *  1. monta um cenário ALEATÓRIO (determinístico por seed) com TODOS os tipos:
 *     à vista despesa/receita em conta, transferência futura, CONTA FIXA em
 *     conta e no cartão, PARCELADO em conta e no cartão, compra à vista no
 *     cartão e GRUPO CONSOLIDADO (à vista + fixa dentro);
 *  2. aplica 3–5 mudanças de data ALEATÓRIAS (para frente e para trás, sempre
 *     dentro do mês) pelas MESMAS rotinas que as telas usam (updateSimple,
 *     updatePlanFields, updateRule, updateGroupHeader, setPaymentStatus);
 *  3. após CADA mudança roda o pipeline real do Fluxo (promoção de vencidas →
 *     recorrências → previsão) e compara o Saldo do dia (Previsto E Efetivado)
 *     de TODOS os dias do mês contra o ORÁCULO independente (v25saldoOracle).
 *
 * O cenário usa mês FUTURO (2026-12) com "hoje" no meio do mês (15/12) — é
 * exatamente a situação do usuário: histórico real antes do mês visto e
 * lançamentos sendo remanejados para frente e para trás pela data.
 */

import { makeCtx, seedAccount, seedCard } from './helpers';
import {
  oracleDual,
  diffDual,
  fluxoPipeline,
  rng,
  randInt,
  pick,
  ymd,
  lastDayOf,
} from './v25saldoOracle';

const MONTH = '2026-12';
const TODAY = '2026-12-15';

interface Mut { desc: string }

describe('v25 — 400 simulações de datas × saldo do dia (previsto/efetivado)', () => {
  for (let sim = 1; sim <= 400; sim++) {
    test(`simulação #${sim} — cenário completo + remanejamento de datas`, async () => {
      const r = rng(0x5eed0000 + sim * 7919);
      const ctx = await makeCtx();
      const { db, services } = ctx;

      // ---------- contas (1–2 no escopo + às vezes uma FORA do saldo geral) ----------
      const acc1 = await seedAccount(db, 'Conta A', randInt(r, 10000, 500000));
      let acc2: string | null = null;
      if (r() < 0.5) acc2 = await seedAccount(db, 'Conta B', randInt(r, 0, 200000));
      let fora: string | null = null;
      if (r() < 0.35) {
        fora = `acc-fora-${sim}`;
        await db.runAsync(
          'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,0)',
          [fora, 'Fora do saldo', 'CHECKING', randInt(r, 0, 100000)]
        );
      }
      const card = await seedCard(db, acc1, 'Cartão X', pick(r, [5, 15, 20, 28]), pick(r, [3, 8, 10, 15]));
      const alvo = (): string => pick(r, acc2 ? [acc1, acc2] : [acc1]);

      // ---------- às vezes conta com ÂNCORA dentro do mês anterior ----------
      if (r() < 0.4) {
        await db.runAsync('UPDATE accounts SET initial_balance_cents = ?, initial_balance_date = ? WHERE id = ?', [
          randInt(r, 50000, 400000), '2026-11-20', acc1,
        ]);
      }

      // ---------- histórico REAL no mês anterior (entre âncora e o mês visto) ----------
      const histCount = randInt(r, 1, 3);
      for (let i = 0; i < histCount; i++) {
        if (r() < 0.5) {
          await services.transactions.createAccountExpense({
            description: `Histórico ${i}`, amountCents: randInt(r, 1000, 50000), date: `2026-11-${String(randInt(r, 1, 30)).padStart(2, '0')}`, accountId: acc1,
          });
        } else {
          await services.transactions.createAccountIncome({
            description: `Renda hist. ${i}`, amountCents: randInt(r, 100000, 800000), date: `2026-11-${String(randInt(r, 1, 30)).padStart(2, '0')}`, accountId: acc1,
          });
        }
      }
      // efetiva o histórico (promoção com hoje 15/12 cobre novembro inteiro)
      await services.transactions.promoteDuePendings(TODAY);

      // ---------- cenário do mês visto: TODOS os tipos ----------
      const mutaveis: Array<() => Promise<Mut>> = [];
      const dia = () => randInt(r, 1, 28);

      // à vista despesa/receita em conta
      for (let i = 0; i < randInt(r, 1, 3); i++) {
        const tx = await services.transactions.createAccountExpense({
          description: `Despesa ${i}`, amountCents: randInt(r, 500, 100000), date: ymd(MONTH, dia()), accountId: alvo(),
        });
        const id = tx.id;
        mutaveis.push(async () => {
          await services.transactions.updateSimple(id, { date: ymd(MONTH, dia()) });
          return { desc: `à vista despesa movida p/ ${ymd(MONTH, dia())}` };
        });
        mutaveis.push(async () => {
          await services.transactions.setPaymentStatus(id, r() < 0.5);
          return { desc: 'toggle pago à vista' };
        });
      }
      for (let i = 0; i < randInt(r, 0, 2); i++) {
        const tx = await services.transactions.createAccountIncome({
          description: `Receita ${i}`, amountCents: randInt(r, 5000, 200000), date: ymd(MONTH, dia()), accountId: alvo(),
        });
        const id = tx.id;
        mutaveis.push(async () => {
          await services.transactions.updateSimple(id, { date: ymd(MONTH, dia()) });
          return { desc: 'à vista receita movida' };
        });
      }

      // transferência futura (pernas DEBIT/CREDIT — previsto v25)
      if (acc2 && r() < 0.7) {
        const tx = await services.transactions.createTransfer({
          fromAccountId: acc1, toAccountId: acc2, amountCents: randInt(r, 1000, 50000), date: ymd(MONTH, dia()), description: 'Transf.',
        });
        const id = tx.id;
        mutaveis.push(async () => {
          await services.transactions.updateSimple(id, { date: ymd(MONTH, dia()) });
          return { desc: 'transferência movida' };
        });
      }
      // transferência envolvendo conta FORA do escopo (só a perna no escopo conta)
      if (fora && r() < 0.5) {
        const tx = await services.transactions.createTransfer({
          fromAccountId: acc1, toAccountId: fora, amountCents: randInt(r, 1000, 30000), date: ymd(MONTH, dia()), description: 'Transf. p/ fora',
        });
        const id = tx.id;
        mutaveis.push(async () => {
          await services.transactions.updateSimple(id, { date: ymd(MONTH, dia()) });
          return { desc: 'transferência p/ conta fora movida' };
        });
      }

      // conta fixa em conta
      let regraConta: string | null = null;
      if (r() < 0.8) {
        const rule = await services.recurrences.createRule({
          description: `Fixa conta ${sim}`, type: 'EXPENSE', amountCents: randInt(r, 2000, 60000),
          dayOfMonth: dia(), startDate: '2026-11-01', accountId: alvo(),
        });
        regraConta = rule.id;
        mutaveis.push(async () => {
          await services.recurrences.updateRule(rule.id, { dayOfMonth: dia(), today: TODAY });
          return { desc: 'fixa (regra) remarcada' };
        });
      }
      // conta fixa no cartão
      if (r() < 0.5) {
        await services.recurrences.createRule({
          description: `Fixa cartão ${sim}`, type: 'EXPENSE', amountCents: randInt(r, 2000, 30000),
          dayOfMonth: dia(), startDate: '2026-11-01', cardId: card,
        });
      }

      // parcelado em conta
      if (r() < 0.85) {
        const plan = await services.installments.createPlan({
          description: `Parcelado conta ${sim}`,
          mode: r() < 0.5 ? 'DIVIDE_TOTAL' : 'FIXED_PER_MONTH',
          totalCents: randInt(r, 30000, 300000),
          fixedAmountCents: randInt(r, 5000, 50000),
          totalInstallments: randInt(r, 2, 6),
          firstDueDate: ymd(MONTH, dia()),
          accountId: alvo(), cardId: null, type: 'EXPENSE',
        } as never);
        mutaveis.push(async () => {
          await services.installments.updatePlanFields(plan.planId, { firstPendingDueDate: ymd(MONTH, dia()) });
          return { desc: 'vencimentos do parcelado (conta) remarcados' };
        });
      }
      // parcelado no cartão
      if (r() < 0.7) {
        await services.installments.createPlan({
          description: `Parcelado cartão ${sim}`,
          mode: 'DIVIDE_TOTAL', totalCents: randInt(r, 20000, 200000),
          totalInstallments: randInt(r, 2, 5),
          firstDueDate: ymd(MONTH, dia()),
          accountId: null, cardId: card, type: 'EXPENSE',
        } as never);
      }

      // compra à vista no cartão
      if (r() < 0.6) {
        await services.transactions.createCardExpense({
          description: `Compra cartão ${sim}`, amountCents: randInt(r, 2000, 80000), date: ymd(MONTH, dia()), cardId: card,
        } as never);
      }

      // grupo CONSOLIDADO (linhas à vista) + às vezes fixa dentro do grupo
      let grupoId: string | null = null;
      if (r() < 0.8) {
        const g = await services.transactions.createConsolidatedGroup({
          description: `Grupo ${sim}`, date: ymd(MONTH, dia()), accountId: alvo(),
          lines: [
            { description: 'Linha A', direction: 'DEBIT', amountCents: randInt(r, 2000, 40000) },
            { description: 'Linha B', direction: r() < 0.3 ? 'CREDIT' : 'DEBIT', amountCents: randInt(r, 2000, 40000) },
          ],
        } as never);
        if (g) {
          grupoId = g.id;
          mutaveis.push(async () => {
            await services.transactions.updateGroupHeader(g.id, { date: ymd(MONTH, dia()) });
            return { desc: 'data do grupo consolidado movida' };
          });
          const child = await db.getFirstAsync<{ id: string }>(
            'SELECT id FROM transactions WHERE parent_transaction_id = ? LIMIT 1', [g.id]
          );
          if (child) {
            const cid = child.id;
            mutaveis.push(async () => {
              await services.transactions.updateSimple(cid, { date: ymd(MONTH, dia()) });
              return { desc: 'linha do grupo movida' };
            });
          }
          if (r() < 0.5) {
            await services.recurrences.createRule({
              description: `Fixa do grupo ${sim}`, type: 'EXPENSE', amountCents: randInt(r, 2000, 30000),
              dayOfMonth: dia(), startDate: '2026-11-01', accountId: alvo(), groupTransactionId: g.id,
            });
          }
        }
      }

      // ---------- pipeline inicial + linha de base ----------
      await fluxoPipeline(services as never, MONTH, TODAY);
      let lastEnd = 0; // previsto do último dia (invariante sob pura mudança de data)
      const dual0 = await services.balance.getDailyBalancesDual(MONTH);
      const last = lastDayOf(MONTH);
      const ora0 = await oracleDual(db, MONTH);
      const d0 = diffDual(MONTH, dual0, ora0);
      if (d0.length) {
        throw new Error(`[sim ${sim}] Linha de base divergiu:\n${d0.join('\n')}`);
      }
      lastEnd = dual0.previsto[ymd(MONTH, last)];

      // ---------- 3–5 mudanças de data (frente/trás), cada uma verificada ----------
      const nMuts = randInt(r, 3, 5);
      const log: string[] = [];
      for (let k = 0; k < nMuts; k++) {
        const op = pick(r, mutaveis);
        const meta = await op();
        log.push(meta.desc);

        // pipeline REAL da tela após a mudança
        const dual = await fluxoPipeline(services as never, MONTH, TODAY);
        const ora = await oracleDual(db, MONTH);
        const diffs = diffDual(MONTH, dual, ora);
        if (diffs.length) {
          throw new Error(
            `[sim ${sim}] mutação ${k + 1} (${meta.desc}) divergiu:\n${diffs.slice(0, 8).join('\n')}\n` +
            `histórico: ${log.join(' | ')}`
          );
        }
        // invariante: previsto do ÚLTIMO dia do mês não muda com remanejamento
        // DENTRO do mês (mesmo valor, outra data). Toggles de pagamento podem
        // mudar a data p/ hoje real — fora do mês — então ficam de fora.
        if (!meta.desc.includes('toggle')) {
          const endPrev = dual.previsto[ymd(MONTH, last)];
          if (endPrev !== lastEnd) {
            throw new Error(
              `[sim ${sim}] previsto do fim do mês mudou com remanejamento interno: ` +
              `${lastEnd} → ${endPrev} (${meta.desc})\nhistórico: ${log.join(' | ')}`
            );
          }
        } else {
          lastEnd = dual.previsto[ymd(MONTH, last)];
        }
      }

      // ---------- sanidade final: nenhum VOIDED/órfão quebrando o oráculo ----------
      const dualF = await services.balance.getDailyBalancesDual(MONTH);
      const oraF = await oracleDual(db, MONTH);
      const dF = diffDual(MONTH, dualF, oraF);
      if (dF.length) throw new Error(`[sim ${sim}] verificação final divergiu:\n${dF.join('\n')}`);
    });
  }
});
