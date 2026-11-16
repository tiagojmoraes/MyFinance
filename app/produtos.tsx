/**
 * Tela CATÁLOGO DE PRODUTO (v57/v58 → v68) — Cadastros → Catálogo de Produto.
 * Mesmo esquema de cores/layout do programa: Screen + Card + TextField +
 * EmptyState, tema emerald/slate (src/theme), pictogramas do mapa único (ICONS).
 * Regras v57 acordadas:
 *  - Classificar 1 vez AQUI (categoria/subcategoria), nunca durante a NF.
 *  - NÃO mostra "onde aprendeu" (CNPJ+código fica só no banco); SEM EAN na lista.
 *  - Memória da despensa: SEMPRE / PERGUNTAR / NUNCA (pantry_policy, migração v49).
 *  - Estoque por unidade da NF: mostra o que a Despensa tem (G/ML/UN no ledger).
 *  - + Produto novo abre a TELA DE EDIÇÃO (/produtos/novo).
 * v68 — A LISTA É SÓ VISUALIZAÇÃO:
 *  - os controles −1 / +1 / Lixeira saíram (são da DESPENSA, não do Catálogo);
 *  - o lápis (e o toque no cartão) abre a TELA DE EDIÇÃO própria
 *    (/produtos/ID) — editar e excluir acontecem lá.
 * v68 — DESEMPENHO: lista filtrada memoizada (useMemo) e linha memoizada
 * (React.memo) — mexer em 1 produto não re-renderiza a lista inteira.
 */
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, TextField, Button, EmptyState } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { ICONS } from '../src/theme/icons';
import { theme } from '../src/theme';

type PantryPolicy = 'ALWAYS' | 'ASK' | 'NEVER';
type BaseUnit = 'G' | 'ML' | 'UN';

interface ProductRow {
  id: string;
  ean: string | null;
  name: string;
  category_id: string | null;
  base_unit: BaseUnit | null;
  pantry_policy?: PantryPolicy | null;
}
interface CategoryRow { id: string; name: string; parent_id: string | null; icon: string | null; archived_at: string | null; }
interface PantryRow { product_id: string; quantity_base: number; base_unit?: string | null; low_threshold_base?: number | null; }

const POLICY_LABEL: Record<PantryPolicy, string> = { ALWAYS: 'Sempre', ASK: 'Perguntar', NEVER: 'Nunca' };

export default function ProdutosScreen() {
  const services = useDataEffect();
  const [products, setProducts] = React.useState<ProductRow[]>([]);
  const [categories, setCategories] = React.useState<CategoryRow[]>([]);
  const [pantry, setPantry] = React.useState<PantryRow[]>([]);
  const [search, setSearch] = React.useState('');

  const load = React.useCallback(async (svc: typeof services) => {
    const [plist, clist, pantryList] = await Promise.all([
      svc.products.listProducts(500),
      svc.categories.listActive(),
      svc.pantry.listPantry(),
    ]);
    setProducts(plist as unknown as ProductRow[]);
    setCategories(clist as unknown as CategoryRow[]);
    setPantry(pantryList as unknown as PantryRow[]);
  }, [services]);
  useDataEffect(async (svc) => { await load(svc); });

  // v68 — memoizado: rótulo de categoria e estoque por produto (só refaz quando
  // os dados carregam; a digitação na busca não recalcula nada disso)
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
    const s = pantry.find((x) => x.product_id === p.id);
    if (!s) return 'Sem estoque';
    if (s.base_unit === 'G' || p.base_unit === 'G') return `${s.quantity_base} g`;
    if (s.base_unit === 'ML' || p.base_unit === 'ML') return `${s.quantity_base} ml`;
    return `${s.quantity_base} un`;
  }, [pantry]);

  // v68: filtro memoizado — digitar não toca nos dados, só refiltra
  const filtered = React.useMemo(
    () => products.filter((p) => !search.trim() || p.name.toLowerCase().includes(search.trim().toLowerCase())),
    [products, search]
  );

  return (
    <Screen title="Catálogo de Produto">
      <TextField label="Buscar produto" value={search} onChangeText={setSearch} placeholder="Ex.: Banana Prata" />
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
      <Text className="text-[11px] text-slate-400 text-center px-6">Dica: na importação da NF, o item novo abre o formulário de produto. Você cadastra 1 vez e a próxima nota já resolve sozinha. Para editar ou excluir, toque no produto (ou no {ICONS.editar}).</Text>
    </Screen>
  );
}

/** v68 — linha do catálogo MEMOIZADA (só visualização: sem −1/+1/Lixeira).
 *  Props primitivas → React.memo evita re-render da lista inteira quando só
 *  1 produto muda. */
const ProductCard = React.memo(function ProductCard({ product, categoryLabel, stockLabel }: {
  product: ProductRow;
  categoryLabel: string;
  stockLabel: string;
}) {
  const policy = (product.pantry_policy as PantryPolicy) ?? 'ASK';
  return (
    <Pressable
      onPress={() => router.push(`/produtos/${product.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`Editar ${product.name}`}
    >
      <Card className="!py-3">
        <View className="flex-row justify-between items-center gap-2">
          <View className="flex-1">
            <Text className="font-semibold text-slate-900">{product.name}</Text>
            <Text className="text-xs text-slate-500 mt-0.5">{categoryLabel}</Text>
            <Text className={`text-sm font-bold mt-0.5 ${theme.primaryText}`}>{stockLabel}</Text>
            {/* v67 (MELHORIA 2): lista SEM EAN e SEM CNPJ+código — ficam só no
                banco (aprendidos sozinhos pela NF); aqui é só o que importa. */}
            <Text className="text-[11px] text-slate-400 mt-0.5">Despensa: {POLICY_LABEL[policy]}</Text>
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
