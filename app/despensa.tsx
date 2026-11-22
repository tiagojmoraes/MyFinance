/** Tela Despensa — cache atômico, alertas de estoque baixo e movimentos manuais.
 *  v68 (DESEMPENHO): linha da lista MEMOIZADA (React.memo com props primitivas)
 *  — mexer em 1 produto não re-renderiza a despensa inteira.
 *  v72 — LISTA DE COMPRA: o carrinho ficava salvo em app_settings (carrinho
 *  único). v104 — LISTAS DE COMPRA SALVAS: várias, com quantidade por item
 *  (tabelas shopping_lists e shopping_list_items). Migração 61 preservou o
 *  carrinho antigo em uma lista "Lista anterior".
 *  v104 — botões −1/+1 do Estoque em Kilos passam de ±1g para ±100g (0,1 kg)
 *  para que o usuário VEJA o efeito do toque na base em gramas. */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { showToast } from '../lib/toast';
import { Screen, Card, Button, EmptyState, SectionTitle } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { formatBRL, formatStockQty } from '../src/lib/money';
import { ymdToBr } from '../src/lib/dates';
import type { ListaCompraProduct, ListaCompraOffer } from '../src/services/PantryService';
import type { ShoppingListSummary } from '../src/services/ShoppingListService';

interface PantryItem {
  product_id: string;
  name: string;
  base_unit: 'G' | 'ML' | 'UN' | null;
  quantity_base: number;
  low_threshold_base: number | null;
  isLow: boolean;
  /** v101: indica controle de estoque — vem de listClassifiedActive() (Com/Sem). */
  stock_control?: number | null;
}

export default function DespensaScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [listaTab, setListaTab] = React.useState<'ESTOQUE' | 'COMPRA'>('ESTOQUE');
  const [items, setItems] = React.useState<PantryItem[]>([]);
  /** v101 — base da aba Lista de Compra: classificados pelo usuário (USER) com ou
   *  sem controle — independentes de `listPantry` que filtra Com controle. */
  // const [classifiedActive, setClassifiedActive] = React.useState<PantryItem[]>([]);
  // v104: o carrinho único saiu — as listas vêm de shoppingList.listSummaries().
  const [lists, setLists] = React.useState<ShoppingListSummary[]>([]);
  const [previewListId, setPreviewListId] = React.useState<string | null>(null);
  const [previewListData, setPreviewListData] = React.useState<ListaCompraProduct[]>([]);
  const [previewListMeta, setPreviewListMeta] = React.useState<{
    name: string; updatedAt: string;
  } | null>(null);
  const [visao, setVisao] = React.useState<'CATEGORIA' | 'LOJA'>('CATEGORIA');

  const reloadLists = React.useCallback(async () => {
    const summaries = await services.shoppingList.listSummaries();
    setLists(summaries);
  }, [services]);

  const reloadPreview = React.useCallback(async (listId: string) => {
    try {
      const [meta, items] = await Promise.all([
        services.shoppingList.getList(listId),
        services.shoppingList.getItems(listId),
      ]);
      if (!meta) {
        setPreviewListId(null);
        setPreviewListData([]);
        setPreviewListMeta(null);
        return;
      }
      const data = await services.pantry.getListaCompraData(
        items.map((it) => ({ productId: it.product_id, qtyBase: it.qty_base }))
      );
      setPreviewListData(data);
      setPreviewListMeta({ name: meta.name, updatedAt: meta.updated_at });
    } catch {
      setPreviewListData([]);
    }
  }, [services]);

  const load = React.useCallback(async () => {
    const lst = await services.pantry.listPantry();
    setItems(lst as unknown as PantryItem[]);
    await reloadLists();
    if (previewListId) await reloadPreview(previewListId);
  }, [services, previewListId, reloadLists, reloadPreview]);

  useDataEffect(load);

  // v104 — abrir uma lista do menu "Ver lista"
  const openList = async (listId: string) => {
    setPreviewListId(listId);
    await reloadPreview(listId);
  };

  // v104 — voltar do preview para a lista de listas (botão dentro do preview)
  const closeList = () => {
    setPreviewListId(null);
    setPreviewListData([]);
    setPreviewListMeta(null);
  };

  const deleteList = async (listId: string) => {
    try {
      await services.shoppingList.delete(listId);
      showToast('Lista excluída');
      bump();
      if (previewListId === listId) closeList();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  // v68: handler por id (estável) — as linhas memoizadas não mudam de callbacks.
  // v104: o `deltaUi` aqui é na ESCALA DA UI (±1 = 1 passo visível). Para
  // produtos em Kilos a base é grama, então o passo de "1" = 0,1 kg = 100 g na
  // base (delta em GRAMA). Para UN/ML, o passo = a própria unidade.
  const moveById = React.useCallback(async (productId: string, deltaUi: number, reason: 'CONSUMPTION' | 'WASTE' | 'CORRECTION') => {
    try {
      const item = items.find((i) => i.product_id === productId);
      const baseUnit = item?.base_unit ?? null;
      const step = baseUnit === 'G' ? 100 : 1; // KG → 100 g; UN/ML → 1 un/ml
      const deltaBase = deltaUi * step;
      await services.pantry.registerManualMovement({ productId, deltaBase, reason });
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  }, [services, bump, items]);

  const fmtQty = (item: PantryItem): string => {
    // v104: a seleção `pc.stock_control` agora chega do repo, então esta
    // checagem está correta (antes chegava undefined). Para ESTOQUE, o
    // listPantry JÁ filtra stock_control=1 — esta defesa é mantida só se um
    // item escapar do filtro em uma corrida futura.
    if ((item.stock_control ?? 0) !== 1) return 'Sem controle';
    return formatStockQty(item.base_unit, item.quantity_base);
  };

  // ---------- v104: formatação dos preços da lista ----------
  const priceLabel = (dim: 'G' | 'ML' | 'UN', unitPriceBaseCents: number): string => {
    if (dim === 'G') return `${formatBRL(Math.round(unitPriceBaseCents * 1000))}/kg`;
    if (dim === 'ML') return `${formatBRL(Math.round(unitPriceBaseCents * 1000))}/L`;
    return `${formatBRL(Math.round(unitPriceBaseCents * 100) / 100)}/un`;
  };

  /** v104 — helper de cálculo: preço do ITEM na loja = qty × unitPriceBase,
   *  SEMPRE na UNIDADE BASE. Para KG (g) e ML (ml) o unitPriceBase já é
   *  por grama/ml — multiplicar pela qty em g/ml dá o total em REAL. UN é
   *  análogo (preço por unidade × quantidade de unidades). */
  const itemTotalCents = (p: ListaCompraProduct, o: ListaCompraOffer): number =>
    p.qtyBase * o.unitPriceBaseCents;

  const catLabel = (p: ListaCompraProduct): string =>
    p.parentCategoryName ? `${p.parentCategoryName} ▸ ${p.categoryName}` : p.categoryName ?? 'Sem categoria';

  /** VISÃO ① — POR CATEGORIA: menor preço de cada item + loja + data +
   *  subtotal = qty × preço unitário BASE. */
  const porCategoria = React.useMemo(() => {
    const groups = new Map<string, Array<{ p: ListaCompraProduct; melhor: ListaCompraOffer | null; subtotalCents: number }>>();
    for (const p of previewListData) {
      const melhor = p.offers.length > 0
        ? p.offers.reduce((a, b) => (b.unitPriceBaseCents < a.unitPriceBaseCents ? b : a))
        : null;
      const subtotalCents = melhor ? itemTotalCents(p, melhor) : 0;
      const key = catLabel(p);
      const arr = groups.get(key) ?? [];
      arr.push({ p, melhor, subtotalCents });
      groups.set(key, arr);
    }
    return [...groups.entries()]
      .map(([cat, items]) => ({
        cat,
        items,
        totalCents: items.reduce((a, b) => a + b.subtotalCents, 0),
      }))
      .sort((a, b) => a.cat.localeCompare(b.cat));
  }, [previewListData]);

  /** VISÃO ② — POR LOJA: loja ▸ categoria ▸ item (preço NA loja) +
   *  total da loja = soma de qty × unitPriceBaseCents para cada item (correto
   *  para KG/UN/ML). v104 — antes somava só `unitPriceBaseCents` (preço
   *  unitário) e ignorava a quantidade. */
  const porLoja = React.useMemo(() => {
    const lojaMap = new Map<string, Map<string, Array<{ p: ListaCompraProduct; offer: ListaCompraOffer; subtotalCents: number }>>>();
    for (const p of previewListData) {
      for (const o of p.offers) {
        const cats = lojaMap.get(o.storeName) ?? new Map();
        const key = catLabel(p);
        const arr = cats.get(key) ?? [];
        arr.push({ p, offer: o, subtotalCents: itemTotalCents(p, o) });
        cats.set(key, arr);
        lojaMap.set(o.storeName, cats);
      }
    }
    return [...lojaMap.entries()]
      .map(([loja, cats]) => {
        const todos = [...cats.values()].flat();
        const total = todos.reduce((a, b) => a + b.subtotalCents, 0);
        const faltam = previewListData.length - todos.length;
        return { loja, cats: [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0])), total, faltam };
      })
      .sort((a, b) => a.total - b.total);
  }, [previewListData]);

  // v104 — ações do menu "⋮" das listas salvas:
  // "Ver lista" abre previewListId (mantém layout e visões atuais).
  // "Gerar Lista" produz o PDF agrupado conforme a visão ativa e compartilha.
  const generatePdf = async (grouping: 'CATEGORIA' | 'LOJA') => {
    try {
      const { printListaPdf } = await import('../src/lib/listaPdf');
      const groups = grouping === 'CATEGORIA'
        ? porCategoria.map((g) => ({
            title: g.cat,
            lines: g.items.map(({ p, melhor }) => ({
              productName: p.name,
              qty: formatQtyForPdf(p),
              priceLabel: melhor ? priceLabel(melhor.dim, melhor.unitPriceBaseCents) : undefined,
              categoryLabel: melhor?.storeName ?? undefined,
            })),
            totalLabel: formatBRL(Math.round(g.totalCents * 100) / 100),
          }))
        : porLoja.map((g) => ({
            title: `${g.loja} · ${formatBRL(Math.round(g.total * 100) / 100)}`,
            lines: g.cats.flatMap(([cat, prods]) => prods.map(({ p, offer }) => ({
              productName: p.name,
              qty: formatQtyForPdf(p),
              priceLabel: priceLabel(offer.dim, offer.unitPriceBaseCents),
              categoryLabel: cat,
            }))),
          }));
      const grandTotalCents = grouping === 'CATEGORIA'
        ? porCategoria.reduce((a, b) => a + b.totalCents, 0)
        : porLoja.reduce((a, b) => a + b.total, 0);
      const input = {
        title: previewListMeta?.name ?? 'Lista de Compra',
        subtitle: grouping === 'LOJA' ? 'Agrupado por loja' : 'Agrupado por categoria',
        groups,
        grandTotalLabel: formatBRL(Math.round(grandTotalCents * 100) / 100),
      };
      const { uri } = await printListaPdf(input);
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Compartilhar lista' });
      } else {
        showToast('PDF gerado — sem app de compartilhamento no aparelho');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  // v86 (DESEMPENHO): as abas ficam FIXAS no topo (headerArea) e a lista do
  // estoque é VIRTUALIZADA (FlashList) — antes cada produto da despensa era
  // montado de uma vez dentro da ScrollView.
  const tabs = (
    <View className="flex-row gap-1.5">
      <Pressable
        onPress={() => setListaTab('ESTOQUE')}
        className={`flex-1 items-center rounded-xl border py-2 ${listaTab === 'ESTOQUE' ? 'bg-emerald-600 border-transparent' : 'bg-white border-slate-200'}`}
        accessibilityRole="button"
      >
        <Text className={`text-xs font-semibold ${listaTab === 'ESTOQUE' ? 'text-white' : 'text-slate-600'}`}>Estoque</Text>
      </Pressable>
      <Pressable
        onPress={() => setListaTab('COMPRA')}
        className={`flex-1 items-center rounded-xl border py-2 ${listaTab === 'COMPRA' ? 'bg-emerald-600 border-transparent' : 'bg-white border-slate-200'}`}
        accessibilityRole="button"
      >
        <Text className={`text-xs font-semibold ${listaTab === 'COMPRA' ? 'text-white' : 'text-slate-600'}`}>
          Lista de Compra{lists.length > 0 ? ` (${lists.length})` : ''}
        </Text>
      </Pressable>
    </View>
  );

  // v104: action do header — o "+" abre TELA PRÓPRIA para cadastrar produto /
  // criar lista conforme a aba ativa. Padrão do app (app/contas.tsx:171).
  const headerAction = (
    <Pressable
      onPress={() => router.push(listaTab === 'ESTOQUE' ? '/produto-novo' : '/lista-compra-nova')}
      accessibilityRole="button"
      accessibilityLabel={listaTab === 'ESTOQUE' ? 'Adicionar novo produto' : 'Criar nova lista'}
      className="bg-emerald-600 rounded-xl px-4 py-2"
    >
      <Text className="text-white font-bold text-lg leading-6">＋</Text>
    </Pressable>
  );

  return (
    <Screen
      title="Despensa"
      headerArea={tabs}
      action={headerAction}
      body={
        listaTab === 'ESTOQUE' ? (
          <FlashList
            data={items}
            keyExtractor={(item) => item.product_id}
            renderItem={({ item }) => (
              <View className="pb-1.5">
                <PantryRow item={item} qtyLabel={fmtQty(item)} onMove={moveById} />
              </View>
            )}
            contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 }}
            ListEmptyComponent={
              <View className="pt-4">
                <EmptyState icon="🧺" title="Despensa vazia" hint="Produtos aparecem aqui via NFC-e ou cadastro manual. Toque no ＋ para cadastrar." />
              </View>
            }
          />
        ) : undefined
      }
    >
      {listaTab === 'COMPRA' ? (
        previewListId ? (
          /* v104 — PREVIEW de uma lista salva: layout e visões idênticos ao
           * carrinho antigo + botões para ajustar quantidade, incluir e
           * remover itens, e gerar PDF. */
          <ListPreview
            listName={previewListMeta?.name ?? 'Lista'}
            updatedAt={previewListMeta?.updatedAt ?? ''}
            data={previewListData}
            visao={visao}
            setVisao={setVisao}
            porCategoria={porCategoria}
            priceLabel={priceLabel}
            formatBRL={formatBRL}
            onClose={closeList}
            onGeneratePdf={generatePdf}
            onRemoveItem={async (productId) => {
              await services.shoppingList.removeItem(previewListId, productId);
              await reloadPreview(previewListId);
              bump();
            }}
            onSetQty={async (productId, qtyBase) => {
              await services.shoppingList.setItemQty(previewListId, productId, qtyBase);
              await reloadPreview(previewListId);
              bump();
            }}
          />
        ) : (
          /* v104 — LISTA DE LISTAS salvas. */
          <>
            <Card className="gap-2">
              <View className="flex-row justify-between items-center">
                <Text className="font-semibold text-slate-900">Listas salvas</Text>
                <Text className="text-xs text-slate-500">{lists.length} lista(s)</Text>
              </View>
              <Pressable
                onPress={() => router.push('/lista-compra-nova')}
                accessibilityRole="button"
                accessibilityLabel="Criar nova lista"
                className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex-row items-center justify-between"
              >
                <Text className="text-emerald-800 font-medium">＋ Nova lista de compra</Text>
                <Text className="text-emerald-600 font-bold">＋</Text>
              </Pressable>
            </Card>
            {lists.length === 0 ? (
              <EmptyState icon="🛒" title="Nenhuma lista" hint="Toque em ＋ Nova lista ou no botão ＋ do cabeçalho para montar a primeira." />
            ) : (
              lists.map((lst) => (
                <ListRow
                  key={lst.id}
                  list={lst}
                  fmtTotal={(c) => formatBRL(Math.round(c * 100) / 100)}
                  onPress={() => openList(lst.id)}
                  onDelete={() => deleteList(lst.id)}
                />
              ))
            )}
          </>
        )
      ) : null}
    </Screen>
  );
}

// ----------------------------------------------------------------------------
// COMPONENTES
// ----------------------------------------------------------------------------

/** v104 — formata quantidade da lista para o PDF (kg, un, ml). */
function formatQtyForPdf(p: ListaCompraProduct): string {
  if ((p.baseUnit ?? p.dim) === 'G') {
    const kg = p.qtyBase / 1000;
    return `${kg.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kg`;
  }
  if ((p.baseUnit ?? p.dim) === 'ML') return `${p.qtyBase} ml`;
  return `${p.qtyBase} un`;
}

/** v68 — linha MEMOIZADA da despensa (props primitivas + callback estável).
 *  v104 — removeu o botão "=" (era ajuste rápido da v19, sem util). */
const PantryRow = React.memo(function PantryRow({ item, qtyLabel, onMove }: {
  item: PantryItem;
  qtyLabel: string;
  onMove: (productId: string, deltaUi: number, reason: 'CONSUMPTION' | 'WASTE' | 'CORRECTION') => void;
}) {
  return (
    <Card className="!py-3">
      <View className="flex-row justify-between items-center">
        <View className="flex-1">
          <Text className="font-semibold text-slate-900">{item.name}</Text>
          <Text className={`text-sm font-bold ${item.isLow ? 'text-rose-600' : 'text-emerald-700'}`}>{qtyLabel}</Text>
          {item.isLow ? <Text className="text-xs text-rose-500 mt-0.5">⚠ Estoque baixo</Text> : null}
        </View>
        <View className="flex-row gap-1">
          <Pressable onPress={() => onMove(item.product_id, -1, 'CONSUMPTION')} accessibilityRole="button" className="bg-slate-100 rounded-lg px-3 py-2">
            <Text className="font-bold text-slate-700">−1</Text>
          </Pressable>
          <Pressable onPress={() => onMove(item.product_id, +1, 'CORRECTION')} accessibilityRole="button" className="bg-emerald-50 rounded-lg px-3 py-2">
            <Text className="font-bold text-emerald-700">+1</Text>
          </Pressable>
        </View>
      </View>
    </Card>
  );
});

/** v104 — linha da lista de listas salvas (nome · data · nº itens · total
 *  estimado · menu ⋮ com Ver lista / Gerar Lista / Excluir). */
function ListRow({ list, fmtTotal, onPress, onDelete }: {
  list: ShoppingListSummary;
  fmtTotal: (cents: number) => string;
  onPress: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  return (
    <View className="relative">
      <Card className="!py-3">
        <View className="flex-row justify-between items-center">
          <Pressable onPress={onPress} accessibilityRole="button" className="flex-1" accessibilityLabel={`Abrir ${list.name}`}>
            <Text className="font-semibold text-slate-900" numberOfLines={1}>{list.name}</Text>
            <Text className="text-[11px] text-slate-500 mt-0.5">
              {ymdToBr(list.updated_at.slice(0, 10))} · {list.itemCount} item(ns) · {fmtTotal(list.estimatedTotalCents)}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setMenuOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel="Mais opções"
            className="bg-slate-100 rounded-lg px-3 py-2"
          >
            <Text className="text-slate-700 font-bold">⋮</Text>
          </Pressable>
        </View>
      </Card>
      {menuOpen ? (
        <View className={`absolute right-2 top-12 z-10 bg-white border border-slate-200 rounded-xl p-1 shadow-lg`}>
          <Pressable
            onPress={() => { setMenuOpen(false); onPress(); }}
            accessibilityRole="button"
            className="px-4 py-2 rounded-lg"
          >
            <Text className="text-slate-800 font-medium">Ver lista</Text>
          </Pressable>
          <Pressable
            onPress={() => { setMenuOpen(false); onDelete(); }}
            accessibilityRole="button"
            className="px-4 py-2 rounded-lg"
          >
            <Text className="text-rose-700 font-medium">Excluir lista</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** v104 — preview de uma lista (mantém layout e visões atuais do v72 +
 *  botões para alterar quantidade / excluir / gerar PDF). */
function ListPreview(props: {
  listName: string;
  updatedAt: string;
  data: ListaCompraProduct[];
  visao: 'CATEGORIA' | 'LOJA';
  setVisao: (v: 'CATEGORIA' | 'LOJA') => void;
  porCategoria: Array<{ cat: string; items: Array<{ p: ListaCompraProduct; melhor: ListaCompraOffer | null; subtotalCents: number }>; totalCents: number }>;
  priceLabel: (dim: 'G' | 'ML' | 'UN', unitPriceBaseCents: number) => string;
  formatBRL: (cents: number) => string;
  onClose: () => void;
  onGeneratePdf: (grouping: 'CATEGORIA' | 'LOJA') => Promise<void>;
  onRemoveItem: (productId: string) => Promise<void>;
  onSetQty: (productId: string, qtyBase: number) => Promise<void>;
}) {
  return (
    <>
      <Card className="gap-2">
        <View className="flex-row justify-between items-center">
          <Pressable onPress={props.onClose} accessibilityRole="button" accessibilityLabel="Voltar" className="bg-slate-100 rounded-lg px-3 py-2">
            <Text className="font-bold text-slate-700">‹</Text>
          </Pressable>
          <Text className="font-semibold text-slate-900 flex-1 text-center" numberOfLines={1}>{props.listName}</Text>
          <Pressable
            onPress={() => props.onGeneratePdf(props.visao)}
            accessibilityRole="button"
            accessibilityLabel="Gerar PDF da lista"
            className="bg-emerald-50 rounded-lg px-3 py-2"
          >
            <Text className="font-bold text-emerald-700">PDF</Text>
          </Pressable>
        </View>
      </Card>

      {props.data.length === 0 ? (
        <EmptyState icon="🛒" title="Lista vazia" hint="Esta lista não tem itens. Crie uma nova lista ou inclua produtos na Lista de Compra." />
      ) : (
        <>
          <View className="flex-row gap-1.5">
            <Pressable
              onPress={() => props.setVisao('CATEGORIA')}
              className={`flex-1 items-center rounded-xl border py-2 ${props.visao === 'CATEGORIA' ? 'bg-slate-800 border-transparent' : 'bg-white border-slate-200'}`}
              accessibilityRole="button"
            >
              <Text className={`text-xs font-semibold ${props.visao === 'CATEGORIA' ? 'text-white' : 'text-slate-600'}`}>Por categoria</Text>
            </Pressable>
            <Pressable
              onPress={() => props.setVisao('LOJA')}
              className={`flex-1 items-center rounded-xl border py-2 ${props.visao === 'LOJA' ? 'bg-slate-800 border-transparent' : 'bg-white border-slate-200'}`}
              accessibilityRole="button"
            >
              <Text className={`text-xs font-semibold ${props.visao === 'LOJA' ? 'text-white' : 'text-slate-600'}`}>Por loja</Text>
            </Pressable>
          </View>

          {props.visao === 'CATEGORIA' ? (
            <>
              {props.porCategoria.map((gCat) => (
                <View key={gCat.cat} className="gap-1.5">
                  <Text className="font-semibold text-slate-900 mt-1">{gCat.cat}</Text>
                  {gCat.items.map(({ p, melhor, subtotalCents }) => (
                    <PreviewItemCard
                      key={p.productId}
                      p={p}
                      rightLabel={melhor ? props.priceLabel(melhor.dim, melhor.unitPriceBaseCents) : 'sem preço em notas lidas'}
                      rightSubLabel={melhor ? `${melhor.storeName} · ${melhor.date ? ymdToBr(melhor.date) : '—'}` : undefined}
                      subtotalLabel={melhor ? props.formatBRL(Math.round(subtotalCents * 100) / 100) : undefined}
                      priceLabel={props.priceLabel}
                      onRemove={() => props.onRemoveItem(p.productId)}
                      onSetQty={(qty) => props.onSetQty(p.productId, qty)}
                    />
                  ))}
                </View>
              ))}
              <Text className="text-[11px] text-slate-400 px-1">
                Total desta lista = soma de (quantidade × melhor preço entre lojas) por item. Peso vale por kg, volume por L, unidade por un — nunca mistura.
              </Text>
            </>
          ) : (
            <ListPreviewPorLoja
              data={props.data}
              priceLabel={props.priceLabel}
              formatBRL={props.formatBRL}
              onRemoveItem={props.onRemoveItem}
              onSetQty={props.onSetQty}
            />
          )}
        </>
      )}
    </>
  );
}

/** v104 — visão POR LOJA do preview: mesmo agrupamento do v72, mas totais
 *  MULTIPLICAM qty × preço (a regra correta do cálculo). */
function ListPreviewPorLoja(props: {
  data: ListaCompraProduct[];
  priceLabel: (dim: 'G' | 'ML' | 'UN', unitPriceBaseCents: number) => string;
  formatBRL: (cents: number) => string;
  onRemoveItem: (productId: string) => Promise<void>;
  onSetQty: (productId: string, qtyBase: number) => Promise<void>;
}) {
  // Monta o agrupamento por loja ▸ categoria ▸ item.
  const groups = React.useMemo(() => {
    const lojaMap = new Map<string, Map<string, Array<{ p: ListaCompraProduct; offer: ListaCompraOffer; subtotalCents: number }>>>();
    for (const p of props.data) {
      for (const o of p.offers) {
        const cats = lojaMap.get(o.storeName) ?? new Map();
        const key = p.parentCategoryName ? `${p.parentCategoryName} ▸ ${p.categoryName ?? 'Sem categoria'}` : p.categoryName ?? 'Sem categoria';
        const arr = cats.get(key) ?? [];
        arr.push({ p, offer: o, subtotalCents: p.qtyBase * o.unitPriceBaseCents });
        cats.set(key, arr);
        lojaMap.set(o.storeName, cats);
      }
    }
    return [...lojaMap.entries()]
      .map(([loja, cats]) => {
        const todos = [...cats.values()].flat();
        return {
          loja,
          cats: [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0])),
          total: todos.reduce((a, b) => a + b.subtotalCents, 0),
        };
      })
      .sort((a, b) => a.total - b.total);
  }, [props.data]);

  return (
    <>
      {groups.map(({ loja, cats, total }) => (
        <Card key={loja} className="gap-1.5">
          <View className="flex-row justify-between items-center">
            <Text className="font-semibold text-slate-900" numberOfLines={1}>{loja}</Text>
            <View className="items-end">
              <Text className="text-sm font-bold text-slate-900">{props.formatBRL(Math.round(total * 100) / 100)}</Text>
              <Text className="text-[10px] text-slate-400">total da lista nesta loja</Text>
            </View>
          </View>
          {cats.map(([cat, prods]) => (
            <View key={cat} className="pl-2 gap-1">
              <Text className="text-[11px] font-semibold text-slate-500">{cat}</Text>
              {prods.map(({ p, offer }) => (
                <PreviewItemCard
                  key={p.productId}
                  p={p}
                  rightLabel={props.priceLabel(offer.dim, offer.unitPriceBaseCents)}
                  priceLabel={props.priceLabel}
                  onRemove={() => props.onRemoveItem(p.productId)}
                  onSetQty={(qty) => props.onSetQty(p.productId, qty)}
                />
              ))}
            </View>
          ))}
        </Card>
      ))}
      <Text className="text-[11px] text-slate-400 px-1">
        Total da loja = soma de (quantidade × preço na loja) de cada item. Lojas ordenadas da mais barata para a mais cara.
      </Text>
    </>
  );
}

/** v104 — cartão de item dentro do preview: nome, quantidade editável,
 *  preço e botão remover. */
function PreviewItemCard(props: {
  p: ListaCompraProduct;
  rightLabel: string;
  rightSubLabel?: string;
  subtotalLabel?: string;
  priceLabel: (dim: 'G' | 'ML' | 'UN', unitPriceBaseCents: number) => string;
  onRemove: () => void | Promise<void>;
  onSetQty: (qtyBase: number) => void | Promise<void>;
}) {
  const baseUnit = props.p.baseUnit ?? props.p.dim;
  const isKg = baseUnit === 'G';
  const step = isKg ? 100 : 1;
  const [qtyText, setQtyText] = React.useState(toQtyText(props.p.qtyBase, isKg));
  React.useEffect(() => { setQtyText(toQtyText(props.p.qtyBase, isKg)); }, [props.p.qtyBase, isKg]);
  return (
    <Card className="!py-2 !px-3 border-slate-100">
      <View className="flex-row justify-between items-start">
        <Text className="flex-1 text-sm text-slate-700" numberOfLines={1}>{props.p.name}</Text>
        <View className="items-end ml-2">
          <Text className={`text-sm font-bold ${props.rightLabel === 'sem preço em notas lidas' ? 'text-slate-400' : 'text-emerald-700'}`}>{props.rightLabel}</Text>
          {props.rightSubLabel ? <Text className="text-[10px] text-slate-400">{props.rightSubLabel}</Text> : null}
          {props.subtotalLabel ? <Text className="text-[10px] text-slate-700 font-semibold">{props.subtotalLabel}</Text> : null}
        </View>
      </View>
      <View className="flex-row items-center justify-between mt-2">
        <View className="flex-row items-center gap-1.5">
          <Pressable
            onPress={() => {
              const next = Math.max(step, props.p.qtyBase - step);
              props.onSetQty(next);
            }}
            accessibilityRole="button"
            className="bg-slate-100 rounded-md px-2 py-1"
          >
            <Text className="font-bold text-slate-700">−</Text>
          </Pressable>
          <View className="bg-white border border-slate-200 rounded-md px-2 py-1">
            <Text className="text-sm font-semibold text-slate-800">
              {qtyText}{isKg ? ' kg' : baseUnit === 'ML' ? ' ml' : ' un'}
            </Text>
          </View>
          <Pressable
            onPress={() => props.onSetQty(props.p.qtyBase + step)}
            accessibilityRole="button"
            className="bg-emerald-50 rounded-md px-2 py-1"
          >
            <Text className="font-bold text-emerald-700">＋</Text>
          </Pressable>
        </View>
        <Pressable
          onPress={props.onRemove}
          accessibilityRole="button"
          accessibilityLabel={`Remover ${props.p.name} da lista`}
          className="bg-rose-50 rounded-md px-2 py-1"
        >
          <Text className="font-bold text-rose-700">remover</Text>
        </Pressable>
      </View>
    </Card>
  );
}

function toQtyText(qtyBase: number, isKg: boolean): string {
  if (isKg) {
    const kg = qtyBase / 1000;
    if (Number.isInteger(kg)) return String(kg);
    return kg.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
  }
  return String(qtyBase);
}
