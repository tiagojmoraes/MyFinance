/** v81 (ROBUSTEZ): boundary GLOBAL de erro de renderização.
 *  Antes: só a câmera NFC-e tinha boundary próprio (NfceCameraArea) — um erro
 *  de render em qualquer outra tela derrubava o app inteiro. Agora o boundary
 *  montado na RAIZ (app/_layout.tsx) cobre TODAS as telas: assume com uma tela
 *  de recuperação (marca + mensagem + botão "Tentar de novo") em vez de
 *  crashar. O banco local não é afetado — dados nunca se perdem por erro de
 *  render. "Tentar de novo" limpa o erro e remonta a árvore de telas. */

import React from 'react';
import { Pressable, Text, View } from 'react-native';

interface Props {
  children: React.ReactNode;
}

interface State {
  erro: Error | null;
}

export class GlobalErrorBoundary extends React.Component<Props, State> {
  state: State = { erro: null };

  static getDerivedStateFromError(erro: Error): State {
    return { erro };
  }

  componentDidCatch(erro: Error, info: React.ErrorInfo): void {
    // Sem crash reporting no projeto (Expo Go) — log local para diagnóstico.
    console.error('[ErrorBoundary] erro de render capturado:', erro, info.componentStack);
  }

  private tentarDeNovo = (): void => {
    this.setState({ erro: null });
  };

  render(): React.ReactNode {
    const erro = this.state.erro;
    if (!erro) return this.props.children;

    return (
      <View className="flex-1 items-center justify-center gap-4 bg-emerald-800 px-6">
        <Text className="text-3xl font-bold text-white">MyFinance</Text>
        <Text className="text-center text-base text-emerald-100">
          Uma tela não conseguiu abrir. Seus dados estão salvos no banco do
          aparelho — nada foi perdido.
        </Text>
        <Text className="text-center text-xs text-emerald-300" numberOfLines={3}>
          {erro.message || 'Erro desconhecido'}
        </Text>
        <Pressable
          onPress={this.tentarDeNovo}
          className="rounded-xl bg-emerald-600 px-6 py-3 active:bg-emerald-500"
        >
          <Text className="font-bold text-white">Tentar de novo</Text>
        </Pressable>
      </View>
    );
  }
}
