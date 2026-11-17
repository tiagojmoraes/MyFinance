# MyFinance — instruções para a IA (fonte única)

App Expo / React Native (Android): finanças pessoais, cartões, NFC-e (SP) e despensa. Responda sempre em português, sem preâmbulo, sem repetir conteúdo de arquivo (cite `caminho:linha`).

## 0. Autorização e plano
Qualquer alteração exige autorização expressa. Antes, entregue o plano assim e termine com "Autoriza?":

| arquivo | mudança (1 linha) | teste |
|---|---|---|

+ cronograma numerado. Só execute o que foi autorizado, um arquivo por vez.

## 1. Entrega (sem pedir confirmação extra após o plano autorizado)
1. Bump `X.0.0` em `package.json`, `package-lock.json` (`version` na linha 3 e em `packages[""]`) e `app.json` (`expo.version`). Não mexer em `AutoBackupService.ts` (`version: 46` é o formato do backup).
2. `npm run typecheck && npm test` — falhou, corrija antes.
3. `git add -A && git commit -m "vXX - <síntese: o que alterou, ajustou, arrumou>"` (XX = major; bug relevante entra em corpo curto).
4. `git tag vN && git push origin master vN` (N = número major da versão, ex.: `v93`; nunca o texto literal `vXX`). Sem `git remote`: pare e peça a URL.
5. Resposta final: só a mensagem do commit + hash.

Fora do git: `.gitignore` (`node_modules/`, `.expo/`, `.jest-coverage/`, `dist/`, `*.apk`, `*.aab`, `.env*`).

## 2. Produto e invariantes
- Dinheiro em **centavos** (`*_cents`). Datas via `todaySP()`.
- Banco: `src/db/migrations.ts` (`PRAGMA user_version`, esquema 54). Mudança de schema só por migração nova.
- Categorias: o app não cria nenhuma; o usuário cadastra em Cadastro › Categorias.
- Ações rápidas da Home (OFX, Despensa, Notificações do banco): vêm TODAS DESLIGADAS; liga em Ajustes › Preferencias (fica salvo).
- Limpar tudo: só o botão "Começar do zero agora" (com confirmação) em Ajustes › Dados.
- Consolidado no Fluxo: a data do card é a do mês visto.
- Compra no crédito entra na fatura pelo fechamento; orçamento consome pela data da compra.

## 3. Mapa
- `app/` telas (expo-router) · `src/services/` regras de negócio (testadas) · `src/repos`, `src/db`, `src/parsers`, `src/store`, `src/components`, `src/lib`.
- `modules/` captura de notificações do banco (nativo; não existe no Expo Go) · `plugins/withWebViewSefazSsl` (SSL da SEFAZ, só em build própria) · `tools/` (`servidor-nfce.js` :3000, `check-inicializacao.js`).
- Arquivos grandes — `grep` antes de abrir: `app/lancamento.tsx` (1966 linhas), `app/fluxo.tsx` (1576), `src/services/TransactionService.ts` (1106), `NfceService.ts` (974).

## 4. Eficiência
- Edição pontual; nunca reescreva arquivo inteiro para poucas linhas.
- Reaproveite serviços/componentes/helpers. Consultas ao banco em lote, nunca dentro de loop; memoize.
- Não adicione dependência sem perguntar. Existindo jeito mais simples, use e diga o porquê em 1 frase.

## 5. Testes (por TEMA)
- Pastas em `src/__tests__/`: `infra/`, `saldo-fluxo/`, `lancamentos/`, `cartoes/`, `nfce/`, `ofx/`, `orcamentos/`, `despensa/`, `notificacoes/`, `regressao/`. Na raiz só `helpers.ts` (`makeCtx`, `seedAccount`, `seedCard`, `getAccountBalance`, `expectRejects`) e `fixtures/`.
- Feature/bug novo ganha teste no arquivo do TEMA. Nunca `vNN.test.ts`, `*-v2`, cópias ou `_1/_2`; comportamento mudou → edite o teste existente e apague os obsoletos.
- Teste que depende de "hoje" usa datas relativas (`addDays(todaySP(), n)`).
- `infra/versao.test.ts` é relacional (package.json = lock = app.json): não se edita ao subir versão.
- Durante o trabalho: `npx jest src/__tests__/<tema>` ou `npx jest -t "<nome>"`. `npm test` completo só antes de entregar.
- Jest cobre só serviços/regras: não afirme que tela funciona no aparelho sem teste.

## 5.1 Versões travadas
`expo ~58.0.13` · `react-native 0.88.1` · `react 19.3.1` · `typescript ~5.9.3` · `jest ^29.7.0` (Jest 30 + TS 6 deu +4.196 erros TS em `test.each`; está em `expo.install.exclude`) · `react-native-gesture-handler ~3.3.0` (3.5 quebra) · `overrides` do `package.json` (reanimated/worklets/RN) sustentam o `npm install`. `query-string` foi removida: não reinstale.

## 6. Comandos
- Dia a dia, 2 terminais: `npm run dev:servidor` (deve mostrar `SERVIDOR NFC-e ... 3000`) e `npm run dev:expo8082`. NUNCA `npm run dev` junto com eles.
- Projeto fora do OneDrive (ele corta o `npm install`). Antes: `npm run check`, depois `npm install` se mandar.
- Expo Go só navega telas/regras; Development Build (`npx expo run:android`, depois `npx expo start --dev-client`) é necessária para notificações do banco. Build nativa só refaz quando entra módulo/dependência nova.

## 7. Erros conhecidos
| Sintoma | Solução |
|---|---|
| `Need to install expo@58` + `npm error canceled` | Pasta errada (sem `package.json`); `cd` para a pasta do projeto. |
| `VirtualizeUtils` / arquivo sumindo, cada vez um | OneDrive cortou o install: pausar, `npm run check` + `npm install`. |
| `EADDRINUSE :8081/:8082` | Outro Metro ativo: fechar ou `npx kill-port 8081 8082`. |
| `EADDRINUSE :3000` | Servidor NFC-e já rodando em outro terminal. |
| `RNGestureHandlerModule.getModuleId is not a function` | gesture-handler fora de `~3.3.0`: `npm install`; reconstruir (`npx expo run:android`) e `npx expo start --clear`. |
| QR "não achei 44 dígitos" | Não é o QR fiscal da NFC-e ou o link truncou: usar QR da NFC-e paulista / colar a URL inteira. |
| `Request Rejected / Your support ID` | Firewall F5 da SEFAZ-SP: esperar alguns minutos; leitura só pela WebView oculta; Terminal 1 aberto. |
