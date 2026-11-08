/** Tela Ajustes — v69:
 *  · v68: TUDO que o usuário pode selecionar ficou AGLUTINADO em grupos com
 *    setinha (PREFERENCIAS · BACKUP · DADOS · SOBRE) — mesmo padrão do app.
 *  · v69 (pedido do usuário): a SETA DE EXPANSÃO passou para ANTES do nome
 *    do grupo (ex.: "> PREFERENCIAS") e o SOBRE ficou SEMPRE ABERTO, sem seta.
 *  · v69: LAYOUT MELHORADO — cada grupo virou um cabeçalho próprio (barra com
 *    pictograma + título em caixa alta + seta), com resumo do conteúdo, cartão
 *    do corpo com divisórias e rodapé informativo; nada de lista chapada.
 *  · PREFERENCIAS: Exibir Saldo do dia · Orçamento · Poupança · NFC-e · OFX ·
 *    Despensa · MENSAGENS BANCÁRIAS · LISTA DE DESEJOS (os quatro últimos
 *    controlam o atalho na tela inicial — "AÇÕES RÁPIDAS" some se todos
 *    estiverem desligados).
 *  · BACKUP: "Criar Backup agora" e "Restaurar Dados" (v68).
 *  · DADOS: Limpar lançamento e movimentações (texto de sempre).
 *  · SOBRE: App · Versão (só o número) · Versão do Schema.
 *  Backup (VACUUM INTO), restore, preferências persistidas no banco e info do
 *  schema seguem como estavam (v9/v21/v39.2/v62).
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { Screen, Card, Button, KeyValue, ToggleRow } from '../src/components/ui';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { showToast } from '../lib/toast';
import { BackupService } from '../src/services/BackupService';
import { SETTING_KEYS } from '../src/services/SettingsService';
import { clearLancamentos } from '../src/db/seed';
import { ICONS } from '../src/theme/icons';

/** v39.2: versão 100% DINÂMICA — número e etiqueta derivados SEMPRE do app.json
 *  (expo-constants). Subiu a versão no app.json? O SOBRE acompanha sozinho,
 *  sem tocar em nada aqui. */
const APP_VERSION = Constants.expoConfig?.version ?? '—';

/** v69 — GRUPO EXPANSÍVEL com a SETA ANTES DO NOME (pedido do usuário:
 *  "> PREFERENCIAS") — cabeçalho próprio com pictograma, resumo e seta. */
function Group({ icon, title, summary, children, defaultOpen = false }: {
  icon: string;
  title: string;
  /** Resumo curto mostrado no cabeçalho (some quando expandido). */
  summary?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <View className="mt-3">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`${open ? 'Recolher' : 'Expandir'} ${title}`}
        className="flex-row items-center gap-2 bg-white border border-slate-200 rounded-2xl px-3 py-3"
      >
        {/* v69: SETA ANTES das opções (▸/▾) */}
        <Text className="text-sm font-bold text-emerald-700 w-4">{open ? ICONS.recolher : ICONS.expandir}</Text>
        <Text className="text-base">{icon}</Text>
        <View className="flex-1">
          <Text className="text-sm font-bold uppercase tracking-wide text-slate-800">{title}</Text>
          {!open && summary ? (
            <Text className="text-[11px] text-slate-500 mt-0.5" numberOfLines={1}>{summary}</Text>
          ) : null}
        </View>
      </Pressable>
      {open ? <Card className="gap-2 mt-1.5">{children}</Card> : null}
    </View>
  );
}

/** v69 — bloco SOBRE SEMPRE ABERTO, SEM SETA (mesmo padrão visual do Group). */
function AboutBlock({ children }: { children: React.ReactNode }) {
  return (
    <View className="mt-3">
      <View className="flex-row items-center gap-2 bg-white border border-slate-200 rounded-2xl px-3 py-3">
        <Text className="text-sm font-bold text-emerald-700 w-4">✓</Text>
        <Text className="text-base">ℹ️</Text>
        <Text className="text-sm font-bold uppercase tracking-wide text-slate-800 flex-1">Sobre</Text>
      </View>
      <Card className="gap-1 mt-1.5">{children}</Card>
    </View>
  );
}

export default function AjustesScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [backups, setBackups] = React.useState<string[]>([]);
  const [schemaVersion, setSchemaVersion] = React.useState<number | null>(null);
  const [resetting, setResetting] = React.useState(false);
  /** v21 (bug 4): confirmação antes de LIMPAR tudo (exclusão em massa). */
  const [clearConfirmOpen, setClearConfirmOpen] = React.useState(false);
  /** v9: preferência — exibir saldo por dia nos agrupamentos do Fluxo. */
  const [showDaily, setShowDaily] = React.useState(false);
  /** v42: flags ORÇAMENTOS e POUPANÇA — ligam as ações na tela inicial e os cards no Fluxo. */
  const [budgetsOn, setBudgetsOn] = React.useState(false);
  const [savingsOn, setSavingsOn] = React.useState(false);
  /** v68: atalhos NFC-e / OFX / Despensa na tela inicial (agora são toggles daqui). */
  const [nfceOn, setNfceOn] = React.useState(true);
  const [ofxOn, setOfxOn] = React.useState(true);
  const [despensaOn, setDespensaOn] = React.useState(true);
  /** v69: atalhos Mensagens bancárias / Lista de Desejos na tela inicial. */
  const [mensagensOn, setMensagensOn] = React.useState(false);
  const [wishlistOn, setWishlistOn] = React.useState(false);

  const load = React.useCallback(async () => {
    const row = await services.db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    setSchemaVersion(row?.user_version ?? null);
    const backupSvc = makeBackupService(services);
    setBackups(await backupSvc.listBackups());
    setShowDaily(await services.settings.getBool(SETTING_KEYS.fluxoSaldoPorDia, false));
    // v42: flags dos novos módulos
    setBudgetsOn(await services.settings.getBool(SETTING_KEYS.budgetsAtivado, false));
    setSavingsOn(await services.settings.getBool(SETTING_KEYS.poupancaAtivado, false));
    // v68: atalhos da tela inicial (padrão = ligado, comportamento de sempre)
    setNfceOn(await services.settings.getBool(SETTING_KEYS.nfceNaHome, true));
    setOfxOn(await services.settings.getBool(SETTING_KEYS.ofxNaHome, true));
    setDespensaOn(await services.settings.getBool(SETTING_KEYS.despensaNaHome, true));
    // v69: novos atalhos (padrão = desligado, o usuário liga em Ajustes)
    setMensagensOn(await services.settings.getBool(SETTING_KEYS.mensagensNaHome, false));
    setWishlistOn(await services.settings.getBool(SETTING_KEYS.wishlistNaHome, false));
  }, [services]);

  useDataEffect(load);

  const makeBackupService = (svc: typeof services) =>
    new BackupService(svc.db, {
      databasePath: `${FileSystem.documentDirectory}SQLite/myfinance.db`,
      backupsDir: `${FileSystem.documentDirectory}backups/`,
      vacuumInto: async (target) => {
        const driver = svc.db as unknown as { vacuumInto?: (p: string) => Promise<void> };
        if (typeof driver.vacuumInto !== 'function') throw new Error('Driver não suporta VACUUM INTO');
        await driver.vacuumInto(target);
      },
      listFiles: async (dir) => {
        try {
          return await FileSystem.readDirectoryAsync(dir);
        } catch {
          return [];
        }
      },
      ensureDir: async (dir) => {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      },
      copyFile: async (from, to) => {
        await FileSystem.copyAsync({ from, to });
      },
      deleteFile: async (p) => {
        await FileSystem.deleteAsync(p, { idempotent: true });
      },
    });

  const backupNow = async () => {
    try {
      const backupSvc = makeBackupService(services);
      const path = await backupSvc.createBackup();
      bump();
      await load();
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, { mimeType: 'application/x-sqlite3', dialogTitle: 'Backup do MyFinance' });
      } else {
        showToast('Backup criado com sucesso');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const restore = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.length) return;
      const backupSvc = makeBackupService(services);
      const out = await backupSvc.restoreFrom(res.assets[0].uri);
      if (out.needsRestart) {
        showToast('Restauração concluída — feche e reabra o aplicativo');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  /** v9: grava a preferência "Exibir saldo por dia" (persistida no banco). */
  const setShowDailyPref = async (value: boolean) => {
    setShowDaily(value);
    await services.settings.setBool(SETTING_KEYS.fluxoSaldoPorDia, value);
    bump();
  };

  /** v42: grava a flag ORÇAMENTOS (persistida no banco). */
  const setBudgetsOnPref = async (value: boolean) => {
    setBudgetsOn(value);
    await services.settings.setBool(SETTING_KEYS.budgetsAtivado, value);
    bump();
  };

  /** v42: grava a flag POUPANÇA (persistida no banco). */
  const setSavingsOnPref = async (value: boolean) => {
    setSavingsOn(value);
    await services.settings.setBool(SETTING_KEYS.poupancaAtivado, value);
    bump();
  };

  /** v68: grava os atalhos da tela inicial (persistidos no banco). */
  const setNfceOnPref = async (value: boolean) => {
    setNfceOn(value);
    await services.settings.setBool(SETTING_KEYS.nfceNaHome, value);
    bump();
  };
  const setOfxOnPref = async (value: boolean) => {
    setOfxOn(value);
    await services.settings.setBool(SETTING_KEYS.ofxNaHome, value);
    bump();
  };
  const setDespensaOnPref = async (value: boolean) => {
    setDespensaOn(value);
    await services.settings.setBool(SETTING_KEYS.despensaNaHome, value);
    bump();
  };
  /** v69: grava os novos atalhos da tela inicial. */
  const setMensagensOnPref = async (value: boolean) => {
    setMensagensOn(value);
    await services.settings.setBool(SETTING_KEYS.mensagensNaHome, value);
    bump();
  };
  const setWishlistOnPref = async (value: boolean) => {
    setWishlistOn(value);
    await services.settings.setBool(SETTING_KEYS.wishlistNaHome, value);
    bump();
  };

  /** v10 (Req 1): LIMPAR LANÇAMENTOS E MOVIMENTAÇÕES — zera as movimentações
   *  do banco e MANTÉM intocados os cadastros base (Cartões, Contas, Categorias),
   *  além de despensa e catálogo.
   *  v19 (pedido do usuário): LIMPA TAMBÉM AS NFC-e SALVAS (documentos e itens
   *  guardados no banco, inclusive o vínculo de estoque vindo delas).
   *  v21 (bug 4): só executa após CONFIRMAÇÃO (modal). */
  const clearMovements = async () => {
    setResetting(true);
    try {
      await clearLancamentos(services.db);
      bump();
      showToast('Limpeza concluída — lançamentos, movimentações e NFC-e salvas apagados');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setResetting(false);
      setClearConfirmOpen(false);
    }
  };

  const totalToggles = [showDaily, budgetsOn, savingsOn, nfceOn, ofxOn, despensaOn, mensagensOn, wishlistOn].filter(Boolean).length;

  return (
    <Screen title="Ajustes" subtitle="Preferências salvas no banco do aplicativo">
      {/* v69 — PREFERENCIAS: seta ANTES do nome, resumo no cabeçalho.
          v70 (MELHORIA 2.5): "ATALHOS NA TELA INICIAL" no TOPO do grupo —
          é o que forma a seção AÇÕES RÁPIDAS da tela inicial, com sugestão
          clara do que cada atalho faz. */}
      <Group
        icon={ICONS.ajustes}
        title="Preferencias"
        summary={`${totalToggles} de 8 opções ativadas`}
        defaultOpen
      >
        <Text className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Atalhos na tela inicial
        </Text>
        <Text className="text-[11px] text-slate-500 -mt-1">
          Escolha o que aparece na seção AÇÕES RÁPIDAS da tela inicial:
        </Text>
        <ToggleRow
          label="NFC-e"
          description="Ler notas fiscais de consumo pelo QR Code ou link."
          value={nfceOn}
          onChange={setNfceOnPref}
        />
        <ToggleRow
          label="OFX"
          description="Importar o extrato do banco e conciliar por data + valor."
          value={ofxOn}
          onChange={setOfxOnPref}
        />
        <ToggleRow
          label="Despensa"
          description="Estoque de produtos comprados nas NFC-e."
          value={despensaOn}
          onChange={setDespensaOnPref}
        />
        <ToggleRow
          label="Notificações do banco"
          description="Captura as notificações do banco: você decide Lançar ou Excluir."
          value={mensagensOn}
          onChange={setMensagensOnPref}
        />
        {/* v70 (MELHORIA 2.6): texto da Lista de Desejos SUCCINTO */}
        <ToggleRow
          label="Lista de Desejos"
          description="Itens para comprar por Prioridade, Necessário e Desejo."
          value={wishlistOn}
          onChange={setWishlistOnPref}
        />
        <View className="border-t border-dashed border-slate-100" />
        <ToggleRow
          label="Exibir Saldo do dia"
          description="Mostra o saldo acumulado das contas incluídas no fim de cada dia, dentro de cada agrupamento de datas do Fluxo."
          value={showDaily}
          onChange={setShowDailyPref}
        />
        <ToggleRow
          label="Orçamento"
          description="Card de orçamento no Fluxo e ação na tela inicial."
          value={budgetsOn}
          onChange={setBudgetsOnPref}
        />
        <ToggleRow
          label="Poupança"
          description="Card de poupança no Fluxo e ação na tela inicial."
          value={savingsOn}
          onChange={setSavingsOnPref}
        />
        <Text className="text-[11px] text-slate-500">
          As preferências ficam salvas no banco do aplicativo e valem mesmo após fechar o app. Com TODOS os atalhos desligados, a seção AÇÕES RÁPIDAS some da tela inicial.
        </Text>
      </Group>

      {/* v68/v69 — BACKUP: seta antes, resumo com a quantidade de backups.
          v70 (MELHORIA 2.7): lembrete SUCCINTO e claro abaixo do botão. */}
      <Group
        icon={ICONS.arquivar}
        title="Backup"
        summary={backups.length > 0 ? `${backups.length} backup(s) no dispositivo` : 'Nenhum backup ainda'}
      >
        <Button label="Criar Backup agora" onPress={backupNow} />
        <Text className="text-[11px] text-slate-500">
          Copia todos os dados do app para um arquivo seguro que você pode guardar ou levar para outro aparelho.
        </Text>
        <View className="border-t border-dashed border-slate-100" />
        <Button label="Restaurar Dados" variant="danger" onPress={restore} />
        <Text className="text-[11px] text-slate-500">
          A restauração substitui o banco atual: depois de concluir, feche e reabra o app.
        </Text>
        {backups.length > 0 ? (
          <View className="gap-0.5 border-t border-dashed border-slate-100 pt-1.5">
            <Text className="text-sm font-semibold text-slate-800">Backups no dispositivo</Text>
            {backups.map((b) => (
              <KeyValue key={b} k="•" v={b} />
            ))}
          </View>
        ) : null}
      </Group>

      {/* v68/v69 — DADOS: limpeza com confirmação.
          v70 (MELHORIA 2.8): texto em LINGUAGEM DE USUÁRIO, claro e sucinto. */}
      <Group
        icon="🗃️"
        title="Dados"
        summary="Limpar lançamento e movimentações"
      >
        <Button label={`${ICONS.excluir} Limpar lançamento e movimentações`} variant="outline" onPress={() => setClearConfirmOpen(true)} loading={resetting} />
        <Text className="text-[11px] text-slate-500">
          Apaga TODOS os lançamentos e movimentações (inclusive as NFC-e salvas). Cartões, Contas e Categorias continuam guardados. Não dá para desfazer — crie um backup antes.
        </Text>
      </Group>

      {/* v21 (bug 4): confirmação da limpeza total */}
      <ConfirmDialog
        visible={clearConfirmOpen}
        title="Limpar lançamentos e movimentações?"
        message="TUDO será apagado de vez: transações, faturas, pagamentos, parcelas, recorrências, OFX e as NFC-e salvas. Cartões, Contas e Categorias permanecem. Recomendado: crie um backup antes."
        buttons={[
          { label: 'Limpar tudo', color: 'red', onPress: clearMovements },
          { label: 'Cancelar', color: 'green', onPress: () => setClearConfirmOpen(false) },
        ]}
        onClose={() => setClearConfirmOpen(false)}
      />

      {/* v69 — SOBRE: SEMPRE ABERTO, SEM SETA */}
      <AboutBlock>
        <KeyValue k="App" v="MyFinance & Pantry Manager" />
        <KeyValue k="Versão" v={APP_VERSION} bold />
        <KeyValue k="Versão do Schema" v={String(schemaVersion ?? '—')} />
      </AboutBlock>
    </Screen>
  );
}
