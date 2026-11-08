# v45 — NFC-e MÉTODO ÚNICO

## Antes (lento)
1. fetch direto (Dalvik) -> Request Rejected (sempre)
2. WebView oculta 1x1 -> Request Rejected no Expo Go
3. Navegador interno visível -> Request Rejected + portão 60s
4. Serviço de leitura (reader) -> custo extra
5. Servidor do PC (chrome.exe) -> OK 18.2KB / 13.8s (3x seguidas)

Total: 4 tentativas inúteis + 60s/180s/600s de portão antes de acertar.

## Depois (rápido)
SÓ O #5:
```
Escanear QR -> lerNfceUnico() -> acharServidorPc() -> consultarViaPc() -> HTML -> parser
Se PC OFF -> erro claro "Rode npm run dev" (NÃO tenta WebView/fetch)
Se GATE -> "Aguarde Xs e tente 1x"
```

Arquivo: src/services/NfceSingle.ts -> lerNfceUnico()

## No APK final (sem PC)
Mesmo método, outra execução: WebView do APK com CHROME_UA_APK (não Expo Go).
1 método, 2 execuções. Nada de 5 métodos.

## Como usar
npm run dev  # sobe servidor PC + Expo juntos
# Escaneia -> 13-15s -> nota pronta. Sem portão, sem 5 tentativas.
