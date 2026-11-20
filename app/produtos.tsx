/**
 * Catálogo de Produto (v100 — NOME/AMARRAÇÃO/CLASSIFICAÇÃO ÚNICA):
 *  · lista: nome COM ` • `, status (Ativo/Inativo), estoque atual + mínimo
 *    (só controla), categoria ▸ subcategoria;
 *  · seção "Novos da NF (N)" no topo: agrupada por (cnpj + código) com
 *    top-3 fuzzy + confirmar em 1 toque (sem nova tela);
 *  · "+ Novo produto" abre `/produtos/novo` (formulário único);
 *  · inativo some por padrão; "+ ver inativos" mostra.
 */
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, TextField, Button, EmptyState } from '../src/components/ui';
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
  suggestions: Array<{ productId: string; name: string; score: number }>;
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
}
interface CategoryRow { id: string; name: string; parent_id: string | null; archived_at: string | null; }
interface PantryRow { product_id: string; quantity_base: number; base_unit?: string | null; low_threshold_base?: number | null; }

export default function ProdutosScreen() {
  const services = useDataEffect();
  const bump = React.useCallback(() => {}, []); // (Refresh manual se precisar)
  const [products, setProducts] = React.useState<ProductRow[]>([]);
  const [pending, setPending] = React.useState<PendingGroup[]>([]);
  const [categories, setCategories] = React.useState<CategoryRow[]>([]);
  const [pantry, setPantry] = React.useState<PantryRow[]>([]);
  const [search, setSearch] = React.useState('');
  const [showInactive, setShowInactive] = React.useState(false);

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

  const filtered = React.useMemo(() => products.filter((p) => {
    if (!showInactive && (p.status ?? 'ATIVO') !== 'ATIVO') return false;
    if (!search.trim()) return true;
    return p.name.toLowerCase().includes(search.trim().toLowerCase());
  }), [products, search, showInactive]);

  /** v100 — 1 TOQUE: confirma que esse código da loja é o produto escolhido,
   *  grava a amarração (CNPJ + código), vincula TODOS os itens pendentes do
   *  mesmo (cnpj, código) e aplica estoque (Com controle + dimensão ok). */
  const confirmPending = React.useCallback(async (g: PendingGroup, productId: string) => {
    try {
      await services.nfce.classifyPendingBatch({
        cnpj: g.cnpj,
        storeProductCode: g.storeProductCode,
        productId,
      });
      showToast('Classificado');
      bump();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'err');
    }
  }, [services, bump]);

  // Render
  return (
    <Screen title="Catálogo de Produto">
      <TextField label="Buscar produto" value={search} onChangeText={setSearch} placeholder="Ex.: Café • Gourmet • 500G" />

      {/* v100 — NOVO DA NF (pendente de classificação) */}
      {pending.length > 0 && (
        <Card className="!py-3 border-amber-300">
          <Text className={`font-bold ${theme.primaryText}`}>Novos da NF ({pending.length})</Text>
          <Text className="text-[11px] text-slate-500 mt-0.5">
            Toque em uma sugestão para confirmar. 1 toque = resolvido para sempre nesta loja.
          </Text>
          <View className="mt-2 gap-2">
            {pending.map((g) => (
              <PendingRow key={g.groupKey} group={g} onConfirm={(p) => confirmPending(g, p)} onCreateNew={() => router.push(`/produtos/novo?pending=${encodeURIComponent(JSON.stringify({
                description: g.sampleDescription, cnpj: g.cnpj, storeName: g.storeName, storeProductCode: g.storeProductCode, itemId: g.sampleItemId,
              }))}`)} onIgnore={async () => {
                try { await services.nfce.ignorePendingBatch({ cnpj: g.cnpj, storeProductCode: g.storeProductCode }); showToast('Ignorado'); bump(); }
                catch (e) { showToast(e instanceof Error ? e.message : String(e), 'err'); }
              }} />
            ))}
          </View>
        </Card>
      )}

      {filtered.length === 0 ? (
        <EmptyState icon={ICONS.produtos} title="Nenhum produto" hint="Cadastre o primeiro produto ou importe uma NF — os itens novos caem aqui." />
      ) : filtered.map((p) => (
        <ProductCard
          key={p.id}
          product={p}
          categoryLabel={categoryLabelOf(p)}
          stockLabel={stockLabelOf(p)}
        />
      ))}

      <Button label="＋ Novo produto" variant="primary" onPress={() => router.push('/produtos/novo')} />
      <Pressable onPress={() => setShowInactive((v) => !v)} accessibilityRole="button">
        <Text className="text-[11px] text-slate-400 text-center px-6 mt-2">
          {showInactive ? 'Ocultar inativos' : 'Mostrar inativos'}
        </Text>
      </Pressable>
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

const PendingRow = React.memo(function PendingRow({ group, onConfirm, onCreateNew, onIgnore }: {
  group: PendingGroup;
  onConfirm: (productId: string) => void;
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
      {group.suggestions.length > 0 ? (
        <View className="mt-2 flex-row flex-wrap gap-2">
          {group.suggestions.slice(0, 3).map((s) => (
            <Pressable key={s.productId} onPress={() => onConfirm(s.productId)} accessibilityRole="button"
              className="bg-emerald-50 px-3 py-2 rounded-lg">
              <Text className="text-emerald-900 font-bold">
                {displayProductName(s.name)} {Math.round(s.score * 100)}%
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text className="text-[11px] text-slate-500 mt-2">Nenhuma sugestão aceita o mínimo de semelhança.</Text>
      )}
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
