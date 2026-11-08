/** Tela Categorias (v7.1→v70) — categorias e subcategorias com PICTOGRAMA,
 *  associadas a Débito (despesa) ou Crédito (receita).
 *  v8 (semântica de cores): DÉBITO = VERMELHO, CRÉDITO = VERDE.
 *  v70 (MELHORIA 2.3): criar/editar categoria abrem a TELA PRÓPRIA
 *  /categoria-nova (antes o formulário abria embaixo da lista).
 *  v68 — SUBCATEGORIA SEM CONFUSÃO: dentro do cartão da categoria, o botão
 *  "+ Subcategoria" abre o campo de nome ALI MESMO (mantido — é só o nome,
 *  digitou, salvou, pronto: nasce com a direção e o pictograma da mãe).
 *  v17 (melhoria 5) — REGRAS DE EXCLUSÃO E ARQUIVAMENTO:
 *   · COM movimentação vinculada (lançamento, produto, conta fixa ou
 *     subcategoria): a ÚNICA opção é ARQUIVAR — sai das escolhas de novo
 *     lançamento e o histórico fica preservado (pode ser desarquivada).
 *   · SEM NENHUMA movimentação: a opção é EXCLUIR definitivamente.
 *   · Arquivadas ficam na seção "Arquivadas" com botão Desarquivar.
 */

import React from 'react';
import { View, Text,  Pressable } from 'react-native';
import { router } from 'expo-router';
import { showToast } from '../lib/toast';
import { Screen, Card, TextField, Button, Segmented, EmptyState, SectionTitle } from '../src/components/ui';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { ICONS, CATEGORY_ICON_OPTIONS, type CategoryDirection } from '../src/theme/icons';
import { kindTheme } from '../src/theme';

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  icon: string | null;
  direction: string;
  archived_at: string | null;
}

type DirFilter = 'DEBIT' | 'CREDIT';

export default function CategoriasScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [cats, setCats] = React.useState<CategoryRow[]>([]);
  const [filter, setFilter] = React.useState<DirFilter>('DEBIT');
  /** v17 (melhoria 5): total de vínculos por categoria (movimentação/produto/regra/sub). */
  const [usageById, setUsageById] = React.useState<Record<string, number>>({});

  // v70 (MELHORIA 2.3): o formulário de criar/editar virou a TELA PRÓPRIA
  // /categoria-nova — nada de form embaixo da lista.

  // v68 — SUBCATEGORIA INLINE: campo de nome dentro do cartão da categoria
  const [subOpenFor, setSubOpenFor] = React.useState<string | null>(null);
  const [subName, setSubName] = React.useState('');
  const [subSaving, setSubSaving] = React.useState(false);
  const saveSub = async (parent: CategoryRow) => {
    const nm = subName.trim();
    if (!nm) {
      showToast('Informe o nome da subcategoria', 'err');
      return;
    }
    setSubSaving(true);
    try {
      // Nasce com a direção e o pictograma da mãe — zero configuração extra
      await services.categories.create({ name: nm, direction: (parent.direction as CategoryDirection) ?? 'DEBIT', icon: parent.icon ?? CATEGORY_ICON_OPTIONS[0], parentId: parent.id });
      setSubName('');
      setSubOpenFor(null);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSubSaving(false);
    }
  };

  // Exclusão / arquivamento (v17 — regra por uso)

  const load = React.useCallback(async (svc: typeof services) => {
    const rows = await svc.categories.list();
    setCats(rows as unknown as CategoryRow[]);
    // v17 (melhoria 5): uso de cada categoria — decide entre Excluir e Arquivar
    const usage: Record<string, number> = {};
    for (const c of rows) {
      const u = await svc.categories.usageCount(c.id);
      usage[c.id] = u.total;
    }
    setUsageById(usage);
  }, [services]);

  useDataEffect(async (svc) => {
    await load(svc);
  });

  const mains = cats.filter((c) => !c.parent_id && c.direction === filter && !c.archived_at);
  const archived = cats.filter((c) => c.archived_at);
  const subsOf = (id: string) => cats.filter((c) => c.parent_id === id && !c.archived_at);

  /** v70: criação na TELA PRÓPRIA (pré-ajusta a direção do filtro atual). */
  const openCreate = () => {
    router.push({ pathname: '/categoria-nova', params: { dir: filter } });
  };

  /** v70: edição na TELA PRÓPRIA. */
  const openEdit = (c: CategoryRow) => {
    router.push({ pathname: '/categoria-nova', params: { edit: c.id } });
  };

  /** v21 (bug 4): exclusão de categoria com CONFIRMAÇÃO (modal) — o botão só
   *  existe para categoria sem NENHUMA movimentação. */
  const [deleteConfirm, setDeleteConfirm] = React.useState<CategoryRow | null>(null);
  const doDelete = async (cat: CategoryRow) => {
    try {
      await services.categories.remove(cat.id);
      setDeleteConfirm(null);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v17 (melhoria 5): arquivar/desarquivar — com movimentação é a única saída. */
  /** v17 (melhoria 5): arquivar/desarquivar — v19 direto, sem diálogo. */
  const doArchive = async (cat: CategoryRow) => {
    try {
      await services.categories.setArchived(cat.id, !cat.archived_at);
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v17 (melhoria 5): ação da linha — categoria EM USO só tem ARQUIVAR;
   *  categoria nunca usada tem EXCLUIR. */
  const renderLifecycleAction = (c: CategoryRow) => {
    if (c.archived_at) {
      return (
        <Pressable
          onPress={() => doArchive(c)}
          accessibilityRole="button"
          accessibilityLabel={`Desarquivar ${c.name}`}
          className="bg-emerald-50 rounded-lg px-2 py-1.5"
        >
          <Text className="text-[11px] font-semibold text-emerald-700">Desarquivar</Text>
        </Pressable>
      );
    }
    if ((usageById[c.id] ?? 0) > 0) {
      return (
        <Pressable
          onPress={() => doArchive(c)}
          accessibilityRole="button"
          accessibilityLabel={`Arquivar ${c.name}`}
          className="bg-slate-100 rounded-lg px-2 py-1.5"
        >
          <Text className="text-[11px] font-semibold text-slate-600">{ICONS.arquivar} Arquivar</Text>
        </Pressable>
      );
    }
    return (
      <Pressable
        onPress={() => setDeleteConfirm(c)}
        accessibilityRole="button"
        accessibilityLabel={`Excluir ${c.name}`}
        className="bg-rose-50 rounded-lg px-2 py-1.5"
      >
        <Text className="text-[11px] font-semibold text-rose-600">{ICONS.excluir} Excluir</Text>
      </Pressable>
    );
  };

  const renderCat = (c: CategoryRow, isChild: boolean) => (
    <Pressable key={c.id} onPress={() => openEdit(c)} accessibilityRole="button" accessibilityLabel={`Editar ${c.name}`}>
      <Card className={`!py-2.5 ${isChild ? 'ml-4 border-dashed' : 'mb-1'}`}>
        <View className="flex-row items-center gap-2">
          <View className="w-9 h-9 rounded-lg bg-slate-50 items-center justify-center">
            <Text className="text-lg">{c.icon ?? '🏷️'}</Text>
          </View>
          <View className="flex-1">
            <Text className="font-semibold text-slate-900 text-sm">
              {isChild ? '↳ ' : ''}{c.name}
            </Text>
            <Text className="text-[11px] text-slate-500">
              {c.direction === 'DEBIT' ? `${ICONS.despesa} Débito` : c.direction === 'CREDIT' ? `${ICONS.receita} Crédito` : 'Ambos'}
              {' · '}tocar para editar
            </Text>
          </View>
          {/* v17 (melhoria 5): Excluir (sem uso) OU Arquivar (com movimentação) */}
          {renderLifecycleAction(c)}
          {/* v68: "+ Subcategoria" abre o campo de nome ALI MESMO — sem trocar
              de tela e sem escolher a categoria de novo em outro lugar */}
          {!isChild ? (
            <Pressable
              onPress={() => {
                setSubOpenFor((cur) => (cur === c.id ? null : c.id));
                setSubName('');
              }}
              accessibilityRole="button"
              accessibilityLabel={`Adicionar subcategoria em ${c.name}`}
              className="bg-slate-100 rounded-lg px-2 py-1.5"
            >
              <Text className="text-[11px] font-semibold text-slate-600">+ Subcategoria</Text>
            </Pressable>
          ) : null}
        </View>
      </Card>
    </Pressable>
  );

  return (
    <Screen title="Categorias">
      <Segmented<DirFilter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'DEBIT', label: `${ICONS.despesa} Débito` },
          { value: 'CREDIT', label: `${ICONS.receita} Crédito` },
        ]}
        // v8: semântica de cores — débito VERMELHO, crédito VERDE
        activeBg={filter === 'DEBIT' ? kindTheme.EXPENSE.solid : kindTheme.INCOME.solid}
      />

      {/* v8: VERMELHO para débito (era verde — cor de despesa é vermelho) */}
      {/* v70 (MELHORIA 2.3): o botão abre a TELA DE CADASTRAMENTO /categoria-nova */}
      <Button
        label={`＋ Nova ${filter === 'DEBIT' ? 'categoria de débito' : 'categoria de crédito'}`}
        onPress={() => openCreate()}
        bg={filter === 'DEBIT' ? kindTheme.EXPENSE.solid : kindTheme.INCOME.solid}
      />

      <SectionTitle>{filter === 'DEBIT' ? `${ICONS.despesa} Categorias de débito` : `${ICONS.receita} Categorias de crédito`}</SectionTitle>
      {mains.length === 0 ? (
        <EmptyState icon={ICONS.categorias} title="Nenhuma categoria aqui" hint="Toque no botão acima para criar a primeira." />
      ) : (
        <>
          {mains.map((c) => (
            <View key={c.id} className="gap-1.5">
              {renderCat(c, false)}
              {/* v68: campo de nome da subcategoria DENTRO do cartão da categoria */}
              {subOpenFor === c.id ? (
                <Card className="ml-4 gap-2 border-dashed">
                  <Text className="text-sm font-semibold text-slate-800">
                    Nova subcategoria em {c.icon ?? '🏷️'} {c.name}
                  </Text>
                  <TextField
                    label="Nome"
                    value={subName}
                    onChangeText={setSubName}
                    placeholder={`Ex.: dentro de ${c.name}`}
                    autoFocus
                  />
                  <View className="flex-row gap-2">
                    <View className="flex-1">
                      <Button label="Cancelar" variant="outline" onPress={() => { setSubOpenFor(null); setSubName(''); }} />
                    </View>
                    <View className="flex-1">
                      <Button label="Salvar" onPress={() => saveSub(c)} loading={subSaving} />
                    </View>
                  </View>
                </Card>
              ) : null}
              {subsOf(c.id).map((sub) => renderCat(sub, true))}
            </View>
          ))}
        </>
      )}

      {/* v17 (melhoria 5): arquivadas — histórico preservado, podem voltar */}
      {archived.length > 0 ? (
        <>
          <View className="mt-2">
            <Text className="text-sm font-semibold uppercase tracking-wide text-slate-400">Arquivadas</Text>
          </View>
          {archived.map((c) => (
            <View key={c.id} className="gap-1.5">
              {renderCat(c, !!c.parent_id && !!cats.find((p) => p.id === c.parent_id))}
            </View>
          ))}
        </>
      ) : null}

      <Text className="text-[11px] text-slate-400 text-center px-6">
        {ICONS.arquivar} Categoria COM movimentação: só ARQUIVAR (histórico preservado, pode voltar). Sem nenhuma movimentação: EXCLUIR definitivamente. Arquivar a pai arquiva as subcategorias junto.
      </Text>

      {/* v21 (bug 4): confirmação da exclusão de categoria */}
      <ConfirmDialog
        visible={!!deleteConfirm}
        title="Excluir categoria?"
        message={deleteConfirm ? `"${deleteConfirm.name}" sai definitivamente do app (só é possível sem movimentações).` : undefined}
        buttons={[
          { label: 'Excluir categoria', color: 'red', onPress: () => { if (deleteConfirm) doDelete(deleteConfirm); } },
          { label: 'Cancelar', color: 'green', onPress: () => setDeleteConfirm(null) },
        ]}
        onClose={() => setDeleteConfirm(null)}
      />

    </Screen>
  );
}
