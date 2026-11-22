/**
 * Catálogo de Produto (v101 — CARROSSEL de 4 abas):
 *  · "Pendentes de classificação" (NF sem decisão do usuário): o que
 *    precisa ser tocado/classificado;
 *  · "Classificado › Com Estoque": stock_control=1 + ativo (decisão do
 *    usuário → vai para a Despensa Estoque);
 *  · "Classificado › Sem Estoque": stock_control=0 + ativo (decisão do
 *    usuário → vai para a Lista de Compra);
 *  · "Inativo | Excluído": status=INATIVO ou removidos do catálogo.
 * AUTO-NFCE só aparece em "Pendentes" — a regra é "só após a definição
 * do Catálogo", então enquanto o usuário não classificar, o produto não
 * entra em Despensa nem em Lista de Compra.
 */
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, TextField, Button, EmptyState, Segmented } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { ICONS } from '../src/theme/icons';
import { theme } from '../src/theme';
import { displayProductName } from '../src/lib/productName';
import { showToast } from '../src/lib/toast';

interface PendingGroup {
  groupKey: string;
  cnpj: string | null;
  storeName: string | null;
  storeProductCode: string | null;
  sampleDescription: string;
  n: number;
  sampleItemId: string;
}
interface ProductRow {
  id: string;
  ean: string | null;
  name: string;
  category_id: string | null;
  base_unit: 'G' | 'ML' | 'UN' | null;
  pantry_policy?: 'ALWAYS' | 'ASK' | 'NEVER' | null;
  stock_control?: number | null;
  status?: 'ATIVO' | 'INATIVO' | null;
  /** v101 — origem do produto. 'USER' = decidido pelo usuário (Catálogo/
   *  Revisão). 'NFCE' = AUTO-criado na leitura — NUNCA entra em Despensa/
   *  Lista até o usuário classificar. */
  origin?: 'USER' | 'NFCE' | null;
}
interface CategoryRow { id: string; name: string; parent_id: string | null; archived_at: string | null; }
interface PantryRow { product_id: string; quantity_base: number; base_unit?: string | null; low_threshold_base?: number | null; }

type Tab = 'PENDENTES' | 'COM_ESTOQUE' | 'SEM_ESTOQUE' | 'INATIVO';

export default function ProdutosScreen() {
  const services = useDataEffect();
  const bump = React.useCallback(() => {}, []); // (Refresh manual se precisar)
  const [products, setProducts] = React.useState<ProductRow[]>([]);
  const [pending, setPending] = React.useState<PendingGroup[]>([]);
  const [categories, setCategories] = React.useState<CategoryRow[]>([]);
  const [pantry, setPantry] = React.useState<PantryRow[]>([]);
  const [search, setSearch] = React.useState('');
  // v101: carrossel com 4 abas — começa nos Pendentes se houver; senão em Com Estoque.
  const [tab, setTab] = React.useState<Tab>('PENDENTES');

  // useDataEffect provides dataVersion trigger via appStore.bump().
  // We fetch on mount and on data version changes.
  React.useEffect(() => {
    const load = async () => {
      const [plist, clist, pantryList, pend] = await Promise.all([
        services.products.listProducts(500),
        services.categories.listActive(),
        services.pantry.listPantry(),
        services.nfce.listPendingItems(),
      ]);
      setProducts(plist as unknown as ProductRow[]);
      setCategories(clist as unknown as CategoryRow[]);
      setPantry(pantryList as unknown as PantryRow[]);
      setPending(pend as unknown as PendingGroup[]);
    };
    void load();
  }, [services]);
  // Buscar subscribe to data version
  useDataEffect(async (svc) => {
    const [plist, clist, pantryList, pend] = await Promise.all([
      svc.products.listProducts(500),
      svc.categories.listActive(),
      svc.pantry.listPantry(),
      svc.nfce.listPendingItems(),
    ]);
    setProducts(plist as unknown as ProductRow[]);
    setCategories(clist as unknown as CategoryRow[]);
    setPantry(pantryList as unknown as PantryRow[]);
    setPending(pend as unknown as PendingGroup[]);
  });

  const categoryLabelOf = React.useCallback((p: ProductRow): string => {
    if (!p.category_id) return 'Sem categoria';
    const row = categories.find((c) => c.id === p.category_id);
    if (!row) return 'Sem categoria';
    if (row.parent_id) {
      const parent = categories.find((c) => c.id === row.parent_id);
      return parent ? `${parent.name} › ${row.name}` : row.name;
    }
    return row.name;
  }, [categories]);

  const stockLabelOf = React.useCallback((p: ProductRow): string => {
    if (!p.stock_control) return 'Sem controle';
    const s = pantry.find((x) => x.product_id === p.id);
    const q = s?.quantity_base ?? 0;
    const unit = s?.base_unit ?? p.base_unit;
    if (unit === 'G') return `${q} g`;
    if (unit === 'ML') return `${q} ml`;
    return `${q} un`;
  }, [pantry]);

  // v101: filtra pela aba e pela busca. A regra da aba é só pelos campos do
// próprio produto (decisão do usuário): origin='USER' + status + stock_control.
  const filteredByTab = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (p: ProductRow): boolean => (q ? p.name.toLowerCase().includes(q) : true);
    const ativo = (p: ProductRow): boolean => (p.status ?? 'ATIVO') === 'ATIVO';
    const userDecided = (p: ProductRow): boolean => (p.origin ?? 'NFCE') === 'USER';
    const byTab: Record<Tab, ProductRow[]> = {
      PENDENTES: [], // aqui é a lista de NF pendentes (abaixo) — não usa products
      COM_ESTOQUE: products.filter((p) => userDecided(p) && ativo(p) && (p.stock_control ?? 0) === 1 && match(p)),
      SEM_ESTOQUE: products.filter((p) => userDecided(p) && ativo(p) && (p.stock_control ?? 0) === 0 && match(p)),
      INATIVO: products.filter((p) => ((p.status ?? 'ATIVO') === 'INATIVO') && match(p)),
    };
    return byTab;
  }, [products, search]);

  // Render
  const tabOptions: Array<{ value: Tab; label: string }> = [
    { value: 'PENDENTES', label: `Pendentes (${pending.length})` },
    { value: 'COM_ESTOQUE', label: `Com Estoque (${filteredByTab.COM_ESTOQUE.length})` },
    { value: 'SEM_ESTOQUE', label: `Sem Estoque (${filteredByTab.SEM_ESTOQUE.length})` },
    { value: 'INATIVO', label: `Inativo|Excluído (${filteredByTab.INATIVO.length})` },
  ];
  return (
    <Screen title="Catálogo de Produto">
      {/* v101 — CARROSSEL: 4 abas Segmented. */}
      <Segmented<Tab> options={tabOptions} value={tab} onChange={setTab} />

      <TextField label="Buscar produto" value={search} onChangeText={setSearch} placeholder="Ex.: Café • Gourmet • 500G" />

      {/* ABA: PENDENTES DE CLASSIFICAÇÃO — itens da NF que o usuário precisa TOCAR. */}
      {tab === 'PENDENTES' ? (
        pending.length === 0 ? (
          <EmptyState icon={ICONS.produtos} title="Nada pendente" hint="Tudo classificado. Os novos itens da NF caem aqui na próxima leitura." />
        ) : (
          <Card className="!py-3 border-amber-300">
            <Text className={`font-bold ${theme.primaryText}`}>Pendentes de classificação ({pending.length})</Text>
            <Text className="text-[11px] text-slate-500 mt-0.5">
              Toque em "＋ Criar produto" para classificar 1 vez — só então o produto entra na Despensa ou na Lista de Compra.
            </Text>
            <View className="mt-2 gap-2">
              {pending.map((g) => (
                <PendingRow key={g.groupKey} group={g} onCreateNew={() => router.push(`/produtos/novo?pending=${encodeURIComponent(JSON.stringify({
                  description: g.sampleDescription, cnpj: g.cnpj, storeName: g.storeName, storeProductCode: g.storeProductCode, itemId: g.sampleItemId,
                }))}`)} onIgnore={async () => {
                  try { await services.nfce.ignorePendingBatch({ cnpj: g.cnpj, storeProductCode: g.storeProductCode }); showToast('Ignorado'); bump(); }
                  catch (e) { showToast(e instanceof Error ? e.message : String(e), 'err'); }
                }} />
              ))}
            </View>
          </Card>
        )
      ) : (
        <>
          {filteredByTab[tab].length === 0 ? (
            <EmptyState
              icon={ICONS.produtos}
              title={tab === 'INATIVO' ? 'Sem inativos ou excluídos' : tab === 'COM_ESTOQUE' ? 'Sem produtos com controle' : 'Sem produtos sem controle'}
              hint={tab === 'INATIVO' ? 'Nenhum produto inativo ainda.' : 'Use "+ Novo produto" ou classifique um item da aba Pendentes.'}
            />
          ) : filteredByTab[tab].map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              categoryLabel={categoryLabelOf(p)}
              stockLabel={stockLabelOf(p)}
            />
          ))}
        </>
      )}

      <Button label="＋ Novo produto" variant="primary" onPress={() => router.push('/produtos/novo')} />
    </Screen>
  );
}

const ProductCard = React.memo(function ProductCard({ product, categoryLabel, stockLabel }: {
  product: ProductRow;
  categoryLabel: string;
  stockLabel: string;
}) {
  const inactive = (product.status ?? 'ATIVO') === 'INATIVO';
  return (
    <Pressable
      onPress={() => router.push(`/produtos/${product.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`Editar ${product.name}`}
    >
      <Card className={inactive ? '!py-3 opacity-60' : '!py-3'}>
        <View className="flex-row justify-between items-center gap-2">
          <View className="flex-1">
            <Text className="font-semibold text-slate-900">{displayProductName(product.name)}</Text>
            <Text className="text-xs text-slate-500 mt-0.5">{categoryLabel}</Text>
            <Text className={`text-sm font-bold mt-0.5 ${theme.primaryText}`}>{stockLabel}</Text>
            <Text className="text-[11px] text-slate-400 mt-0.5">
              {product.stock_control ? 'Com controle' : 'Sem controle'}{inactive ? ' · Inativo' : ''}
            </Text>
          </View>
          <Pressable
            onPress={() => router.push(`/produtos/${product.id}`)}
            accessibilityRole="button"
            accessibilityLabel={`Editar ${product.name}`}
            className="bg-amber-50 rounded-lg px-3 py-2"
          >
            <Text className="font-bold text-amber-700">{ICONS.editar}</Text>
          </Pressable>
        </View>
      </Card>
    </Pressable>
  );
});

const PendingRow = React.memo(function PendingRow({ group, onCreateNew, onIgnore }: {
  group: PendingGroup;
  onCreateNew: () => void;
  onIgnore: () => void;
}) {
  const sampleName = displayProductName(group.sampleDescription) || group.sampleDescription || '(sem descrição)';
  return (
    <View className="border border-slate-200 rounded-lg p-3 bg-white">
      <Text className="font-medium text-slate-900">{sampleName}</Text>
      <Text className="text-[11px] text-slate-500 mt-0.5">
        {group.storeName ?? 'Loja'}{group.storeProductCode ? ` · código ${group.storeProductCode}` : ''} · {group.n} item(ns) desta nota
      </Text>
      <View className="mt-2 flex-row gap-2">
        <Pressable onPress={onCreateNew} className="bg-amber-50 px-3 py-2 rounded-lg" accessibilityRole="button">
          <Text className="text-amber-800 font-medium">＋ Criar produto</Text>
        </Pressable>
        <Pressable onPress={onIgnore} className="bg-slate-50 px-3 py-2 rounded-lg" accessibilityRole="button">
          <Text className="text-slate-700 font-medium">Não é produto</Text>
        </Pressable>
      </View>
    </View>
  );
});
