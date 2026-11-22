/**
 * NOVA LISTA DE COMPRA (v104) — tela PRÓPRIA para MONTAR listas salvas.
 *
 * O botão "＋ Nova lista de compra" da aba "Lista de Compra" da Despensa
 * abre esta tela. Reaproveita `listClassifiedActive` (Catálogo) e o botão
 * "Abaixo do mínimo". O usuário escolhe produtos, ajusta a quantidade por
 * item (UN inteiro, Kilos/ML em decimal pt-BR via parseKgToGrams), dá um
 * nome e cria a lista — ela aparece na aba com nome, data, nº de itens e
 * total estimado.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, TextField, Button, EmptyState, SectionTitle } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';
import { formatStockQty, parseKgToGrams } from '../src/lib/money';

interface ClassifiedItem {
  product_id: string;
  name: string;
  base_unit: 'G' | 'ML' | 'UN' | null;
  quantity_base: number;
  low_threshold_base: number | null;
  isLow: boolean;
}

interface DraftRow {
  productId: string;
  qtyBase: number;
  qtyText: string;
}

export default function ListaCompraNovaScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [classified, setClassified] = React.useState<ClassifiedItem[]>([]);
  const [name, setName] = React.useState('');
  const [selected, setSelected] = React.useState<Map<string, DraftRow>>(new Map());
  const [saving, setSaving] = React.useState(false);

  useDataEffect(async (svc) => {
    const list = await svc.pantry.listClassifiedActive();
    setClassified(list as unknown as ClassifiedItem[]);
  });

  // qty padrão: UN → 1, KG → 100g (= 0,1 kg), ML → 100.
  const defaultQtyFor = (item: ClassifiedItem): { qtyBase: number; qtyText: string } => {
    if (item.base_unit === 'G') return { qtyBase: 100, qtyText: '0,1' };
    if (item.base_unit === 'ML') return { qtyBase: 100, qtyText: '100' };
    return { qtyBase: 1, qtyText: '1' };
  };

  const toggle = (item: ClassifiedItem) => {
    setSelected((cur) => {
      const next = new Map(cur);
      if (next.has(item.product_id)) {
        next.delete(item.product_id);
      } else {
        const def = defaultQtyFor(item);
        next.set(item.product_id, { productId: item.product_id, qtyBase: def.qtyBase, qtyText: def.qtyText });
      }
      return next;
    });
  };

  const addBelowMinimum = () => {
    const baixos = classified.filter((i) => i.isLow);
    if (baixos.length === 0) {
      showToast('Nada abaixo do mínimo — tudo em dia');
      return;
    }
    setSelected((cur) => {
      const next = new Map(cur);
      for (const b of baixos) {
        if (next.has(b.product_id)) continue;
        const def = defaultQtyFor(b);
        next.set(b.product_id, { productId: b.product_id, qtyBase: def.qtyBase, qtyText: def.qtyText });
      }
      return next;
    });
    showToast(`${baixos.length} produto(s) abaixo do mínimo entraram na lista`);
  };

  const setQtyText = (productId: string, text: string) => {
    setSelected((cur) => {
      const next = new Map(cur);
      const r = next.get(productId);
      if (!r) return next;
      const item = classified.find((i) => i.product_id === productId);
      if (!item) return next;
      let qtyBase = 0;
      if (item.base_unit === 'G') {
        const g = parseKgToGrams(text);
        if (Number.isFinite(g) && g > 0) qtyBase = g;
      } else {
        const n = parseInt(text, 10);
        if (Number.isInteger(n) && n > 0) qtyBase = n;
      }
      next.set(productId, { productId, qtyBase, qtyText: text });
      return next;
    });
  };

  const save = async () => {
    const items = Array.from(selected.values()).filter((r) => r.qtyBase > 0);
    if (items.length === 0) {
      showToast('Selecione ao menos um produto', 'err');
      return;
    }
    const listName = name.trim() || 'Lista de Compra';
    setSaving(true);
    try {
      await services.shoppingList.create(listName, items.map((r) => ({ productId: r.productId, qtyBase: r.qtyBase })));
      showToast('Lista criada');
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen title="Nova Lista de Compra">
      <Card className="gap-2">
        <TextField
          label="Nome da lista"
          value={name}
          onChangeText={setName}
          placeholder="Ex.: Feira da semana"
        />
        <View className="flex-row gap-2 mt-1">
          <View className="flex-1">
            <Button label="Cancelar" variant="outline" onPress={() => router.back()} />
          </View>
          <View className="flex-1">
            <Button label={`Criar Lista (${selected.size})`} onPress={save} loading={saving} />
          </View>
        </View>
      </Card>

      <Button label={`＋ Abaixo do mínimo (${classified.filter((i) => i.isLow).length})`} variant="outline" onPress={addBelowMinimum} />

      <SectionTitle>Produtos classificados ({classified.length})</SectionTitle>
      {classified.length === 0 ? (
        <EmptyState icon="🧺" title="Sem produtos classificados" hint="Classifique itens pelas notas ou cadastre no catálogo para montar a lista." />
      ) : (
        classified.map((item) => {
          const r = selected.get(item.product_id);
          const na = !!r;
          const kb = item.base_unit === 'G' ? 'decimal-pad' as const : 'numeric' as const;
          const placeholder = item.base_unit === 'G' ? 'Ex.: 0,5' : 'Ex.: 3';
          return (
            <View key={item.product_id}>
              <Pressable
                onPress={() => toggle(item)}
                accessibilityRole="button"
                className={`flex-row justify-between items-center rounded-lg px-3 py-2 border ${na ? 'bg-emerald-50 border-emerald-300' : 'bg-white border-slate-200'}`}
              >
                <View className="flex-1">
                  <Text className={`text-sm font-medium ${na ? 'text-emerald-800' : 'text-slate-700'}`} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text className="text-[11px] text-slate-400">
                    {formatStockQty(item.base_unit, item.quantity_base)}{item.isLow ? ' · ⚠ estoque baixo' : ''}
                  </Text>
                </View>
                <Text className={`text-sm font-bold ${na ? 'text-emerald-600' : 'text-slate-300'}`}>{na ? '✓' : '＋'}</Text>
              </Pressable>
              {na && r ? (
                <View className="pl-2 pt-1 pb-2">
                  <TextField
                    label={`Quantidade (${item.base_unit === 'G' ? 'kg' : item.base_unit === 'ML' ? 'ml' : 'un'})`}
                    value={r.qtyText}
                    onChangeText={(t) => setQtyText(item.product_id, t)}
                    keyboardType={kb}
                    placeholder={placeholder}
                  />
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </Screen>
  );
}
