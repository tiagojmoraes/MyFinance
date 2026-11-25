/**
 * NOVO PRODUTO (v104) — tela PRÓPRIA para cadastrar produto a partir da Despensa.
 *
 * O botão "＋" da Despensa abre esta tela no padrão do app (+ em app/contas.tsx).
 * O formulário inline antigo do ListFooterComponent saiu — ele violava o
 * padrão do app (cadastro embaixo da lista) e ainda tinha o campo EAN/GTIN,
 * que NÃO cabe em cadastro manual: o EAN só vem da NFC-e.
 *
 * Campos:
 *  · Nome (obrigatório)
 *  · Unidade Medida — apenas "Unidade" (UN) e "Quilos" (Q). ML é legado:
 *    continua aparecendo em produtos antigos (Catálogo / tela do produto) mas
 *    não é mais opção de criação.
 *  · Alerta de estoque baixo — para Kilos usa decimal pt-BR (parseKgToGrams),
 *    para Unidade usa número inteiro.
 *
 * Salva: produto com origin='USER' + stock_control=1 + status='ATIVO' + limite.
 */

import React from 'react';
import { View, Text } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, TextField, Select, Button } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';
import { parseKgToGrams } from '../src/lib/money';

type NewProductUnit = 'UN' | 'G';

const UNITS: Array<{ id: NewProductUnit; label: string }> = [
  { id: 'UN', label: 'Unidade' },
  { id: 'G', label: 'Quilos' },
];

export default function ProdutoNovoScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [name, setName] = React.useState('');
  const [unit, setUnit] = React.useState<NewProductUnit>('UN');
  const [threshold, setThreshold] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const isKg = unit === 'G';

  const thresholdLabel = isKg
    ? 'Alerta de estoque baixo (kg)'
    : 'Alerta de estoque baixo (un)';

  const save = async () => {
    if (!name.trim()) {
      showToast('Informe o nome do produto', 'err');
      return;
    }
    setSaving(true);
    try {
      const product = await services.products.createManualProduct({
        name: name.trim(),
        // v104: EAN nunca vem do cadastro manual — só da NFC-e.
        ean: null,
        baseUnit: unit,
      });
      const th = isKg ? parseKgToGrams(threshold) : parseInt(threshold, 10);
      const valid = isKg ? Number.isFinite(th) : Number.isInteger(th);
      await services.pantry.setLowThreshold(product.id, valid ? th : null);
      bump();
      router.back();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen title="Novo Produto">
      <Card className="gap-3">
        <TextField label="Nome" value={name} onChangeText={setName} placeholder="Ex.: Arroz 5kg" />
        <Select
          label="Unidade Medida"
          items={UNITS}
          selectedId={unit}
          onSelect={(id) => setUnit((id as NewProductUnit) ?? 'UN')}
        />
        <TextField
          label={thresholdLabel}
          value={threshold}
          onChangeText={setThreshold}
          keyboardType={isKg ? 'decimal-pad' : 'numeric'}
          placeholder={isKg ? 'Ex.: 0,5' : 'Ex.: 3'}
        />
        <View className="flex-row gap-2 mt-1">
          <View className="flex-1">
            <Button label="Cancelar" variant="outline" onPress={() => router.back()} />
          </View>
          <View className="flex-1">
            <Button label="Cadastrar produto" onPress={save} loading={saving} />
          </View>
        </View>
      </Card>
      <Text className="text-xs text-slate-400 px-1">
        O produto entra na Despensa como Com controle e Ativo. O EAN vem da NFC-e quando o item chega pela próxima nota — não é preciso digitar aqui.
      </Text>
    </Screen>
  );
}
