/** Tela OFX — importação batch (Fase 5) e histórico de conciliações. */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { showToast } from '../lib/toast';
import { router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { Screen, Card, Select, Button, EmptyState, SectionTitle, Badge } from '../src/components/ui';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { formatBRL } from '../src/lib/money';
import { ymdToBr } from '../src/lib/dates';

interface ImportRow {
  id: string;
  account_id: string;
  account_name: string | null;
  imported_at: string;
  lines_processed: number;
}

export default function OfxScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [imports, setImports] = React.useState<ImportRow[]>([]);
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [accounts, setAccounts] = React.useState<Array<{ id: string; label: string }>>([]);
  const [busy, setBusy] = React.useState(false);
  const [lastSummary, setLastSummary] = React.useState<string | null>(null);

  useDataEffect(async (svc) => {
    const [list, accs] = await Promise.all([
      svc.ofx.listImports(),
      svc.db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE archived_at IS NULL ORDER BY name'),
    ]);
    setImports(list as unknown as ImportRow[]);
    setAccounts(accs.map((a) => ({ id: a.id, label: a.name })));
  });

  const pickAndImport = async () => {
    try {
      if (!accountId) throw new Error('Selecione a conta do extrato');
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.length) return;
      const file = res.assets[0];
      const content = await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.UTF8 });
      setBusy(true);
      const summary = await services.ofx.importOfx(accountId, content);
      setLastSummary(
        `${summary.totalLines} linhas · ${summary.matchedAuto} conciliadas · ${summary.ambiguous} ambíguas · ${summary.newTransactions} novas`
      );
      bump();
      // v19: sem popup — o resumo já fica na tela; toque em "Revisar" quando quiser
      showToast(`Importação concluída: ${summary.totalLines} linhas · ${summary.newTransactions} novas`);
      router.push(`/ofx/${summary.importId}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Importar OFX">
      <Card className="gap-3">
        <Select label="Conta do extrato" items={accounts} selectedId={accountId} onSelect={setAccountId} />
        <Button label="Selecionar arquivo .ofx/.qfx" onPress={pickAndImport} loading={busy} />
        <Text className="text-[11px] text-slate-500">
          Dedupe por SHA-256: o mesmo arquivo nunca é importado duas vezes. Lançamentos manuais/NFC-e de mesmo valor na janela de datas são conciliados, não duplicados.
        </Text>
      </Card>

      {lastSummary ? (
        <Card><Text className="text-sm font-semibold text-emerald-700">{lastSummary}</Text></Card>
      ) : null}

      <SectionTitle>Importações</SectionTitle>
      {imports.length === 0 ? (
        <EmptyState icon="📥" title="Nenhuma importação" hint="Exporte o OFX do seu banco e importe aqui." />
      ) : (
        imports.map((imp) => (
          <Pressable key={imp.id} onPress={() => router.push(`/ofx/${imp.id}`)}>
            <Card className="!py-3 mb-1">
              <View className="flex-row justify-between items-center">
                <View>
                  <Text className="font-semibold text-slate-900">{imp.account_name ?? 'Conta'}</Text>
                  <Text className="text-xs text-slate-500">
                    {ymdToBr(imp.imported_at.slice(0, 10))} · {imp.lines_processed} linhas
                  </Text>
                </View>
                <Text className="text-emerald-700 font-semibold text-sm">Revisar ›</Text>
              </View>
            </Card>
          </Pressable>
        ))
      )}
    </Screen>
  );
}
