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
// v81 (ROBUSTEZ): erro de render em QUALQUER tela não derruba mais o app —
// boundary global montado na raiz, cobre a carga E a árvore de telas.
import { GlobalErrorBoundary } from '../src/components/ErrorBoundary';

export default function RootLayout() {
  const services = getServices();
  const [ready, setReady] = React.useState(false);
  const [bootstrapError, setBootstrapError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // v81 (DESEMPENHO): as rotinas do arranque (recorrências vencidas, previsão
    // das contas fixas, promoção de pendências e previsão da poupança) vivem
    // APENAS no bootstrap dos services (runStartupRoutines — em background,
    // DEPOIS que o ready libera a UI). Aqui era a execução redundante das
    // mesmas rotinas no boot.
    void services.ready.then(() => setReady(true)).catch((err) => {
      setBootstrapError(err instanceof Error ? err.message : String(err));
    });
  }, [services]);

  // v70 (MELHORIA 2.2): a abertura NUNCA fica em branco — tela de carga com a
  // marca (o splash nativo já cobre o 1º instante via app.json › splash.image).
  const carga = (
    <View className="flex-1 items-center justify-center gap-5 bg-emerald-800">
      <View className="items-center gap-3">
        <Text className="text-6xl">🪙</Text>
        <Text className="text-3xl font-bold text-white">MyFinance</Text>
      </View>
      {bootstrapError ? (
        <Text className="text-sm text-rose-100 text-center px-6">
          Não foi possível preparar o banco de dados: {bootstrapError}
        </Text>
      ) : (
        <>
          <ActivityIndicator size="large" color="#a7f3d0" />
          <Text className="text-sm text-emerald-200">Preparando seus dados...</Text>
        </>
      )}
    </View>
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <GlobalErrorBoundary>
        {!ready ? carga : (
          <>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: '#f1f5f9' },
                // v24 (DESEMPENHO): o Stack mantém as telas anteriores montadas;
                // congelar as que estão fora de foco evita re-render por baixo.
                freezeOnBlur: true,
              }}
            >
          <Stack.Screen name="index" />
          <Stack.Screen name="lancamento" />
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
          {/* v104: tela PRÓPRIA para cadastrar produto fora do inline do Estoque (＋ da Despensa). */}
          <Stack.Screen name="produto-novo" />
          {/* v104: lista de compra — tela própria para MONTAR nova lista (＋ da aba Lista de Compra). */}
          <Stack.Screen name="lista-compra-nova" />
          <Stack.Screen name="nfce" />
          <Stack.Screen name="ofx" />
          <Stack.Screen name="ajustes" />
        </Stack>
        <ToastHost />
        {/* v35: motor do aparelho para a leitura NFC-e — invisível e ocioso
            até o NfceService pedir uma página pela ponte (NfceWebEngine). */}
        <NfceWebEngineView />
        </>
        )}
        </GlobalErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
