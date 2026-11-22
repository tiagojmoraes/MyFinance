/** Tela Despensa — cache atômico, alertas de estoque baixo e movimentos manuais.
 *  v68 (DESEMPENHO): linha da lista MEMOIZADA (React.memo com props primitivas)
 *  — mexer em 1 produto não re-renderiza a despensa inteira.
 *  v72 — LISTA DE COMPRA (pedido do usuário):
 *  · CARRINHO: toque no produto para entrar/sair da lista; botão "Abaixo do
 *    mínimo" coloca TUDO que está com estoque baixo de uma vez;
 *  · de onde comprar mais barato, com base nas NOTAS LIDAS (nfce_items —
 *    preço unitário = valor ÷ quantidade; por loja vale a compra mais
 *    recente; KG nunca mistura com UN — guarda de dimensão);
 *  · DUAS VISÕES: ① POR CATEGORIA — o menor preço de cada item + loja + data;
 *    ② POR LOJA — loja ▸ categoria (▸ subcategoria) ▸ preço do item, com o
 *    TOTAL da compra naquela loja;
 *  · o carrinho fica salvo no banco (app_settings) — fecha e volta intacto. */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { showToast } from '../lib/toast';
import { Screen, Card, TextField, Select, Button, EmptyState, SectionTitle } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { formatBRL, formatStockQty, parseKgToGrams } from '../src/lib/money';
import { ymdToBr } from '../src/lib/dates';
import { SETTING_KEYS } from '../src/services/SettingsService';
import type { ListaCompraProduct, ListaCompraOffer } from '../src/services/PantryService';

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
  const [tab, setTab] = React.useState<'LIST' | 'NEW'>('LIST');
  const [listaTab, setListaTab] = React.useState<'ESTOQUE' | 'COMPRA'>('ESTOQUE');
  const [items, setItems] = React.useState<PantryItem[]>([]);
  /** v101 — base da aba Lista de Compra: classificados pelo usuário (USER) com ou
   *  sem controle — independentes de `listPantry` que filtra Com controle. */
  const [classifiedActive, setClassifiedActive] = React.useState<PantryItem[]>([]);
  const [name, setName] = React.useState('');
  const [ean, setEan] = React.useState('');
  const [unit, setUnit] = React.useState<string | null>('UN');
  const [threshold, setThreshold] = React.useState('');

  // ---------- v72: carrinho da Lista de Compra ----------
  const [cart, setCart] = React.useState<string[]>([]);
  /** v87: o carrinho atual (ref) — o estado do React chega tarde para toques rápidos. */
  const cartRef = React.useRef<string[]>([]);
  const [data, setData] = React.useState<ListaCompraProduct[]>([]);
  const [visao, setVisao] = React.useState<'CATEGORIA' | 'LOJA'>('CATEGORIA');

  const load = React.useCallback(async () => {
    const [list, classified] = await Promise.all([
      services.pantry.listPantry(),
      services.pantry.listClassifiedActive(),
    ]);
    setItems(list as unknown as PantryItem[]);
    setClassifiedActive(classified as unknown as PantryItem[]);
    try {
      const raw = await services.settings.get(SETTING_KEYS.despensaListaCompra);
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      setCart(Array.isArray(arr) ? arr : []);
    } catch {
      setCart([]);
    }
  }, [services]);

  useDataEffect(load);

  // dados de preço da lista — recalcula quando o carrinho ou a despensa mudam
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await services.pantry.getListaCompraData(cart);
        if (alive) setData(d);
      } catch {
        if (alive) setData([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [services, cart, items]);

  const persistCart = async (next: string[]) => {
    cartRef.current = next;
    setCart(next);
    try {
      await services.settings.set(SETTING_KEYS.despensaListaCompra, JSON.stringify(next));
    } catch {
      // carrinho é best-effort
    }
  };

  // v87 (BUG BAIXO): o carrinho era montado a partir do `cart` do RENDER
  // (fechado) — dois toques rápidos antes do re-render usavam a lista velha e
  // a seleção se perdia. Agora a lista atual vem de um REF (sempre o último
  // estado), sem depender do re-render.
  const toggleCart = (productId: string) => {
    const atual = cartRef.current;
    const proximo = atual.includes(productId) ? atual.filter((p) => p !== productId) : [...atual, productId];
    persistCart(proximo);
  };

  const addBelowMinimum = () => {
    const atuais = cartRef.current;
    const baixos = items.filter((i) => i.isLow && !atuais.includes(i.product_id));
    if (baixos.length === 0) {
      showToast('Nada abaixo do mínimo — tudo em dia');
      return;
    }
    persistCart([...atuais, ...baixos.map((i) => i.product_id)]);
    showToast(`${baixos.length} produto(s) abaixo do mínimo entraram na lista`);
  };

  const addProduct = async () => {
    try {
      if (!name.trim()) throw new Error('Informe o nome do produto');
      const product = await services.products.createManualProduct({
        name: name.trim(),
        ean: ean.trim() ? ean.trim() : null,
        baseUnit: (unit as 'G' | 'ML' | 'UN') ?? 'UN',
      });
      const th = unit === 'G' ? parseKgToGrams(threshold) : parseInt(threshold, 10);
      const valid = unit === 'G' ? Number.isFinite(th) : Number.isInteger(th);
      await services.pantry.setLowThreshold(product.id, valid ? th : null);
      setName(''); setEan(''); setThreshold('');
      setTab('LIST');
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  // v68: handler por id (estável) — as linhas memoizadas não mudam de callbacks
  const moveById = React.useCallback(async (productId: string, delta: number, reason: 'CONSUMPTION' | 'WASTE' | 'CORRECTION') => {
    try {
      await services.pantry.registerManualMovement({ productId, deltaBase: delta, reason });
      bump();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  }, [services, bump]);

  const fmtQty = (item: PantryItem): string => {
    // v101: sem controle de estoque não tem quantidade — só catálogo.
    if ((item.stock_control ?? 0) !== 1) return 'Sem controle';
    return formatStockQty(item.base_unit, item.quantity_base);
  };

  const units = [
    { id: 'UN', label: 'Unidade' },
    { id: 'G', label: 'Kilos' },
    { id: 'ML', label: 'Mililitros (legado)' },
  ];

  // v103: alerta de estoque baixo em KG quando unidade é "Kilos".
  const thresholdLabel = unit === 'G' ? 'Alerta de estoque baixo (kg)'
    : unit === 'UN' ? 'Alerta de estoque baixo (un)'
    : 'Alerta de estoque baixo (na unidade base)';
  const thresholdKb = (unit === 'G' ? 'decimal-pad' : 'numeric') as 'decimal-pad' | 'numeric';
  const thresholdPlaceholder = unit === 'G' ? 'Ex.: 0,5' : 'Ex.: 1000';

  // ---------- v72: formatação dos preços da lista ----------
  const priceLabel = (dim: 'G' | 'ML' | 'UN', unitPriceBaseCents: number): string => {
    if (dim === 'G') return `${formatBRL(Math.round(unitPriceBaseCents * 1000))}/kg`;
    if (dim === 'ML') return `${formatBRL(Math.round(unitPriceBaseCents * 1000))}/L`;
    return `${formatBRL(Math.round(unitPriceBaseCents * 100) / 100)}/un`;
  };

  const catLabel = (p: ListaCompraProduct): string =>
    p.parentCategoryName ? `${p.parentCategoryName} ▸ ${p.categoryName}` : p.categoryName ?? 'Sem categoria';

  /** VISÃO ① — POR CATEGORIA: menor preço de cada item + loja + data. */
  const porCategoria = React.useMemo(() => {
    const groups = new Map<string, Array<{ p: ListaCompraProduct; melhor: ListaCompraOffer | null }>>();
    for (const p of data) {
      const melhor = p.offers.length > 0
        ? p.offers.reduce((a, b) => (b.unitPriceBaseCents < a.unitPriceBaseCents ? b : a))
        : null;
      const key = catLabel(p);
      const arr = groups.get(key) ?? [];
      arr.push({ p, melhor });
      groups.set(key, arr);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  /** VISÃO ② — POR LOJA: loja ▸ categoria ▸ item (preço NA loja) + total da loja. */
  const porLoja = React.useMemo(() => {
    // lojas que têm PELO MENOS 1 produto da lista
    const lojaMap = new Map<string, Map<string, Array<{ p: ListaCompraProduct; offer: ListaCompraOffer }>>>();
    for (const p of data) {
      for (const o of p.offers) {
        const cats = lojaMap.get(o.storeName) ?? new Map<string, Array<{ p: ListaCompraProduct; offer: ListaCompraOffer }>>();
        const key = catLabel(p);
        const arr = cats.get(key) ?? [];
        arr.push({ p, offer: o });
        cats.set(key, arr);
        lojaMap.set(o.storeName, cats);
      }
    }
    return [...lojaMap.entries()]
      .map(([loja, cats]) => {
        const todos = [...cats.values()].flat();
        // preço por UNIDADE DE COMPRA (kg/L/un): base por grama/ml × 1000; un direto
        const total = todos.reduce(
          (a, b) => a + (b.offer.dim === 'UN' ? b.offer.unitPriceBaseCents : b.offer.unitPriceBaseCents * 1000),
          0
        );
        const faltam = data.length - todos.length;
        return { loja, cats: [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0])), total, faltam };
      })
      .sort((a, b) => a.total - b.total); // mais barata primeiro
  }, [data]);

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
          Lista de Compra{cart.length > 0 ? ` (${cart.length})` : ''}
        </Text>
      </Pressable>
    </View>
  );

  return (
    <Screen
      title="Despensa"
      headerArea={tabs}
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
                <EmptyState icon="🧺" title="Despensa vazia" hint="Produtos aparecem aqui via NFC-e ou cadastro manual." />
              </View>
            }
            ListFooterComponent={
              <View className="gap-3 pt-3">
                <SectionTitle>Novo produto</SectionTitle>
                <Card className="gap-3">
                  <TextField label="Nome" value={name} onChangeText={setName} placeholder="Ex.: Arroz 5kg" />
                  <TextField label="EAN/GTIN (opcional)" value={ean} onChangeText={setEan} keyboardType="numeric" placeholder="789..." />
                  <Select label="Unidade base" items={units} selectedId={unit} onSelect={setUnit} />
                  <TextField label={thresholdLabel} value={threshold} onChangeText={setThreshold} keyboardType={thresholdKb} placeholder={thresholdPlaceholder} />
                  <Button label="Cadastrar produto" onPress={addProduct} />
                </Card>
              </View>
            }
          />
        ) : undefined
      }
    >
      {listaTab === 'COMPRA' ? (
        <>
          {/* ---- carrinho: produtos da despensa, toque entra/sai ---- */}
          <Card className="gap-2">
            <View className="flex-row justify-between items-center">
              <Text className="font-semibold text-slate-900">Produtos na lista</Text>
              <Text className="text-xs text-slate-500">{cart.length} selecionado(s)</Text>
            </View>
            <Button label={`＋ Abaixo do mínimo (${items.filter((i) => i.isLow).length})`} variant="outline" onPress={addBelowMinimum} />
            {classifiedActive.length === 0 ? (
              <Text className="text-xs text-slate-500">Sem produtos classificados — cadastre no catálogo ou leia notas e classifique os pendentes.</Text>
            ) : (
              classifiedActive.map((item) => {
                const na = cart.includes(item.product_id);
                return (
                  <Pressable
                    key={item.product_id}
                    onPress={() => toggleCart(item.product_id)}
                    className={`flex-row justify-between items-center rounded-lg px-3 py-2 border ${na ? 'bg-emerald-50 border-emerald-300' : 'bg-white border-slate-200'}`}
                    accessibilityRole="button"
                  >
                    <View className="flex-1">
                      <Text className={`text-sm font-medium ${na ? 'text-emerald-800' : 'text-slate-700'}`} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text className="text-[11px] text-slate-400">{fmtQty(item)}{item.isLow ? ' · ⚠ estoque baixo' : ''}</Text>
                    </View>
                    <Text className={`text-sm font-bold ${na ? 'text-emerald-600' : 'text-slate-300'}`}>{na ? '✓' : '＋'}</Text>
                  </Pressable>
                );
              })
            )}
            {cart.length > 0 ? (
              <Button label="Limpar lista" variant="outline" onPress={() => persistCart([])} />
            ) : null}
          </Card>

          {cart.length === 0 ? (
            <EmptyState icon="🛒" title="Lista vazia" hint="Toque nos produtos acima para montar a lista de compra." />
          ) : (
            <>
              {/* ---- visões: por categoria / por loja ---- */}
              <View className="flex-row gap-1.5">
                <Pressable
                  onPress={() => setVisao('CATEGORIA')}
                  className={`flex-1 items-center rounded-xl border py-2 ${visao === 'CATEGORIA' ? 'bg-slate-800 border-transparent' : 'bg-white border-slate-200'}`}
                  accessibilityRole="button"
                >
                  <Text className={`text-xs font-semibold ${visao === 'CATEGORIA' ? 'text-white' : 'text-slate-600'}`}>Por categoria</Text>
                </Pressable>
                <Pressable
                  onPress={() => setVisao('LOJA')}
                  className={`flex-1 items-center rounded-xl border py-2 ${visao === 'LOJA' ? 'bg-slate-800 border-transparent' : 'bg-white border-slate-200'}`}
                  accessibilityRole="button"
                >
                  <Text className={`text-xs font-semibold ${visao === 'LOJA' ? 'text-white' : 'text-slate-600'}`}>Por loja</Text>
                </Pressable>
              </View>

              {visao === 'CATEGORIA' ? (
                <>
                  {porCategoria.map(([cat, prods]) => (
                    <Card key={cat} className="gap-1.5">
                      <Text className="font-semibold text-slate-900">{cat}</Text>
                      {prods.map(({ p, melhor }) => (
                        <View key={p.productId} className="flex-row justify-between items-center">
                          <Text className="flex-1 text-sm text-slate-700" numberOfLines={1}>{p.name}</Text>
                          {melhor ? (
                            <View className="items-end">
                              <Text className="text-sm font-bold text-emerald-700">
                                {priceLabel(melhor.dim, melhor.unitPriceBaseCents)}
                              </Text>
                              <Text className="text-[10px] text-slate-400">
                                {melhor.storeName} · {melhor.date ? ymdToBr(melhor.date) : '—'}
                              </Text>
                            </View>
                          ) : (
                            <Text className="text-[11px] text-slate-400">sem preço em notas lidas</Text>
                          )}
                        </View>
                      ))}
                    </Card>
                  ))}
                  <Text className="text-[11px] text-slate-400 px-1">
                    Preço unitário = valor do item ÷ quantidade, pela compra MAIS RECENTE de cada loja (menor preço em destaque). Peso vale por kg e volume por L — nunca mistura com unidade.
                  </Text>
                </>
              ) : (
                <>
                  {porLoja.map(({ loja, cats, total, faltam }) => (
                    <Card key={loja} className="gap-1.5">
                      <View className="flex-row justify-between items-center">
                        <Text className="font-semibold text-slate-900" numberOfLines={1}>{loja}</Text>
                        <View className="items-end">
                          <Text className="text-sm font-bold text-slate-900">{formatBRL(Math.round(total * 100) / 100)}</Text>
                          <Text className="text-[10px] text-slate-400">total da lista nesta loja</Text>
                        </View>
                      </View>
                      {cats.map(([cat, prods]) => (
                        <View key={cat} className="pl-2 gap-1">
                          <Text className="text-[11px] font-semibold text-slate-500">{cat}</Text>
                          {prods.map(({ p, offer }) => (
                            <View key={p.productId} className="flex-row justify-between items-center pl-1">
                              <Text className="flex-1 text-sm text-slate-700" numberOfLines={1}>{p.name}</Text>
                              <Text className="text-sm text-slate-600">{priceLabel(offer.dim, offer.unitPriceBaseCents)}</Text>
                            </View>
                          ))}
                        </View>
                      ))}
                      {faltam > 0 ? (
                        <Text className="text-[11px] text-amber-600">{faltam} item(ns) sem preço nesta loja</Text>
                      ) : null}
                    </Card>
                  ))}
                  <Text className="text-[11px] text-slate-400 px-1">
                    Total da loja = soma dos preços por UNIDADE DE COMPRA (kg, L ou un) de cada item da lista. Lojas ordenadas da mais barata para a mais cara.
                  </Text>
                </>
              )}
            </>
          )}
        </>
      ) : null}
    </Screen>
  );
}

/** v68 — linha MEMOIZADA da despensa (props primitivas + callback estável). */
const PantryRow = React.memo(function PantryRow({ item, qtyLabel, onMove }: {
  item: PantryItem;
  qtyLabel: string;
  onMove: (productId: string, delta: number, reason: 'CONSUMPTION' | 'WASTE' | 'CORRECTION') => void;
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
          <Pressable onPress={() => onMove(item.product_id, -1, 'CONSUMPTION')} className="bg-slate-100 rounded-lg px-3 py-2">
            <Text className="font-bold text-slate-700">−1</Text>
          </Pressable>
          <Pressable onPress={() => onMove(item.product_id, +1, 'CORRECTION')} className="bg-emerald-50 rounded-lg px-3 py-2">
            <Text className="font-bold text-emerald-700">+1</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              // v19 (zero popups): sem Alert.prompt — ajuste rápido direto (+5)
              showToast('Ajuste rápido: use +1/−1 (correção fina pela edição do item)');
              onMove(item.product_id, +5, 'CORRECTION');
            }}
            className="bg-amber-50 rounded-lg px-3 py-2"
          >
            <Text className="font-bold text-amber-700">=</Text>
          </Pressable>
        </View>
      </View>
    </Card>
  );
});
