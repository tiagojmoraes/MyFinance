/** Layout raiz — bootstrap do banco, migrações e navegação (expo-router). */

import React from 'react';
import { View, ActivityIndicator, Text } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '../global.css';
import { getServices } from '../src/services';
import { theme } from '../src/theme';
// v19 (zero popups): host único dos avisos não-bloqueantes (substitui Alert.alert)
import { ToastHost } from '../src/components/Toast';
// v35: WebView OCULTA (1×1 px) que executa o 1º degrau da leitura NFC-e com
// o processo real do aparelho — montada no raiz para servir a tela NFC-e E o
// botão QR do Lançamento, em qualquer rota aberta.
import { NfceWebEngineView } from '../src/components/NfceWebEngineView';

export default function RootLayout() {
  const services = getServices();
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    services.ready.then(() => {
      setReady(true);
      // v11 (bug "Fixo/Parcelado somem nos meses seguintes"): propagação
      // IDEMPOTENTE no boot — efetiva pendências vencidas e garante a previsão
      // das contas fixas nos próximos meses (o Fluxo reforça até o mês visto).
      // v48 #3 — boot só promove se mudou o dia (Fluxo já reforça). Antes rodava 2x (boot + Fluxo).
      // Usa o mesmo guard do promoteDuePendings (v47): se já promoveu hoje, Fluxo pula.
      services.recurrences.runDueRecurrences().catch(() => undefined);
      // runForecast só se ainda não rodou hoje — evita 2x no mesmo dia
      if ((globalThis as any).__lastForecastDate !== new Date().toISOString().slice(0,10)) {
        (globalThis as any).__lastForecastDate = new Date().toISOString().slice(0,10);
        services.recurrences.runForecast().catch(() => undefined);
      }
    });
  }, [services]);

  if (!ready) {
    // v70 (MELHORIA 2.2): a abertura NUNCA fica em branco — tela de carga com a
    // marca (o splash nativo já cobre o 1º instante via app.json › splash.image).
    return (
      <View className="flex-1 items-center justify-center gap-5 bg-emerald-800">
        <View className="items-center gap-3">
          <Text className="text-6xl">🪙</Text>
          <Text className="text-3xl font-bold text-white">MyFinance</Text>
        </View>
        <ActivityIndicator size="large" color="#a7f3d0" />
        <Text className="text-sm text-emerald-200">Preparando seus dados...</Text>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: '#f1f5f9' },
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="lancamento" />
          {/* v22 (bug 1): mesma tela de Novo Lançamento, aberta pelo "+Incluir"
              do cabeçalho do consolidado — sobe em MODAL sobre o Fluxo */}
          <Stack.Screen
            name="incluir-grupo"
            options={{ presentation: 'modal', contentStyle: { backgroundColor: '#f1f5f9' } }}
          />
          <Stack.Screen name="transferencia" />
          <Stack.Screen name="contas" />
          {/* v70 (MELHORIA 2.3): telas de CADASTRAMENTO próprias — o "＋" das
              telas Contas e Cartões de Crédito abre tela de verdade (não mais
              formulário embaixo da lista) */}
          <Stack.Screen name="conta-nova" />
          <Stack.Screen name="cartao-novo" />
          <Stack.Screen name="cartoes" />
          <Stack.Screen name="categorias" />
          <Stack.Screen name="cadastro" />
          <Stack.Screen name="parcelamentos" />
          <Stack.Screen name="recorrencias" />
          {/* v70 (MELHORIA 2.3): edição de conta fixa em TELA PRÓPRIA */}
          <Stack.Screen name="recorrencia-alterar" />
          {/* v70 (MELHORIA 2.3): cadastro/edição de categoria em TELA PRÓPRIA */}
          <Stack.Screen name="categoria-nova" />
          <Stack.Screen name="despensa" />
          <Stack.Screen name="nfce" />
          <Stack.Screen name="ofx" />
          <Stack.Screen name="ajustes" />
        </Stack>
        <ToastHost />
        {/* v35: motor do aparelho para a leitura NFC-e — invisível e ocioso
            até o NfceService pedir uma página pela ponte (NfceWebEngine). */}
        <NfceWebEngineView />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
