/** Fatura do mês — v10:
 *  · v22 (bug 5): o indicador de PARCELAS (pill X/N) segue o MESMO padrão de
 *    alinhamento do símbolo de Fixo (bolinha ✓): fica na LINHA DO TÍTULO,
 *    ANTES da descrição — não mais solto à direita, abaixo do valor.
 *  · Itens com AÇÕES: "Alterar" e "Excluir" em cada lançamento da fatura.
 *    - Lançamento simples: exclusão FÍSICA (sai do banco de verdade).
 *    - Lançamento PARCELADO: regra padrão "daquela parcela em diante".
 *  · Bloco PAGAMENTO limpo: SEM campos de conta/valor — apenas o botão
 *    "Registrar Pagamento", que abre a tela/modal própria.
 *  · Pagamentos registrados aparecem com pictograma de confirmação ✓, DATA e
 *    VALOR. Exclusão do pagamento: SEGURAR o toque por 3 SEGUNDOS → alerta de
 *    "Exclusão" → confirmado, o pagamento é apagado do banco e todo o
 *    movimento vinculado é ESTORNADO (conta e status da fatura voltam).
 *  · SEM alertas de sucesso (v10): ações concluem em silêncio e a tela se
 *    atualiza sozinha.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { showToast } from '../../../../../lib/toast';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen, Card, Badge, SectionTitle, Button, KeyValue, FixedDot, InstallmentPill } from '../../../../../src/components/ui';
import { ConfirmDialog } from '../../../../../src/components/ConfirmDialog';
import { useDataEffect } from '../../../../../src/components/useDataEffect';
import { useAppStore } from '../../../../../src/store/appStore';
import { formatBRL } from '../../../../../src/lib/money';
import { ymdToBr, monthLabel } from '../../../../../src/lib/dates';
import { ICONS } from '../../../../../src/theme/icons';

interface Detail {
  liveStatus: string;
  dueCents: number;
  invoice: {
    id: string; reference_month: string; total_cents: number; paid_cents: number;
    credit_from_prev_cents: number; due_date: string | null; period_start: string | null; period_end: string | null;
  };
  items: Array<{
    id: string; amount_cents: number; description: string; occurred_on: string | null;
    sequence_number: number | null; total_installments: number | null; source_system: string | null;
    transaction_id: string | null; installment_id: string | null;
  }>;
  payments: Array<{ id: string; amount_cents: number; paid_on: string | null; account_name: string | null }>;
}

export default function FaturaScreen() {
  const { id, mes } = useLocalSearchParams<{ id: string; mes: string }>();
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [detail, setDetail] = React.useState<Detail | null>(null);

  // v21 (bug 4): CONFIRMAÇÃO antes de excluir (lançamento, parcela, pagamento)
  type ConfirmState =
    | { kind: 'tx'; txId: string; label: string }
    | { kind: 'parcela'; planId: string; sequence: number; label: string }
    | { kind: 'pagamento'; paymentId: string; label: string }
    | null;
  const [confirm, setConfirm] = React.useState<ConfirmState>(null);

  const load = React.useCallback(async () => {
    const d = await services.invoices.getInvoiceDetailByCardMonth(id, mes);
    if (!d) return;
    const accNames = new Map<string, string>(
      (await services.db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM accounts')).map((a) => [a.id, a.name])
    );
    setDetail({
      liveStatus: d.liveStatus,
      dueCents: d.dueCents,
      invoice: d.invoice,
      items: d.items.map((i) => ({
        id: i.id, amount_cents: i.amount_cents,
        description: i.description ?? (i.sequence_number != null ? 'Parcela' : 'Lançamento'),
        occurred_on: i.occurred_on,
        sequence_number: i.sequence_number ?? null,
        total_installments: i.total_installments ?? null,
        source_system: i.source_system ?? null,
        transaction_id: i.transaction_id ?? null,
        installment_id: i.installment_id ?? null,
      })),
      payments: (d.payments ?? []).map((p) => ({
        id: p.id,
        amount_cents: p.amount_cents,
        paid_on: p.paid_on,
        account_name: p.from_account_id ? accNames.get(p.from_account_id) ?? null : null,
      })),
    });
  }, [services, id, mes]);

  useDataEffect(load, [id, mes]);

  if (!detail) {
    return <Screen title="Fatura"><Card><Text className="text-slate-500">Carregando...</Text></Card></Screen>;
  }

  /** Exclusão FÍSICA de um lançamento simples da fatura — v21 (bug 4): só após confirmação. */
  const doExcluirTx = async (txId: string) => {
    try {
      await services.transactions.deleteTransaction(txId);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** Exclusão PARCELADA — v21 (bug 4): confirmação com escopo (apenas esta / em diante). */
  const doExcluirParcela = async (planId: string, sequence: number, onlyOne: boolean) => {
    try {
      await services.installments.cancelFromSequence(planId, sequence, { onlyOne });
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** Exclusão do pagamento com ESTORNO total (long-press 3 s) — v21: confirma antes. */
  const doExcluirPagamento = async (paymentId: string) => {
    try {
      await services.invoices.deletePayment(paymentId);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };




  return (
    <Screen
      title={`Fatura ${monthLabel(detail.invoice.reference_month)}`}
      subtitle={`Total ${formatBRL(detail.invoice.total_cents)}`}
      action={<Badge status={detail.liveStatus} />}
    >
      <Card>
        <KeyValue k="Período" v={`${detail.invoice.period_start ? ymdToBr(detail.invoice.period_start) : '—'} → ${detail.invoice.period_end ? ymdToBr(detail.invoice.period_end) : '—'}`} />
        <KeyValue k="Vencimento" v={detail.invoice.due_date ? ymdToBr(detail.invoice.due_date) : '—'} />
        <KeyValue k="Total da fatura" v={formatBRL(detail.invoice.total_cents)} />
        <KeyValue k="Crédito anterior" v={`− ${formatBRL(detail.invoice.credit_from_prev_cents)}`} />
        <KeyValue k="Pago" v={`− ${formatBRL(detail.invoice.paid_cents)}`} />
        <KeyValue k="Devido" v={formatBRL(detail.dueCents)} bold />
      </Card>

      <SectionTitle>Itens</SectionTitle>
      {detail.items.length === 0 ? (
        <Card><Text className="text-slate-500 text-sm">Nenhum item nesta fatura.</Text></Card>
      ) : (
        detail.items.map((item) => (
          <Card key={item.id} className="!py-2.5">
            <View className="flex-row justify-between items-center gap-2">
              <View className="flex-1">
                {/* v22 (bug 5): pill X/N na MESMA linha do título, ANTES da descrição —
                    exatamente onde fica a bolinha ✓ do Fixo (mesmo alinhamento) */}
                <View className="flex-row items-center gap-1.5">
                  {item.source_system === 'RECURRENCE' ? <FixedDot /> : null}
                  {item.sequence_number != null && item.total_installments ? (
                    <InstallmentPill current={item.sequence_number} total={item.total_installments} />
                  ) : null}
                  <Text className="font-medium text-slate-900" numberOfLines={2}>{item.description}</Text>
                </View>
                {item.occurred_on ? (
                  <Text className="text-xs text-slate-500">{ymdToBr(item.occurred_on)}</Text>
                ) : null}
              </View>
              <View className="items-end gap-1">
                {/* v12: receita fixa no cartão entra como item NEGATIVO (crédito) */}
                <Text className={`font-semibold ${item.amount_cents < 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {item.amount_cents < 0 ? '+' : ''}{formatBRL(item.amount_cents)}
                </Text>
              </View>
            </View>
            {/* v10 (Req 6): Ações Alterar/Excluir em cada lançamento da fatura */}
            <View className="flex-row gap-1 mt-2 justify-end">
              {item.transaction_id ? (
                <>
                  <Pressable
                    onPress={() => router.push({ pathname: '/lancamento', params: { edit: item.transaction_id! } })}
                    accessibilityLabel={`Alterar ${item.description}`}
                    className="px-2 py-1 rounded-lg bg-slate-100"
                  >
                    <Text className="text-xs font-semibold text-slate-600">Alterar</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setConfirm({ kind: 'tx', txId: item.transaction_id!, label: item.description })}
                    accessibilityLabel={`Excluir ${item.description}`}
                    className="px-2 py-1 rounded-lg bg-rose-50"
                  >
                    <Text className="text-xs font-semibold text-rose-600">Excluir</Text>
                  </Pressable>
                </>
              ) : item.installment_id ? (
                <>
                  <Pressable
                    onPress={async () => {
                      // v21 (bug 1): abre a TELA ESPECÍFICA do plano (todos os campos)
                      const row = await services.db.getFirstAsync<{ plan_id: string }>(
                        'SELECT plan_id FROM installments WHERE id = ?',
                        [item.installment_id!]
                      );
                      router.push({ pathname: '/plano/[id]', params: { id: row?.plan_id ?? '' } });
                    }}
                    accessibilityLabel={`Alterar parcelamento ${item.description}`}
                    className="px-2 py-1 rounded-lg bg-slate-100"
                  >
                    <Text className="text-xs font-semibold text-slate-600">Alterar</Text>
                  </Pressable>
                  <Pressable
                    onPress={async () => {
                      const row = await services.db.getFirstAsync<{ plan_id: string; sequence_number: number }>(
                        'SELECT plan_id, sequence_number FROM installments WHERE id = ?',
                        [item.installment_id!]
                      );
                      if (row) {
                        // v21 (bug 4): exclusão com confirmação (escopo no modal)
                        setConfirm({ kind: 'parcela', planId: row.plan_id, sequence: row.sequence_number, label: item.description });
                      }
                    }}
                    accessibilityLabel={`Excluir ${item.description} da parcela em diante`}
                    className="px-2 py-1 rounded-lg bg-rose-50"
                  >
                    <Text className="text-xs font-semibold text-rose-600">Excluir</Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          </Card>
        ))
      )}

      {/* v10 (Req 6): bloco PAGAMENTO — só o botão (campos foram para a tela/modal) */}
      <SectionTitle>Pagamento</SectionTitle>
      <Card className="gap-3">
        <Button
          label="Registrar Pagamento"
          onPress={() => router.push(`/cartoes/${id}/fatura/${mes}/pagamento`)}
        />
        <Text className="text-xs text-slate-500">
          Abre a tela de pagamento com o saldo devido da fatura já preenchido — informe a conta e confirme.
        </Text>

        {/* v10 (Req 7): pictograma de confirmação + data + valor de cada pagamento.
            Exclusão: SEGURAR o toque por 3 SEGUNDOS. */}
        {detail.payments.length > 0 ? (
          <View className="gap-1.5 mt-1 border-t border-dashed border-slate-200 pt-2">
            {detail.payments.map((p) => (
              <Pressable
                key={p.id}
                onLongPress={() => setConfirm({ kind: 'pagamento', paymentId: p.id, label: formatBRL(p.amount_cents) })}
                delayLongPress={3000}
                accessibilityLabel={`Pagamento de ${formatBRL(p.amount_cents)} em ${p.paid_on ? ymdToBr(p.paid_on) : '—'}. Segure 3 segundos para excluir.`}
                className="flex-row items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2"
              >
                <View className="w-7 h-7 rounded-full bg-emerald-600 items-center justify-center">
                  <Text className="text-white font-bold text-sm">{ICONS.check}</Text>
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-emerald-800">Pagamento confirmado</Text>
                  <Text className="text-xs text-emerald-700">
                    {p.paid_on ? ymdToBr(p.paid_on) : '—'}{p.account_name ? ` · ${p.account_name}` : ''}
                  </Text>
                </View>
                <Text className="font-bold text-emerald-700">− {formatBRL(p.amount_cents)}</Text>
              </Pressable>
            ))}
            <Text className="text-[10px] text-slate-400 text-center">
              Segure o pagamento por 3 segundos para excluir (com estorno total).
            </Text>
          </View>
        ) : null}
      </Card>

      {/* v21 (bug 4): modais de confirmação — exclusões só acontecem após confirmar */}
      <ConfirmDialog
        visible={confirm?.kind === 'tx'}
        title="Excluir lançamento da fatura?"
        message={confirm?.kind === 'tx' ? `"${confirm.label}" sai definitivamente do app e da fatura.` : undefined}
        buttons={[
          { label: 'Excluir', color: 'red', onPress: () => { if (confirm?.kind === 'tx') doExcluirTx(confirm.txId); setConfirm(null); } },
          { label: 'Cancelar', color: 'green', onPress: () => setConfirm(null) },
        ]}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        visible={confirm?.kind === 'parcela'}
        title="Excluir parcela(s) em aberto?"
        message={confirm?.kind === 'parcela' ? `"${confirm.label}": parcelas já pagas nunca são excluídas; o custo total é recalculado.` : undefined}
        buttons={
          confirm?.kind === 'parcela'
            ? [
                { label: `Excluir apenas a ${confirm.sequence}º parcela`, color: 'red', onPress: () => { doExcluirParcela(confirm.planId, confirm.sequence, true); setConfirm(null); } },
                { label: `Excluir da ${confirm.sequence}º em diante`, color: 'red', onPress: () => { doExcluirParcela(confirm.planId, confirm.sequence, false); setConfirm(null); } },
                { label: 'Cancelar', color: 'green', onPress: () => setConfirm(null) },
              ]
            : []
        }
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        visible={confirm?.kind === 'pagamento'}
        title="Excluir pagamento?"
        message={confirm?.kind === 'pagamento' ? `O pagamento de ${confirm.label} será apagado e o movimento ESTORNADO (a fatura volta a dever; a conta recebe o valor de volta).` : undefined}
        buttons={[
          { label: 'Excluir pagamento (estorna)', color: 'red', onPress: () => { if (confirm?.kind === 'pagamento') doExcluirPagamento(confirm.paymentId); setConfirm(null); } },
          { label: 'Cancelar', color: 'green', onPress: () => setConfirm(null) },
        ]}
        onClose={() => setConfirm(null)}
      />

    </Screen>
  );
}
