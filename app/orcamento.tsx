/**
 * Tela ORÇAMENTOS (v42) — cadastro do controle mensal de despesas por
 * categoria (item ▸ subitem). O usuário liga o módulo em Ajustes; a ação
 * "Orçamento" da tela inicial vem para cá.
 *
 * Regras (confirmadas com o usuário):
 *  · um orçamento por categoria, com valor mensal único que SE REPETE todo
 *    mês até desativar (sem calendário mês a mês);
 *  · "gastou" = tudo da categoria no mês (à vista em conta + contas fixas +
 *    parcelas + fatura de cartão) — cálculo no BudgetService;
 *  · abaixo do cadastro, o resumo do mês vigente com a BARRINHA de conclusão
 *    (orçado · gasto · falta) — o mesmo card aparece no Fluxo.
 *  · v67 (BUG 4) — ITEM ▸ SUBITEM: o orçamento do item pode ser COMPOSTO pelos
 *    subitens (pai R$ 100 = 60 + 40): cada subitem salva/edita/exclui o dele e
 *    o item mostra a soma; ao EXCLUIR o item com subitens orçados, o app
 *    PERGUNTA o destino: só o item (subitens ficam independentes) ou item +
 *    subitens juntos. Lançamentos nunca são afetados.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Screen, Card, Button, SectionTitle, EmptyState, ProgressBar } from '../src/components/ui';
import { MoneyInput } from '../src/components/MoneyInput';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { showToast } from '../lib/toast';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { formatBRL } from '../src/lib/money';
import { todaySP, monthOf, monthLabel } from '../src/lib/dates';
import type { BudgetRow, BudgetMonthSummary } from '../src/services/BudgetService';

interface CatOption {
  id: string;
  label: string;
  direction: string | null;
}

/** v67 (BUG 4): linha crua de categoria — para saber quem é subitem de quem. */
interface CatRowLite {
  id: string;
  parent_id: string | null;
}

export default function OrcamentoScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);

  const [cats, setCats] = React.useState<CatOption[]>([]);
  /** v67 (BUG 4): categorias cruas (id + parent) para a hierarquia item ▸ subitem. */
  const [catRows, setCatRows] = React.useState<CatRowLite[]>([]);
  const [catId, setCatId] = React.useState<string | null>(null);
  const [amount, setAmount] = React.useState(0);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [list, setList] = React.useState<BudgetRow[]>([]);
  const [summary, setSummary] = React.useState<BudgetMonthSummary | null>(null);
  const [deleting, setDeleting] = React.useState<BudgetRow | null>(null);
  const [busy, setBusy] = React.useState(false);

  const month = monthOf(todaySP());

  const load = React.useCallback(async () => {
    const rows = await services.categories.listActive();
    const options: CatOption[] = rows
      // orçamento é de DESPESA: só categorias Débito/Ambas
      .filter((c: { direction?: string | null }) => c.direction !== 'CREDIT')
      .map((c: { id: string; name: string; parent_id?: string | null; direction?: string | null }) => {
        const parent = rows.find((p: { id: string; name: string }) => p.id === c.parent_id);
        return {
          id: c.id,
          direction: c.direction ?? null,
          label: parent ? `${parent.name} ▸ ${c.name}` : c.name,
        };
      });
    setCats(options);
    // v67 (BUG 4): guarda id + parent_id de TODAS as categorias ativas
    setCatRows(rows.map((c: { id: string; parent_id?: string | null }) => ({ id: c.id, parent_id: c.parent_id ?? null })));
    setList(await services.budgets.list());
    setSummary(await services.budgets.getMonthSummary(month));
  }, [services, month]);

  useDataEffect(load);

  const startEdit = (b: BudgetRow) => {
    setEditingId(b.id);
    setCatId(b.category_id);
    setAmount(b.amount_cents);
  };

  const resetForm = () => {
    setEditingId(null);
    setCatId(null);
    setAmount(0);
  };

  const save = async () => {
    if (!catId) {
      showToast('Escolha a categoria (item ▸ subitem)', 'err');
      return;
    }
    if (amount <= 0) {
      showToast('Informe o valor mensal do orçamento', 'err');
      return;
    }
    setBusy(true);
    try {
      await services.budgets.save(catId, amount);
      showToast(editingId ? 'Orçamento atualizado' : 'Orçamento criado — vale todo mês até desativar');
      resetForm();
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (b: BudgetRow) => {
    try {
      await services.budgets.setActive(b.id, b.is_active !== 1);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      // v67 (BUG 4): padrão seguro — exclui SÓ o item; subitens ficam independentes.
      await services.budgets.removeWithStrategy(deleting.id, 'ONLY_THIS');
      showToast('Orçamento excluído — subitens continuam como estão');
      setDeleting(null);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v67 (BUG 4): excluir o item JUNTO com os orçamentos dos subitens. */
  const removeWithSubitems = async () => {
    if (!deleting) return;
    try {
      const n = await services.budgets.removeWithStrategy(deleting.id, 'WITH_SUBITEMS');
      showToast(`Orçamento excluído com ${Math.max(0, n - 1)} subitem(ns)`);
      setDeleting(null);
      bump();
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v67 (BUG 4): o orçamento excluído tem SUBITENS orçados? (define o diálogo) */
  const budgetHasSubBudgets = (b: BudgetRow): boolean => {
    const subCatIds = new Set(catRows.filter((c) => c.parent_id === b.category_id).map((c) => c.id));
    if (subCatIds.size === 0) return false;
    return list.some((o) => o.is_active === 1 && subCatIds.has(o.category_id));
  };

  /** v67 (BUG 4): quantos subitens orçados ativos o item tem (texto do diálogo). */
  const subBudgetCount = (b: BudgetRow): number => {
    const subCatIds = new Set(catRows.filter((c) => c.parent_id === b.category_id).map((c) => c.id));
    return list.filter((o) => o.is_active === 1 && subCatIds.has(o.category_id)).length;
  };

  return (
    <Screen title="Orçamento">
      <SectionTitle>{editingId ? 'Alterar orçamento' : 'Novo orçamento'}</SectionTitle>
      <Card className="gap-2">
        <Text className="text-xs text-slate-500">
          Categoria (item ▸ subitem) — o valor se repete TODO MÊS até você desativar. v67: orçando o item e os subitens, o item passa a mostrar a SOMA dos subitens (pai R$ 100 = 60 + 40) — sem contar em dobro.
        </Text>
        <View className="flex-row flex-wrap gap-1.5">
          {cats.map((c) => (
            <Text
              key={c.id}
              onPress={() => setCatId(catId === c.id ? null : c.id)}
              className={`text-[11px] px-2 py-1 rounded-full ${
                catId === c.id ? 'bg-emerald-600 text-white font-semibold' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {c.label}
            </Text>
          ))}
        </View>
        {cats.length === 0 ? (
          <Text className="text-xs text-slate-400">Nenhuma categoria de despesa ativa — crie em Cadastro › Categorias.</Text>
        ) : null}
        <MoneyInput label="Valor por mês" cents={amount} onChangeCents={setAmount} />
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button label={editingId ? 'Salvar alterações' : 'Salvar orçamento'} onPress={save} loading={busy} />
          </View>
          {editingId ? (
            <View className="flex-1">
              <Button label="Cancelar" variant="outline" onPress={resetForm} />
            </View>
          ) : null}
        </View>
      </Card>

      <SectionTitle>{monthLabel(month)} — como está</SectionTitle>
      {!summary || summary.items.length === 0 ? (
        <Card>
          <Text className="text-slate-500 text-sm">
            Nenhum orçamento ativo ainda — cadastre acima para acompanhar aqui e no Fluxo.
          </Text>
        </Card>
      ) : (
        <>
          <Card>
            <View className="flex-row justify-between items-center">
              <Text className="font-semibold text-slate-900">Total dos orçamentos</Text>
              <Text className={`font-bold ${summary.remainingCents < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                falta {formatBRL(summary.remainingCents)}
              </Text>
            </View>
            <Text className="text-xs text-slate-500 mt-0.5">
              Orçado {formatBRL(summary.budgetedCents)} · gasto {formatBRL(summary.spentCents)}
            </Text>
          </Card>
          {summary.items.map((it) => (
            <Card
              key={it.budgetId}
              className={`!py-3 ${it.partOfParent ? 'ml-4 border-dashed' : ''}`}
            >
              <View className="flex-row justify-between items-start gap-2">
                <Text className="font-semibold text-slate-900 flex-1" numberOfLines={1}>
                  {/* v67 (BUG 4): subitem recua (parte do item); item composto mostra a soma */}
                  {it.partOfParent ? '↳ ' : ''}{it.label}
                  {it.composedFromSubs ? ' (soma dos subitens)' : ''}
                </Text>
                <Text className={`text-sm font-bold ${it.remainingCents < 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                  {formatBRL(it.remainingCents)}
                </Text>
              </View>
              <ProgressBar pct={it.pct} className="mt-1.5" />
              <Text className="text-[11px] text-slate-500 mt-1">
                Orçado {formatBRL(it.amountCents)} · gasto {formatBRL(it.spentCents)} · falta {formatBRL(it.remainingCents)} ({it.pct}%)
                {it.partOfParent ? ' · compõe o item' : ''}
              </Text>
            </Card>
          ))}
        </>
      )}

      <SectionTitle>Meus orçamentos ({list.length})</SectionTitle>
      {list.length === 0 ? (
        <EmptyState icon="📊" title="Nenhum orçamento" hint="Cadastre acima: escolha a categoria e o valor mensal." />
      ) : (
        list.map((b) => (
          <Card key={b.id} className="!py-3">
            <View className="flex-row justify-between items-center gap-2">
              <View className="flex-1">
                <Text className="font-semibold text-slate-900" numberOfLines={1}>
                  {b.parent_name ? `${b.parent_name} ▸ ${b.category_name}` : b.category_name}
                  {b.is_active !== 1 ? '  ·  inativo' : ''}
                </Text>
                <Text className="text-xs text-slate-500">{formatBRL(b.amount_cents)} por mês</Text>
              </View>
              <Pressable onPress={() => toggleActive(b)} className="bg-slate-100 rounded-lg px-2.5 py-1.5">
                <Text className="text-xs font-semibold text-slate-600">{b.is_active === 1 ? 'Desativar' : 'Ativar'}</Text>
              </Pressable>
              <Pressable onPress={() => startEdit(b)} className="bg-sky-50 rounded-lg px-2.5 py-1.5">
                <Text className="text-xs font-semibold text-sky-700">Alterar</Text>
              </Pressable>
              <Pressable onPress={() => setDeleting(b)} className="bg-rose-50 rounded-lg px-2.5 py-1.5">
                <Text className="text-xs font-semibold text-rose-600">Excluir</Text>
              </Pressable>
            </View>
          </Card>
        ))
      )}

      <ConfirmDialog
        visible={deleting != null}
        title="Excluir orçamento?"
        message={
          deleting
            ? budgetHasSubBudgets(deleting)
              ? `"${deleting.parent_name ? `${deleting.parent_name} ▸ ${deleting.category_name}` : deleting.category_name}" tem ${subBudgetCount(deleting)} subitem(ns) orçado(s). O que fazer com eles? Lançamentos nunca são afetados.`
              : `"${deleting.parent_name ? `${deleting.parent_name} ▸ ${deleting.category_name}` : deleting.category_name}" (${formatBRL(deleting.amount_cents)}/mês) sai da lista e do card no Fluxo. Lançamentos não são afetados.`
            : undefined
        }
        buttons={
          deleting && budgetHasSubBudgets(deleting)
            ? [
                // v67 (BUG 4): destino dos SUBITENS na exclusão do item
                { label: 'Só o item — subitens ficam independentes', color: 'red', onPress: remove },
                { label: 'Item + subitens', color: 'red', onPress: removeWithSubitems },
                { label: 'Cancelar', color: 'green', onPress: () => setDeleting(null) },
              ]
            : [
                { label: 'Excluir', color: 'red', onPress: remove },
                { label: 'Cancelar', color: 'green', onPress: () => setDeleting(null) },
              ]
        }
        onClose={() => setDeleting(null)}
      />
    </Screen>
  );
}
