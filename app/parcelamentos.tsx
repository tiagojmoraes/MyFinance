/** Tela Parcelamentos — HISTÓRICO completo dos planos (v11, Req 4):
 *  · A criação mudou de lugar: o submenu "Novo plano" foi EXTINTO. O
 *    parcelamento é criado no Novo Lançamento > Despesa > Parcelado, com os
 *    modos "Dividir total" e "Parcela fixa" (migrados para o formulário).
 *  · Aqui fica a visão dual de cada plano: fluxo mensal (vencimentos) ×
 *    custo total (data da compra), com alteração de valores "da atual em
 *    diante" e exclusão de parcelas em aberto (pagas ficam intocadas).
 *  v17 (bug 3): "Alterar valores (da atual em diante)" passa a oferecer
 *    OBRIGATORIAMENTE os 2 modos de cálculo — "Dividir total" e "Parcela
 *    fixa" — exatamente como no Novo Lançamento (o modo escolhido passa a
 *    valer para o plano).
 *  v17 (melhoria 1): em "Dividir total" o VALOR EXATO de cada parcela é
 *    calculado e exibido na hora (resto de centavos vai para a última).
 *  v18 (bug 5): a tela aceita o parâmetro ?plan=<id> — o "Alterar" de uma
 *    parcela no Fluxo/fatura abre DIRETO a visão dual do plano (edição do
 *    parcelamento), sem passar pela lista; e o "Fluxo mensal (caixa)" não
 *    lista mais parcelas excluídas (sincronizado com o Fluxo na hora).
 */

import React from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Screen, Card, Button, EmptyState, SectionTitle, InstallmentPill, Segmented } from '../src/components/ui';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { MoneyInput } from '../src/components/MoneyInput';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';
import { formatBRL, divideCents } from '../src/lib/money';
import { ymdToBr } from '../src/lib/dates';

export default function ParcelamentosScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  // v18 (bug 5): ?plan=<id> abre a visão dual do plano direto (vem do
  // "Alterar" da parcela no Fluxo/fatura)
  const params = useLocalSearchParams<{ plan?: string }>();
  const [plans, setPlans] = React.useState<Array<{ id: string; description: string; total_installments: number; paid_count: number; first_due_date: string; mode: string }>>([]);

  // Visão dual do plano selecionado
  const [selectedDual, setSelectedDual] = React.useState<{
    planId: string;
    description: string;
    mode: string;
    totalInstallments: number;
    paidCount: number;
    firstPending: { sequence: number; dueDate: string } | null;
    pendingCount: number;
    cashFlow: Array<{ sequence: number; dueDate: string; amountCents: number; status: string }>;
    cost: { occurredOn: string; totalCents: number };
  } | null>(null);
  // Edição de valores (v7.0.5): da parcela atual em diante
  const [editOpen, setEditOpen] = React.useState(false);
  const [editCents, setEditCents] = React.useState(0);
  // v17 (bug 3): o MODO de cálculo é escolhido na edição — Dividir total ou
  // Parcela fixa (os dois, sempre; default = modo de origem do plano)
  const [editMode, setEditMode] = React.useState<'DIVIDE_TOTAL' | 'FIXED_PER_MONTH'>('DIVIDE_TOTAL');
  // Exclusão (v7.0.6) — v21 (bug 4): MODAL de confirmação com os 2 escopos
  const [delOpen, setDelOpen] = React.useState(false);
  /** v21 (bug 4): confirmação da alteração de valores antes de efetivar. */
  const [editConfirmOpen, setEditConfirmOpen] = React.useState(false);

  useDataEffect(async (svc) => {
    const list = await svc.installments.listPlans();
    const mapped = list.map((p) => ({
      id: p.id,
      description: p.description ?? 'Parcelamento',
      total_installments: p.total_installments,
      paid_count: p.paid_count,
      first_due_date: p.first_due_date,
      mode: p.mode,
    }));
    setPlans(mapped);
    // v18 (bug 5): deep-link do "Alterar" da parcela — abre a visão dual
    const planParam = typeof params.plan === 'string' ? params.plan : '';
    if (planParam) {
      const target = mapped.find((p) => p.id === planParam);
      if (target) await openDual(target.id, target.description);
    }
  });

  const openDual = async (planId: string, description: string) => {
    const dual = await services.installments.getDualView(planId);
    if (!dual) return;
    const paidCount = dual.cashFlow.filter((c) => c.status === 'PAID').length;
    const firstP = dual.cashFlow.find((c) => c.status === 'PENDING');
    setSelectedDual({
      planId,
      description,
      mode: dual.plan.mode,
      totalInstallments: dual.plan.total_installments,
      paidCount,
      firstPending: firstP ? { sequence: firstP.sequence, dueDate: firstP.dueDate } : null,
      pendingCount: dual.cashFlow.filter((c) => c.status === 'PENDING').length,
      cashFlow: dual.cashFlow,
      cost: { occurredOn: dual.costReport.occurredOn, totalCents: dual.costReport.totalCents },
    });
    setEditOpen(false);
    setEditCents(0);
    setEditMode(dual.plan.mode); // v17 (bug 3): edição começa no modo do plano
    setDelOpen(false);
  };

  /** Exclui parcelas em aberto (v7.0.6) — pagas ficam intocadas (ARQ-005).
   *  v21 (bug 4): só chega aqui após o modal de confirmação. */
  const doDelete = async (onlyCurrent: boolean) => {
    if (!selectedDual) return;
    try {
      await services.installments.cancelFromCurrent(selectedDual.planId, { onlyCurrent });
      setDelOpen(false);
      await openDual(selectedDual.planId, selectedDual.description);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v19: salvava direto — v21 (bug 4): volta a PEDIR CONFIRMAÇÃO (modal),
   *  com o escopo da mudança claro no próprio formulário. */
  const applyEdit = async () => {
    if (!selectedDual) return;
    const fp = selectedDual.firstPending;
    if (!fp) {
      showToast('Todas as parcelas já foram pagas ou canceladas.', 'err');
      return;
    }
    if (editCents <= 0) {
      showToast(
        editMode === 'FIXED_PER_MONTH' ? 'Informe o novo valor da parcela.' : 'Informe o novo total restante.',
        'err'
      );
      return;
    }
    try {
      await services.installments.updateFromCurrent(
        selectedDual.planId,
        // v17 (bug 3): os DOIS modos estão disponíveis na edição — o
        // escolhido é enviado e passa a valer para o plano
        editMode === 'FIXED_PER_MONTH'
          ? { mode: editMode, fixedAmountCents: editCents }
          : { mode: editMode, remainingTotalCents: editCents }
      );
      setEditOpen(false);
      setEditCents(0);
      await openDual(selectedDual.planId, selectedDual.description);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  return (
    <Screen title="Parcelamentos" subtitle="Histórico dos planos · criar agora só no Novo Lançamento">
      {plans.length === 0 ? (
        <EmptyState
          icon="📦"
          title="Nenhum parcelamento"
          hint="Crie em Novo Lançamento > Despesa > Parcelado (Dividir total ou Parcela fixa)."
        />
      ) : (
        plans.map((p) => (
          <Card key={p.id} className="!py-3">
            <View className="flex-row justify-between items-center gap-2">
              <Text className="font-semibold text-slate-900 flex-1" numberOfLines={2}>{p.description}</Text>
              {p.total_installments > 1 ? (
                <InstallmentPill current={Math.min(p.paid_count + 1, p.total_installments)} total={p.total_installments} />
              ) : null}
            </View>
            <Text className="text-xs text-slate-500 mt-0.5">
              {p.paid_count}/{p.total_installments} pagas · 1ª em {ymdToBr(p.first_due_date)} · {p.mode === 'DIVIDE_TOTAL' ? 'divide total' : 'valor fixo'}
            </Text>
            <View className="mt-2">
              <Button label="Ver visão dual" variant="outline" onPress={() => openDual(p.id, p.description)} />
            </View>
          </Card>
        ))
      )}

      {selectedDual ? (
        <>
          <SectionTitle>Dual: {selectedDual.description}</SectionTitle>
          <Card>
            <Text className="text-xs font-semibold uppercase text-slate-500">Custo total (relatório de custo)</Text>
            <Text className="font-bold text-rose-600 text-lg">
              {formatBRL(selectedDual.cost.totalCents)}{' '}
              <Text className="text-xs font-medium text-slate-500">na compra de {ymdToBr(selectedDual.cost.occurredOn)}</Text>
            </Text>
            <Text className="text-[11px] text-amber-600 mt-1">Regra de ouro: nunca somar fluxo e custo no mesmo relatório.</Text>
          </Card>
          <Card>
            <Text className="text-xs font-semibold uppercase text-slate-500 mb-2">Fluxo mensal (caixa)</Text>
            {selectedDual.cashFlow.map((c) => (
              <View key={c.sequence} className="flex-row justify-between items-center py-1">
                <View className="flex-row items-center gap-2 flex-1">
                  <InstallmentPill current={c.sequence} total={selectedDual.cashFlow.length} />
                  <Text className="text-sm text-slate-600">{c.sequence}º · {ymdToBr(c.dueDate)}</Text>
                </View>
                <Text className={`text-sm font-semibold ${c.status === 'PAID' ? 'text-emerald-600' : 'text-slate-900'}`}>
                  {formatBRL(c.amountCents)}{c.status === 'PAID' ? ' ✓' : ''}
                </Text>
              </View>
            ))}
          </Card>
          {selectedDual.firstPending ? (
            <>
              <Button
                label={editOpen ? 'Fechar edição' : 'Alterar valores (da atual em diante)'}
                variant="outline"
                onPress={() => setEditOpen(!editOpen)}
              />
              <Button label="Excluir parcela(s) em aberto…" variant="danger" onPress={() => setDelOpen(!delOpen)} />
              {editOpen ? (
                <Card className="gap-3">
                  <Text className="text-sm font-semibold text-slate-900">
                    {/* v17 (bug 3): os DOIS modos de cálculo, igual ao Novo Lançamento */}
                    Alterar valores — da {selectedDual.firstPending.sequence}º parcela em diante
                  </Text>
                  <Segmented<'DIVIDE_TOTAL' | 'FIXED_PER_MONTH'>
                    value={editMode}
                    onChange={setEditMode}
                    options={[
                      { value: 'DIVIDE_TOTAL', label: 'Dividir total' },
                      { value: 'FIXED_PER_MONTH', label: 'Parcela fixa' },
                    ]}
                  />
                  <MoneyInput
                    label={editMode === 'FIXED_PER_MONTH' ? 'Valor da parcela (R$)' : 'Total restante (R$)'}
                    cents={editCents}
                    onChangeCents={(c) => { setEditCents(c); }}
                  />
                  {/* v17 (melhoria 1): o valor exato de CADA parcela aparece na hora */}
                  {editMode === 'FIXED_PER_MONTH' ? (
                    <Text className="text-xs text-slate-500">
                      {selectedDual.pendingCount} parcela(s) de {formatBRL(editCents)} — total {formatBRL(editCents * selectedDual.pendingCount)}
                    </Text>
                  ) : editCents > 0 && selectedDual.pendingCount > 0 ? (
                    <Text className="text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1.5">
                      {(() => {
                        const parts = divideCents(editCents, selectedDual.pendingCount);
                        const resto = parts[parts.length - 1] !== parts[0];
                        return `Cada parcela: ${formatBRL(parts[0])}${resto ? ` · última parcela ${formatBRL(parts[parts.length - 1])} (ajuste de centavos)` : ` × ${selectedDual.pendingCount}`}`;
                      })()}
                    </Text>
                  ) : null}
                  <Text className="text-xs text-slate-500">
                    Válido da {selectedDual.firstPending.sequence}º parcela ({ymdToBr(selectedDual.firstPending.dueDate)}) em diante
                    ({selectedDual.pendingCount} em aberto). As {selectedDual.paidCount} já paga(s) ficam intactas.
                  </Text>
                  <Button label="Salvar novos valores" onPress={() => setEditConfirmOpen(true)} />
                </Card>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {/* v21 (bug 4): MODAL de confirmação da exclusão — com os DOIS escopos
          (apenas a atual / da atual em diante) e o aviso das pagas */}
      <ConfirmDialog
        visible={delOpen}
        title="Excluir parcela(s) em aberto?"
        message={
          selectedDual
            ? `Pagamentos já efetivados NÃO são excluídos — as ${selectedDual.paidCount} parcela(s) paga(s) ficam intactas e o custo total é recalculado (pagas + restante).`
            : undefined
        }
        buttons={
          selectedDual && selectedDual.firstPending
            ? [
                {
                  label: `Excluir apenas a ${selectedDual.firstPending.sequence}º — ${formatBRL(firstPendingCents(selectedDual.cashFlow))}`,
                  color: 'red',
                  onPress: () => doDelete(true),
                },
                {
                  label: `Excluir da ${selectedDual.firstPending.sequence}º em diante — ${formatBRL(firstPendingCents(selectedDual.cashFlow))}`,
                  color: 'red',
                  onPress: () => doDelete(false),
                },
                { label: 'Cancelar', color: 'green', onPress: () => setDelOpen(false) },
              ]
            : []
        }
        onClose={() => setDelOpen(false)}
      />

      {/* v21 (bug 4): confirmação da ALTERAÇÃO de valores */}
      <ConfirmDialog
        visible={editConfirmOpen}
        title="Confirmar alteração de valores?"
        message={
          selectedDual && selectedDual.firstPending
            ? `Da ${selectedDual.firstPending.sequence}º parcela (${ymdToBr(selectedDual.firstPending.dueDate)}) em diante (${selectedDual.pendingCount} em aberto). As ${selectedDual.paidCount} já paga(s) ficam intactas.`
            : undefined
        }
        buttons={[
          { label: 'Salvar novos valores', color: 'green', onPress: applyEdit },
          { label: 'Cancelar', color: 'red', onPress: () => setEditConfirmOpen(false) },
        ]}
        onClose={() => setEditConfirmOpen(false)}
      />
    </Screen>
  );
}

/** Valor da 1ª parcela em aberto (exibido nos botões do diálogo). */
function firstPendingCents(cashFlow: Array<{ sequence: number; dueDate: string; amountCents: number; status: string }>): number {
  return cashFlow.find((c) => c.status === 'PENDING')?.amountCents ?? 0;
}
