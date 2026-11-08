/** Tela Despensa — cache atômico, alertas de estoque baixo e movimentos manuais.
 *  v68 (DESEMPENHO): linha da lista MEMOIZADA (React.memo com props primitivas)
 *  — mexer em 1 produto não re-renderiza a despensa inteira. */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { showToast } from '../lib/toast';
import { Screen, Card, TextField, Select, Button, EmptyState, SectionTitle } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { genId } from '../src/lib/id';

interface PantryItem {
  product_id: string;
  name: string;
  base_unit: 'G' | 'ML' | 'UN' | null;
  quantity_base: number;
  low_threshold_base: number | null;
  isLow: boolean;
}

export default function DespensaScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [items, setItems] = React.useState<PantryItem[]>([]);
  const [tab, setTab] = React.useState<'LIST' | 'NEW'>('LIST');
  const [name, setName] = React.useState('');
  const [ean, setEan] = React.useState('');
  const [unit, setUnit] = React.useState<string | null>('UN');
  const [threshold, setThreshold] = React.useState('');

  const load = React.useCallback(async () => {
    const list = await services.pantry.listPantry();
    setItems(list as unknown as PantryItem[]);
  }, [services]);

  useDataEffect(load);

  const addProduct = async () => {
    try {
      if (!name.trim()) throw new Error('Informe o nome do produto');
      const product = await services.products.createManualProduct({
        name: name.trim(),
        ean: ean.trim() ? ean.trim() : null,
        baseUnit: (unit as 'G' | 'ML' | 'UN') ?? 'UN',
      });
      const th = parseInt(threshold, 10);
      await services.pantry.setLowThreshold(product.id, Number.isInteger(th) ? th : null);
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
    if (item.base_unit === 'G') return `${item.quantity_base} g`;
    if (item.base_unit === 'ML') return `${item.quantity_base} ml`;
    return `${item.quantity_base} un`;
  };

  const units = [
    { id: 'UN', label: 'Unidade' },
    { id: 'G', label: 'Gramas' },
    { id: 'ML', label: 'Mililitros' },
  ];

  return (
    <Screen title="Despensa">
      {items.length === 0 ? (
        <EmptyState icon="🧺" title="Despensa vazia" hint="Produtos aparecem aqui via NFC-e ou cadastro manual." />
      ) : (
        items.map((item) => (
          <PantryRow
            key={item.product_id}
            item={item}
            qtyLabel={fmtQty(item)}
            onMove={moveById}
          />
        ))
      )}

      <SectionTitle>Novo produto</SectionTitle>
      <Card className="gap-3">
        <TextField label="Nome" value={name} onChangeText={setName} placeholder="Ex.: Arroz 5kg" />
        <TextField label="EAN/GTIN (opcional)" value={ean} onChangeText={setEan} keyboardType="numeric" placeholder="789..." />
        <Select label="Unidade base" items={units} selectedId={unit} onSelect={setUnit} />
        <TextField label="Alerta de estoque baixo (na unidade base)" value={threshold} onChangeText={setThreshold} keyboardType="numeric" placeholder="Ex.: 1000" />
        <Button label="Cadastrar produto" onPress={addProduct} />
      </Card>
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
