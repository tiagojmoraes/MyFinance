/**
 * Tela PLANO (v21, bug 1) — edição ESPECÍFICA do parcelamento.
 *
 * O "Alterar" de um lançamento PARCELADO (no Fluxo, na fatura ou dentro do
 * consolidado) abre ESTA tela — não mais a lista genérica de Parcelamentos.
 * Aqui TODOS os campos do lançamento parcelado podem ser alterados, tanto em
 * CONTA quanto em CARTÃO DE CRÉDITO:
 *   · Descrição, categoria e data da compra (âncora do plano);
 *   · Modo de cálculo "Dividir total" / "Parcela fixa" e o valor — valem para
 *     as parcelas EM ABERTO (pagas ficam intocadas);
 *   · Número de parcelas (cria novas ou cancela excedentes em aberto);
 *   · Data da 1ª parcela em aberto (desloca os vencimentos seguintes);
 *   · Destino: conta ⇄ cartão (migra as parcelas em aberto).
 * Regra: a modificação reflete ESTRITAMENTE no campo alterado — nada do que
 * não foi tocado muda, parcelas pagas nunca são afetadas.
 * v21 (bug 4): salvar exige CONFIRMAÇÃO (modal) antes de efetivar.
 */

import React from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen, Card, TextField, Select, Button, DateField, Segmented } from '../../src/components/ui';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { MoneyInput } from '../../src/components/MoneyInput';
import { CategorySelect } from '../../src/components/CategorySelect';
import { useDataEffect } from '../../src/components/useDataEffect';
import { useAppStore } from '../../src/store/appStore';
import { showToast } from '../../lib/toast';
import { formatBRL, divideCents } from '../../src/lib/money';

type CategoryOption = { id: string; name: string; parent_id: string | null; icon: string | null; direction: string };

export default function PlanoEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);

  const [loading, setLoading] = React.useState(true);
  const [type, setType] = React.useState<'EXPENSE' | 'INCOME'>('EXPENSE');
  const [description, setDescription] = React.useState('');
  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [purchaseDate, setPurchaseDate] = React.useState('');
  const [mode, setMode] = React.useState<'DIVIDE_TOTAL' | 'FIXED_PER_MONTH'>('DIVIDE_TOTAL');
  const [divideTotalCents, setDivideCents] = React.useState(0);
  const [fixedCents, setFixedCents] = React.useState(0);
  const [totalInst, setTotalInst] = React.useState('');
  const [firstPendingDue, setFirstPendingDue] = React.useState<string | null>(null);
  const [destino, setDestino] = React.useState<'ACCOUNT' | 'CARD'>('ACCOUNT');
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [cardId, setCardId] = React.useState<string | null>(null);

  const [accounts, setAccounts] = React.useState<Array<{ id: string; label: string }>>([]);
  const [cards, setCards] = React.useState<Array<{ id: string; label: string }>>([]);
  const [categories, setCategories] = React.useState<CategoryOption[]>([]);
  const [paidCount, setPaidCount] = React.useState(0);
  const [pendingCount, setPendingCount] = React.useState(0);
  const [firstPendingSeq, setFirstPendingSeq] = React.useState<number | null>(null);
  const [totalInstOriginal, setTotalInstOriginal] = React.useState(0);

  // v21 (bug 4): confirmação antes de salvar
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  useDataEffect(async (svc) => {
    const data = await svc.installments.getPlanEditData(id);
    if (!data) {
      showToast('Parcelamento não encontrado', 'err');
      router.back();
      return;
    }
    setType(data.anchor?.type === 'INCOME' ? 'INCOME' : 'EXPENSE');
    setDescription(data.anchor?.description ?? '');
    setCategoryId(data.anchor?.categoryId ?? null);
    setPurchaseDate(data.anchor?.occurredOn ?? data.plan.first_due_date);
    setMode(data.plan.mode);
    setDivideCents(data.plan.total_cents ?? 0);
    setFixedCents(data.plan.fixed_amount_cents ?? 0);
    setTotalInst(String(data.installments.length));
    setTotalInstOriginal(data.installments.length);
    setFirstPendingDue(data.firstPending?.due_date ?? null);
    setFirstPendingSeq(data.firstPending?.sequence_number ?? null);
    setPaidCount(data.paidCount);
    setPendingCount(data.pendingCount);
    if (data.plan.card_id) {
      setDestino('CARD');
      setCardId(data.plan.card_id);
    } else {
      setDestino('ACCOUNT');
      setAccountId(data.plan.account_id);
    }
    const [accs, cds, cats] = await Promise.all([
      svc.db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE archived_at IS NULL ORDER BY name'),
      svc.db.getAllAsync<{ id: string; name: string; last_four_digits: string | null }>('SELECT id, name, last_four_digits FROM cards WHERE archived_at IS NULL ORDER BY name'),
      svc.db.getAllAsync<CategoryOption>('SELECT id, name, parent_id, icon, direction FROM categories WHERE archived_at IS NULL ORDER BY name'),
    ]);
    setAccounts(accs.map((a) => ({ id: a.id, label: a.name })));
    setCards(cds.map((c) => ({ id: c.id, label: c.last_four_digits ? `${c.name} ••${c.last_four_digits}` : c.name })));
    setCategories(cats);
    setLoading(false);
  }, [id]);

  /** Quantas parcelas EM ABERTO existirão após o novo total (prévia ao vivo). */
  const pendCountPreview = (() => {
    const n = parseInt(totalInst, 10);
    if (!Number.isInteger(n) || n < 1) return pendingCount;
    if (n >= totalInstOriginal) return pendingCount + (n - totalInstOriginal);
    return Math.max(n - paidCount, 0);
  })();

  const previewParcelas = (() => {
    const cnt = Math.max(pendCountPreview, 0);
    if (cnt === 0) return null;
    if (mode === 'FIXED_PER_MONTH') {
      return `Serão ${cnt} parcela(s) em aberto de ${formatBRL(fixedCents)} — total ${formatBRL(fixedCents * cnt)}. As ${paidCount} paga(s) ficam intactas.`;
    }
    if (divideTotalCents <= 0) return null;
    const parts = divideCents(divideTotalCents, cnt);
    const resto = parts[parts.length - 1] !== parts[0];
    return `Cada parcela: ${formatBRL(parts[0])}${resto ? ` · última ${formatBRL(parts[parts.length - 1])} (ajuste de centavos)` : ` × ${cnt}`} — as ${paidCount} paga(s) ficam intactas.`;
  })();

  const save = async () => {
    setSaving(true);
    try {
      const n = parseInt(totalInst, 10);
      const patch: Parameters<typeof services.installments.updatePlanFields>[1] = {};
      if (description.trim()) patch.description = description.trim();
      patch.categoryId = categoryId;
      if (purchaseDate) patch.purchaseDate = purchaseDate;
      patch.mode = mode;
      if (mode === 'FIXED_PER_MONTH') patch.fixedAmountCents = fixedCents;
      else patch.divideTotalCents = divideTotalCents;
      if (Number.isInteger(n) && n >= 1 && n !== totalInstOriginal) patch.totalInstallments = n;
      if (firstPendingDue) patch.firstPendingDueDate = firstPendingDue;
      if (destino === 'ACCOUNT') {
        if (!accountId) throw new Error('Selecione a conta');
        patch.accountId = accountId;
        patch.cardId = null;
      } else {
        if (!cardId) throw new Error('Selecione o cartão');
        patch.cardId = cardId;
        patch.accountId = null;
      }
      await services.installments.updatePlanFields(id, patch);
      bump();
      showToast('Parcelamento atualizado');
      router.replace('/fluxo');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
      setConfirmOpen(false);
    }
  };

  const isIncome = type === 'INCOME';

  return (
    <Screen
      title="Alterar parcelamento"
      subtitle={`${paidCount}/${totalInstOriginal || '?'} pagas · as alterações valem das parcelas em aberto em diante`}
    >
      {loading ? (
        <Card><Text className="text-slate-500">Carregando...</Text></Card>
      ) : (
        <>
          <Card className="gap-3">
            <Segmented<'DIVIDE_TOTAL' | 'FIXED_PER_MONTH'>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'DIVIDE_TOTAL', label: 'Dividir total' },
                { value: 'FIXED_PER_MONTH', label: 'Parcela fixa' },
              ]}
              activeBg={isIncome ? 'bg-emerald-600' : 'bg-rose-600'}
            />
            <TextField label="Descrição" value={description} onChangeText={setDescription} placeholder="Ex.: Notebook" />
            <CategorySelect
              label="Categoria (opcional)"
              categories={categories}
              value={categoryId}
              onChange={setCategoryId}
              filter={isIncome ? 'CREDIT' : 'DEBIT'}
              allowEmpty
            />
            <DateField label="Data da compra" value={purchaseDate} onChange={setPurchaseDate} />
            {/* v22 (bug 2): deixa claro qual campo move os vencimentos — a data
                da compra é o registro histórico; o vencimento fica no bloco abaixo */}
            <Text className="text-xs text-slate-500">
              A data da compra é o registro histórico do parcelamento. Para mudar os vencimentos das parcelas em aberto, use o campo "Vencimento da 1ª parcela em aberto" mais abaixo — a nova data vale no mesmo mês (mudando o dia) ou em outro mês.
            </Text>
          </Card>

          <Card className="gap-3 mt-3">
            <Text className="text-sm font-semibold text-slate-900">Valores — valem das parcelas em aberto em diante</Text>
            {mode === 'FIXED_PER_MONTH' ? (
              <MoneyInput label="Valor da parcela (R$)" cents={fixedCents} onChangeCents={setFixedCents} />
            ) : (
              <MoneyInput label="Total restante (R$)" cents={divideTotalCents} onChangeCents={setDivideCents} />
            )}
            {previewParcelas ? (
              <Text className="text-[11px] text-violet-700 bg-violet-50 rounded-lg px-2.5 py-1.5">{previewParcelas}</Text>
            ) : null}
          </Card>

          <Card className="gap-3 mt-3">
            <TextField label="Número de parcelas" value={totalInst} onChangeText={setTotalInst} keyboardType="numeric" placeholder="Ex.: 12" />
            <Text className="text-xs text-slate-500">
              Aumentar cria novas parcelas continuando os vencimentos; diminuir cancela as em aberto que sobrarem.
              {'\n'}Parcelas JÁ PAGAS nunca são alteradas.
            </Text>
            <DateField
              label="Vencimento da 1ª parcela em aberto"
              value={firstPendingDue ?? ''}
              onChange={(v) => setFirstPendingDue(v)}
            />
            <Text className="text-xs text-slate-500">
              {firstPendingSeq
                ? `Desloca os vencimentos da ${firstPendingSeq}º parcela em diante (fatura e conta acompanham).`
                : 'Todas as parcelas já foram pagas.'}
            </Text>
          </Card>

          <Card className="gap-3 mt-3">
            <Text className="text-sm font-semibold text-slate-900">Destino das parcelas em aberto</Text>
            <Segmented<'ACCOUNT' | 'CARD'>
              value={destino}
              onChange={setDestino}
              options={[
                { value: 'ACCOUNT', label: 'Conta' },
                { value: 'CARD', label: 'Cartão de crédito' },
              ]}
              activeBg={isIncome ? 'bg-emerald-600' : 'bg-rose-600'}
            />
            {destino === 'ACCOUNT' ? (
              <Select label="Conta" items={accounts} selectedId={accountId} onSelect={setAccountId} />
            ) : (
              <Select label="Cartão de crédito" items={cards} selectedId={cardId} onSelect={setCardId} />
            )}
            <Text className="text-xs text-slate-500">
              Mudar o destino move as parcelas EM ABERTO (as pagas ficam onde estão, no histórico).
            </Text>
          </Card>

          <View className="mt-4 gap-2">
            <Button label="Salvar alterações" onPress={() => setConfirmOpen(true)} loading={saving} bg={isIncome ? 'bg-emerald-600' : 'bg-rose-600'} />
            <Button label="Cancelar" variant="outline" onPress={() => router.back()} />
          </View>

          <View className="mt-3">
            <Card className="gap-1.5">
              <Text className="text-xs font-semibold uppercase text-slate-500">Resumo</Text>
              <Text className="text-[11px] text-slate-500">
                {paidCount} paga(s) · {pendingCount} em aberto — a edição de valores/data/destino atinge apenas as em aberto; descrição, categoria e data da compra valem para o parcelamento inteiro.
              </Text>
            </Card>
          </View>
        </>
      )}

      <ConfirmDialog
        visible={confirmOpen}
        title="Confirmar alterações?"
        message={
          `"${description.trim() || 'Parcelamento'}" será atualizado com os campos que você mudou.` +
          `\nParcelas pagas (${paidCount}) ficam intactas.`
        }
        buttons={[
          { label: 'Salvar alterações', color: 'green', onPress: save },
          { label: 'Cancelar', color: 'red', onPress: () => setConfirmOpen(false) },
        ]}
        onClose={() => setConfirmOpen(false)}
      />
    </Screen>
  );
}
