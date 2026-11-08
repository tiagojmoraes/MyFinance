import { makeCtx, seedAccount } from './helpers';
import { todaySP } from '../lib/dates';
const run = async (startDay: number, toDay: number) => {
  const { db, services } = await makeCtx();
  const month = todaySP().slice(0, 7);
  const d = (n: number) => `${month}-${String(n).padStart(2, '0')}`;
  const acc = await seedAccount(db, 'A', 100000);
  await db.runAsync('UPDATE accounts SET initial_balance_date = NULL');
  const g = await services.transactions.createConsolidatedGroup({ description: 'G', date: d(startDay), accountId: acc,
    lines: [{ direction: 'DEBIT', amountCents: 10000, description: 'l1' }] } as never);
  await services.recurrences.createRule({ description: 'fixa', type: 'EXPENSE', amountCents: 5000, dayOfMonth: startDay, startDate: d(startDay), accountId: acc, groupTransactionId: g!.id } as never);
  await services.installments.createPlan({ description: 'parc', mode: 'DIVIDE_TOTAL', totalCents: 30000, totalInstallments: 3, firstDueDate: d(startDay), purchaseDate: d(startDay), accountId: acc, groupTransactionId: g!.id } as never);
  await services.recurrences.runDueRecurrences(); await services.recurrences.runForecast(); await services.recurrences.ensureForecastThrough(month);
  await services.transactions.updateGroupHeader(g!.id, { date: d(toDay) });
  await services.transactions.promoteDuePendings();
  const out = await services.balance.getDailyBalancesDual(month);
  const occ = await db.getAllAsync<any>("SELECT occurred_on o,status s FROM transactions WHERE recurrence_rule_id IS NOT NULL AND substr(occurred_on,1,7)=?", [month]);
  const ins = await db.getAllAsync<any>("SELECT due_date o,status s FROM installments WHERE substr(due_date,1,7)=?", [month]);
  const days = Object.keys(out.previsto).filter((k, i, a) => i === 0 || out.previsto[k] !== out.previsto[a[i - 1]]);
  console.log(`MOVE ${startDay}->${toDay}`, 'fixa', JSON.stringify(occ), 'parc', JSON.stringify(ins), 'mudancas', days.map((k) => k.slice(8) + ':' + out.previsto[k]).join(' '));
};
test('g', async () => { await run(10, 20); await run(20, 10); });
