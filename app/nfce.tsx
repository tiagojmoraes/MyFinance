/** Tela NFC-e — scanner QR (expo-camera) e histórico de documentos.
 *  v18 (bug 6): leitura pela URL oficial do QR Code (SEFAZ-SP); estabelecimento
 *  e CNPJ na lista e na revisão.
 *  v19 (bug NFC-e ponta a ponta): a página da SEFAZ-SP fica atrás de
 *  verificação de navegador (F5/BIG-IP — desafio JavaScript + cookies TS*).
 *  O app agora abre a nota num NAVEGADOR INTERNO (NfceWebFetch), que resolve
 *  o desafio sozinho e devolve o HTML renderizado; o parser extrai
 *  estabelecimento, CNPJ e itens (nome, qtde, un, código).
 *  v21 (melhoria 2): o campo de DIGITAR chave/URL foi REMOVIDO — o fluxo é
 *  só a CÂMERA (QR Code), direto no ponto.
 *  v22: a consulta já foi apresentada em navegador interno; na v73, a
 *  consulta roda sem tela intermediária e falhas são exibidas como mensagem.
 *  v24: "já registrada" só vale para nota com transação real (documentos
 *  PENDING/FAILED antigos são reprocessados); o fallback manual da consulta
 *  foi substituído na v73 por uma mensagem de falha.
 *  v38 (câmera à prova de falhas): a permissão de câmera agora tem 4 estados
 *  (NfceCameraArea) — incluindo "negada em definitivo", que abre os Ajustes
 *  do Android direto na tela do app. E o caminho manual VOLTOU (NfceManualInput):
 *  colar o link do QR ou a chave de 44 dígitos — nunca mais o usuário fica
 *  sem jeito de puxar os dados da nota quando a câmera falha.
 *  v39: o WebView oficial do aparelho executa a consulta com identidade
 *  genuína; na v73 ele opera em segundo plano, sem mudar o preenchimento
 *  automático do formulário após sucesso.
 *  v40 (DIAGNÓSTICO TOTAL no terminal do VS Code): cada consulta imprime uma
 *  TRILHA de 8 etapas numeradas (1/8…8/8) com resultado ✓ OK / ⚠ ATENÇÃO /
 *  ✗ FALHA, TEMPO gasto e no fim um VEREDICTO com a causa raiz provável e o
 *  próximo passo. A chave é validada ANTES de falar com o portal (DV módulo
 *  11, UF, modelo 65) — dígito errado é apontado na hora. E o campo manual
 *  ganhou botão "Colar" + histórico das últimas entradas (fim da digitação). */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import Constants from 'expo-constants';
import { showToast } from '../lib/toast';
import { router } from 'expo-router';
import { Screen, Card, Button, EmptyState, Badge, SectionTitle, QrGlyph } from '../src/components/ui';
import { NfceCameraArea } from '../src/components/NfceCameraArea';
import { NfceManualInput } from '../src/components/NfceManualInput';
import { NfceWebFetch } from '../src/components/NfceWebFetch';
import { useDataEffect } from '../src/components/useDataEffect';
import { useAppStore } from '../src/store/appStore';
import { formatBRL } from '../src/lib/money';
import { ymdToBr, spDateOfIso } from '../src/lib/dates';
import { extractAccessKey, checkAccessKey, nfceKeyDescribe, listConsultUrls } from '../src/parsers/nfce';
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
  // v19: fluxo com NAVEGADOR INTERNO — quando webUrls != null, o componente
  // NfceWebFetch carrega a página oficial e devolve o HTML da nota.
  // v23: LISTA de candidatos — se o firewall recusar um caminho, o próximo
  // canal da SEFAZ abre sozinho.
  const [webUrls, setWebUrls] = React.useState<string[] | null>(null);
  const pendingRef = React.useRef<{ key: string; rawInput: string; url: string } | null>(null);

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

  /** Depois do HTML da nota em mãos: persiste header, processa itens e navega.
   *  v40: itens AGUARDA aqui (HTML já em mãos = parse puro, sem rede) para o
   *  VEREDICTO sair com a trilha completa; e falha aqui nunca mais some —
   *  vira ETAPA 8 ✗ FALHA + VEREDICTO com causa raiz. */
  const finalizeIngest = async (accessKey: string, html: string, sourceUrl: string | null) => {
    try {
      const res = await services.nfce.ingestFromHtml(accessKey, html, sourceUrl);
      let itemsMsg = 'itens não processados';
      try {
        const proc = await services.nfce.processItems(res.accessKey, html);
        itemsMsg = `${proc.items} item(ns) · ${proc.appliedToStock} ao estoque · ${proc.needsReview} p/ revisão`;
        bump();
      } catch (err) {
        // v40: erro no processamento de itens não é mais engolido —
        // aparece na trilha com a mensagem real (causa raiz).
        nfceStep(NFCE_STEP.ITENS, 'fail', `erro no processamento: ${err instanceof Error ? err.message : String(err)}`);
        bump();
      }
      if (res.needsAmount) {
        nfceLog('tela: fim — nota SEM valor legível → abrindo revisão para completar à mão');
        nfceVerdict(false, 'página lida mas SEM valor legível — nenhum lançamento criado', [
          'página capturada estava parcial (faltou o rótulo "Valor a Pagar"/"Valor Total")',
        ], 'na revisão da nota: "Processar itens" ou "Buscar página oficial de novo" re-tentam com a página completa');
        showToast('Nota sem valor legível — nenhum lançamento criado; tente "Processar itens" na revisão', 'err');
      } else if (res.created) {
        nfceLog('tela: fim — lançamento criado → abrindo a revisão da nota');
        nfceVerdict(true, `NOTA REGISTRADA — ${itemsMsg}`);
      } else {
        nfceLog('tela: fim — nota já registrada → abrindo a revisão da nota');
        nfceVerdict(true, `nota já registrada (nada duplicado) — ${itemsMsg}`);
      }
      router.push(`/nfce/${res.accessKey}`);
      setScanning(false);
      setBusy(false);
      bump();
    } catch (err) {
      // v40: falha de persistência aparecia só como toast — agora FECHA A TRILHA
      const msg = err instanceof Error ? err.message : String(err);
      nfceStep(NFCE_STEP.RESULTADO, 'fail', `erro ao registrar a nota: ${msg}`);
      nfceVerdict(false, `erro ao registrar a nota: ${msg}`, [
        'banco do app indisponível — veja se os outros dados do app estão normais',
        'falha inesperada no parser — compartilhe o log (Ajustes > Diagnóstico NFC-e)',
      ], 'tente escanear de novo; se persistir, envie o log do terminal');
      showToast(msg, 'err');
      setBusy(false);
    }
  };

  /** v19: em vez de fetch (bloqueado pelo portal), usa o WebView do aparelho.
   *  v23: sanitiza a URL do QR e monta os CANDIDATOS (QR → portal público) para
   *  fallback automático em caso de rejeição do firewall.
   *  v39: o WebView.loadUrl() é o primeiro caminho e mantém a identidade
   *  genuína do aparelho. Desde a v73, a consulta não abre uma tela própria. */
  const ingest = async (input: string, origem = 'câmera (QR Code)') => {
    setBusy(true);
    // v40: abre a TRILHA de etapas no terminal do VS Code (1/8…8/8 + veredicto)
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
        showToast('Não foi possível extrair a chave de 44 dígitos — escaneie o QR Code da nota ou cole a URL completa da SEFAZ', 'err');
        setBusy(false);
        return;
      }
      // v40: validação ANTES do portal — dígito errado morre aqui, em ms
      const check = checkAccessKey(accessKey);
      if (!check.ok) {
        nfceStep(NFCE_STEP.CHAVE, 'fail', `chave ${accessKey} — ${check.problems.join(' | ')}`);
        nfceVerdict(false, 'chave de acesso INVÁLIDA — a consulta nem começou', check.problems, 'confira a chave impressa na nota (44 dígitos) ou escaneie o QR Code de novo');
        showToast(check.problems[0] ?? 'Chave inválida', 'err');
        setBusy(false);
        return;
      }
      nfceStep(NFCE_STEP.CHAVE, 'ok', `${accessKey} · ${nfceKeyDescribe(check)}`);
      rememberInput(input);
      // v24: "já registrada" só com transação real — documento PENDING/FAILED
      // de tentativa antiga NÃO trava: a nota é buscada e reprocessada.
      const registeredId = await services.nfce.findRegisteredTransactionId(accessKey);
      if (registeredId) {
        showToast('Esta nota já estava registrada');
        nfceVerdict(true, 'nota já registrada com lançamento — abrindo a revisão');
        router.push(`/nfce/${accessKey}`);
        setScanning(false);
        setBusy(false);
        return;
      }
      const candidates = listConsultUrls(input, accessKey);
      nfceStep(NFCE_STEP.CANAIS, 'ok', `${candidates.length} canal(is) na fila — canônico .br sempre 1º`);
      candidates.forEach((u, i) => nfceLog(`  canal ${i + 1}: ${nfceClip(u, 140)}`));
      nfceLog('tela: v40 — as etapas 4/5 (navegador e HTML) continuam no componente de consulta');
      pendingRef.current = { key: accessKey, rawInput: input.trim(), url: candidates[0] };
      setWebUrls(candidates);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      nfceStep(NFCE_STEP.ENTRADA, 'fail', `erro inesperado no início da consulta: ${msg}`);
      nfceVerdict(false, `erro inesperado no início da consulta: ${msg}`, undefined, 'tente de novo; se persistir, envie o log do terminal');
      showToast(msg, 'err');
      setBusy(false);
    }
  };

  const onScan = (data: string) => {
    if (!busy) ingest(data);
  };

  return (
    <Screen title="NFC-e">
      {/* Consulta oficial em segundo plano; exibe uma mensagem apenas em caso de falha. */}
      {webUrls && pendingRef.current ? (
        <NfceWebFetch
          urls={webUrls}
          onHtml={(html) => {
            const pending = pendingRef.current;
            setWebUrls(null);
            if (!pending) return;
            finalizeIngest(pending.key, html, pending.url).catch((err) => {
              showToast(err instanceof Error ? err.message : String(err), 'err');
              setBusy(false);
            });
          }}
          onError={(message) => {
            pendingRef.current = null;
            setWebUrls(null);
            setBusy(false);
            nfceVerdict(false, 'falha na consulta da NFC-e', undefined, message);
            showToast(message, 'err');
          }}
        />
      ) : null}

      {!webUrls && (scanning ? (
        <Card className="overflow-hidden">
          <View className="h-72 rounded-xl overflow-hidden">
            <NfceCameraArea tone="light" busy={busy} onScan={onScan} />
          </View>
          <View className="mt-2">
            <Button label="Fechar câmera" variant="outline" onPress={() => setScanning(false)} />
          </View>
        </Card>
      ) : (
        <Pressable onPress={() => setScanning(true)} className="bg-black rounded-xl px-4 py-3 flex-row items-center justify-center gap-2">
          <QrGlyph size={20} />
          <Text className="text-white font-semibold text-base">Escanear QR Code</Text>
        </Pressable>
      ))}

      {/* v38: plano B SEM câmera — colar link do QR ou chave de 44 dígitos;
          sempre visível, para nunca mais ficar sem caminho para puxar a nota */}
      {!webUrls ? (
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
      ) : null}

      <Card className="gap-2">
        <Text className="text-sm font-semibold text-slate-800">Como funciona</Text>
        <Text className="text-[11px] text-slate-500">
          Aponte a câmera para o QR Code da nota: o app abre a página oficial da SEFAZ-SP pelo link do QR e extrai estabelecimento, CNPJ e os itens (produto, quantidade, unidade e código). Sem internet ou com o portal fora do ar, a nota fica salva para tentar de novo na revisão.
        </Text>
      </Card>

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
