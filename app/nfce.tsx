/** Tela NFC-e — scanner QR (expo-camera) e histórico de documentos.
 *  v18 (bug 6): leitura pela URL oficial do QR Code (SEFAZ-SP); estabelecimento
 *  e CNPJ na lista e na revisão.
 *  v19–v38: a página da SEFAZ-SP fica atrás de verificação de navegador
 *  (F5/BIG-IP — desafio JavaScript + cookies TS*); câmera à prova de falhas
 *  (NfceCameraArea, 4 estados de permissão) e caminho manual (NfceManualInput):
 *  colar o link do QR ou a chave de 44 dígitos, com "Colar" e histórico.
 *  v40 (DIAGNÓSTICO TOTAL no terminal do VS Code): cada consulta imprime uma
 *  TRILHA de etapas numeradas com resultado ✓ OK / ⚠ ATENÇÃO / ✗ FALHA, TEMPO
 *  gasto e no fim um VEREDICTO com a causa raiz provável e o próximo passo. A
 *  chave é validada ANTES de falar com o portal (DV módulo 11, UF, modelo 65).
 *  v72 (LEITURA INVISÍVEL): só o MOTOR DO APARELHO lê a nota — WebView oculta
 *  de 1×1 px montada no layout raiz (NfceWebEngineView), SEM navegador visível
 *  e sem fetch. O resultado (registrada / falhou) aparece no RODAPÉ da tela.
 *  A cadeia de fallback (serviço de leitura, fetch Dalvik, navegador interno)
 *  foi REMOVIDA — o teste real do usuário provou que só o motor lê (a 2ª nota
 *  foi recusada pelo firewall e nada mais conseguia). */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Screen, Card, EmptyState, Badge, SectionTitle, QrGlyph } from '../src/components/ui';
import { NfceManualInput } from '../src/components/NfceManualInput';
import { NfceScannerModal } from '../src/components/NfceScannerModal';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { formatBRL } from '../src/lib/money';
import { ymdToBr, spDateOfIso } from '../src/lib/dates';
import { extractAccessKey, checkAccessKey, nfceKeyDescribe } from '../src/parsers/nfce';
import { nfceLog, nfceBegin, nfceStep, nfceVerdict, nfceEnvLine, nfceClip, NFCE_STEP } from '../src/lib/nfcelog';
import { SETTING_KEYS } from '../src/services/SettingsService';

/** v40: versão lida do app.json via expo-constants — igual à do SOBRE. */
const APP_VERSION = Constants.expoConfig?.version ?? undefined;

interface DocRow {
  access_key: string;
  store_name: string | null;
  cnpj: string | null;
  issued_at: string | null;
  amount_paid_cents: number | null;
  parse_status: string;
  needs_review: number;
}

export default function NfceScreen() {
  const services = useDataEffect();
  const bump = useAppStore((s) => s.bump);
  const [docs, setDocs] = React.useState<DocRow[]>([]);
  const [scanning, setScanning] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  /** v87: trava síncrona da leitura (o estado do React chega tarde). */
  const busyRef = React.useRef(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  // v40 — FIM DA DIGITAÇÃO: as 3 últimas entradas (link/chave) ficam salvas no
  // banco; um toque reconsulta sem digitar nada. Botão "Colar" pega o clipboard.
  const [recent, setRecent] = React.useState<string[]>([]);
  const rememberInput = React.useCallback(
    async (value: string) => {
      const v = value.trim();
      if (!v) return;
      const next = [v, ...recent.filter((x) => x !== v)].slice(0, 3);
      setRecent(next);
      try {
        await services.settings.set(SETTING_KEYS.nfceRecentInputs, JSON.stringify(next));
      } catch {
        // histórico é best-effort
      }
    },
    [recent, services]
  );

  const load = React.useCallback(async () => {
    const list = await services.nfce.listDocuments();
    setDocs(list as unknown as DocRow[]);
    try {
      const raw = await services.settings.get(SETTING_KEYS.nfceRecentInputs);
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      setRecent(Array.isArray(arr) ? arr.slice(0, 3) : []);
    } catch {
      setRecent([]);
    }
  }, [services]);

  useDataEffect(load);

  /** Depois do HTML da nota em mãos: processa itens e navega.
   *  v40: itens AGUARDA aqui (HTML já em mãos = parse puro, sem rede) para o
   *  VEREDICTO sair com a trilha completa; e falha aqui nunca mais some —
   *  vira ETAPA 8 ✗ FALHA + VEREDICTO com causa raiz.
   *  v72: a ingestão JÁ foi feita pelo serviço (ingestByDirectFetch) — aqui é
   *  só itens + navegação para a revisão. */
  const finalizeIngest = async (accessKey: string, html: string) => {
    let itemsMsg: string;
    try {
      const proc = await services.nfce.processItems(accessKey, html);
      itemsMsg = `${proc.items} item(ns) · ${proc.appliedToStock} ao estoque · ${proc.needsReview} p/ revisão`;
      bump();
    } catch (err) {
      nfceStep(NFCE_STEP.ITENS, 'fail', `erro no processamento: ${err instanceof Error ? err.message : String(err)}`);
      bump();
      setErrorMessage('A nota foi lida, mas não consegui carregar os itens. Tente novamente.');
      setBusy(false); busyRef.current = false;
      return;
    }
    nfceVerdict(true, `NOTA REGISTRADA — ${itemsMsg}`);
    router.push(`/nfce/${accessKey}`);
    setScanning(false);
    setBusy(false); busyRef.current = false;
    bump();
  };

  /** v72 — LEITURA INVISÍVEL: valida a entrada, confirma a chave e entrega ao
   *  MOTOR DO APARELHO (WebView oculta 1×1). Nada abre na tela: o resultado
   *  sai no rodapé (lendo… / registrada / não conseguiu). Sem internet ou com
   *  o firewall recusando agora, o rodapé mostra a falha — aguarde e tente
   *  de novo (o histórico abaixo repete a nota sem digitar). */
  const ingest = async (input: string, origem = 'câmera (QR Code)') => {
    // v87 (BUG MÉDIA): a trava era o ESTADO do React (setBusy) — o estado só
    // chega na tela DEPOIS do re-render, então duas leituras do mesmo QR em
    // sequência rápida (o leitor repete) entravam dois fluxos ao mesmo tempo.
    // Um ref trava na hora (síncrono), sem depender do re-render.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErrorMessage(null);
    // v40: abre a TRILHA de etapas no terminal do VS Code (etapas + veredicto)
    nfceBegin(origem, nfceEnvLine(APP_VERSION));
    try {
      nfceStep(NFCE_STEP.ENTRADA, 'ok', `origem: ${origem} · conteúdo lido: "${nfceClip(input)}"`);
      const accessKey = extractAccessKey(input);
      if (!accessKey) {
        nfceStep(NFCE_STEP.CHAVE, 'fail', `não achei 44 dígitos no texto "${nfceClip(input, 80)}"`);
        nfceVerdict(false, 'entrada sem chave de 44 dígitos', [
          'o código escaneado não é o QR fiscal da NFC-e (pode ser o código do SAT/cupom fiscal)',
          'o link colado foi truncado no compartilhamento',
        ], 'escaneie o QR Code da NFC-e (o que aponta para nfce.fazenda.sp.gov.br) ou cole o link inteiro');
        setErrorMessage('Não consegui ler o QR Code. Enquadre o código fiscal ou cole a URL completa da nota.');
        setBusy(false); busyRef.current = false;
        return;
      }
      // v40: validação ANTES do portal — dígito errado morre aqui, em ms
      const check = checkAccessKey(accessKey);
      if (!check.ok) {
        nfceStep(NFCE_STEP.CHAVE, 'fail', `chave ${accessKey} — ${check.problems.join(' | ')}`);
        nfceVerdict(false, 'chave de acesso INVÁLIDA — a consulta nem começou', check.problems, 'confira a chave impressa na nota (44 dígitos) ou escaneie o QR Code de novo');
        setErrorMessage(check.problems[0] ?? 'A chave da nota é inválida. Confira o QR Code e tente novamente.');
        setBusy(false); busyRef.current = false;
        return;
      }
      nfceStep(NFCE_STEP.CHAVE, 'ok', `${accessKey} · ${nfceKeyDescribe(check)}`);
      rememberInput(input);
      // v24: "já registrada" só com transação real — documento PENDING/FAILED
      // de tentativa antiga NÃO trava: a nota é buscada e reprocessada.
      const registeredId = await services.nfce.findRegisteredTransactionId(accessKey);
      if (registeredId) {
        nfceVerdict(true, 'nota já registrada com lançamento — abrindo a revisão');
        router.push(`/nfce/${accessKey}`);
        setScanning(false);
        setBusy(false); busyRef.current = false;
        return;
      }
      // v72 — leitura ÚNICA e INVISÍVEL pelo motor do aparelho: sem navegador
      // visível, sem fetch — quem lê é a WebView oculta 1×1 (NfceWebEngineView).
      nfceStep(NFCE_STEP.CANAIS, 'ok', 'leitura pelo MOTOR DO APARELHO (WebView oculta) — canônico .br primeiro');
      const res = await services.nfce.ingestByDirectFetch(input);
      if (!res) {
        nfceVerdict(false, 'o motor do aparelho NÃO conseguiu ler a nota', [
          'firewall da SEFAZ-SP recusou o acesso agora (instável ou bloqueou este IP)',
          'portal fora do ar no momento',
        ], 'aguarde alguns minutos e escaneie de novo (o histórico abaixo repete sem digitar); ou registre a despesa em Novo Lançamento');
        setErrorMessage('Não consegui ler a nota agora. Tente novamente em alguns minutos.');
        setBusy(false); busyRef.current = false;
        return;
      }
      nfceLog('tela: HTML em mãos — processando itens e abrindo a revisão');
      await finalizeIngest(res.accessKey, res.html);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      nfceStep(NFCE_STEP.ENTRADA, 'fail', `erro inesperado na consulta: ${msg}`);
      nfceVerdict(false, `erro inesperado na consulta: ${msg}`, undefined, 'tente de novo; se persistir, envie o log do terminal');
      setErrorMessage(`Não consegui consultar a nota: ${msg}`);
      setBusy(false); busyRef.current = false;
    }
  };

  const onScan = (data: string) => {
    if (!busy) ingest(data);
  };

  return (
    <Screen title="NFC-e">
      <Pressable
        onPress={() => {
          setErrorMessage(null);
          setScanning(true);
        }}
        className="bg-black rounded-xl px-4 py-3 flex-row items-center justify-center gap-2"
      >
          <QrGlyph size={20} />
          <Text className="text-white font-semibold text-base">Escanear QR Code</Text>
      </Pressable>

      {/* v38: plano B SEM câmera — colar link do QR ou chave de 44 dígitos;
          sempre visível, para nunca mais ficar sem caminho para puxar a nota */}
      <Card>
        {/* v40: colar do clipboard + histórico das últimas entradas — fim da digitação */}
        <NfceManualInput
          tone="light"
          busy={busy}
          onSubmit={(v) => ingest(v, 'colado/digitado')}
          recentInputs={recent}
          onUseRecent={(v) => ingest(v, 'histórico')}
        />
      </Card>

      {errorMessage && !scanning ? (
        <Text className="text-sm text-rose-700 bg-rose-50 rounded-xl px-3 py-2">{errorMessage}</Text>
      ) : null}

      <NfceScannerModal
        visible={scanning}
        onClose={() => setScanning(false)}
        onScan={onScan}
        busy={busy}
        errorMessage={errorMessage}
        bottomHint="A leitura abre os itens da nota."
      />

      <SectionTitle>Notas lidas</SectionTitle>
      {docs.length === 0 ? (
        <EmptyState icon="🧾" title="Nenhuma nota" hint="Escanee o QR Code da NFC-e paulista." />
      ) : (
        docs.map((doc) => (
          <Pressable key={doc.access_key} onPress={() => router.push(`/nfce/${doc.access_key}`)}>
            <Card className="!py-3 mb-1">
              <View className="flex-row justify-between items-center">
                <View className="flex-1">
                  <Text className="font-semibold text-slate-900" numberOfLines={1}>
                    {doc.store_name ?? 'Loja não identificada'}
                  </Text>
                  <Text className="text-xs text-slate-500">
                    {doc.issued_at ? ymdToBr(spDateOfIso(doc.issued_at)) : '—'}
                    {doc.amount_paid_cents != null ? ` · ${formatBRL(doc.amount_paid_cents)}` : ''}
                  </Text>
                  {doc.cnpj ? (
                    <Text className="text-[11px] text-slate-400">CNPJ {doc.cnpj}</Text>
                  ) : null}
                </View>
                <View className="gap-1 items-end">
                  <Badge status={doc.parse_status} />
                  {doc.needs_review ? <Badge status="REVIEW" /> : null}
                </View>
              </View>
            </Card>
          </Pressable>
        ))
      )}
    </Screen>
  );
}
