/**
 * ToastHost — renderizador dos avisos não-bloqueantes (v19, "zero popups").
 *
 * Montado UMA VEZ no layout raiz (app/_layout.tsx). Recebe os avisos enviados
 * por showToast() (src/lib/toast.ts) e mostra um pill discreto na parte de
 * baixo da tela, acima do rodapé — some sozinho, sem botão, sem interrupção.
 *
 * Regras do requisito:
 *  · NENHUMA ação pede confirmação: os popups foram removidos de todo o app.
 *  · Este aviso NÃO rouba o foco e NÃO bloqueia o toque na interface.
 *  · Erros de validação/execução também vêm aqui (estilo vermelho), nunca em
 *    Alert.alert.
 */

import React from 'react';
import { Animated, Text, View } from 'react-native';
import { setToastListener, type ToastKind } from '../lib/toast';

interface Item {
  id: number;
  message: string;
  kind: ToastKind;
}

let nextId = 1;

export function ToastHost() {
  const [item, setItem] = React.useState<Item | null>(null);
  const opacity = React.useRef(new Animated.Value(0)).current;
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    setToastListener((message, kind) => {
      const id = nextId++;
      setItem({ id, message, kind });
      if (timer.current) clearTimeout(timer.current);
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 240, useNativeDriver: true }).start(() => {
          setItem((cur) => (cur && cur.id === id ? null : cur));
        });
      }, 3500);
    });
    return () => setToastListener(null);
  }, [opacity]);

  if (!item) return null;
  const isErr = item.kind === 'err';
  return (
    <View pointerEvents="none" className="absolute left-0 right-0 bottom-24 items-center z-50">
      <Animated.View
        style={{ opacity }}
        className={`max-w-[85%] rounded-full px-4 py-2.5 shadow-lg ${isErr ? 'bg-rose-600' : 'bg-slate-900'}`}
      >
        <Text className={`text-xs font-semibold text-center ${isErr ? 'text-white' : 'text-white'}`} numberOfLines={3}>
          {isErr ? `⚠ ${item.message}` : `✓ ${item.message}`}
        </Text>
      </Animated.View>
    </View>
  );
}
