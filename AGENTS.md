# MyFinance — instruções para a IA (fonte única)

App Expo / React Native (Android): finanças pessoais, cartões, NFC-e (SP) e despensa. Responda sempre em português, sem preâmbulo, sem repetir conteúdo de arquivo (cite `caminho:linha`).

## 0. Autorização e plano
Qualquer alteração exige autorização expressa. Antes, entregue o plano assim e termine com "Autoriza?":

| arquivo | mudança (1 linha) |
|---|---|

+ cronograma numerado. Só execute o que foi autorizado, um arquivo por vez.

## 1. Entrega (sem pedir confirmação extra após o plano autorizado)
1. Bump `X.0.0` em `package.json`, `package-lock.json` (`version` na linha 3 e em `packages[""]`) e `app.json` (`expo.version`). Não mexer em `AutoBackupService.ts` (`version: 46` é o formato do backup).
2. `npm run typecheck` — falhou, corrija antes. (Testes: o usuário roda à parte.)
3. `git add -A && git commit -m "vXX - <síntese: o que alterou, ajustou, arrumou>"` (XX = major; bug relevante entra em corpo curto).
4. `git tag vN && git push origin main vN` (N = número major da versão, ex.: `v93`; nunca o texto literal `vXX`). Sem `git remote`: pare e peça a URL.
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
- `app/` telas (expo-router) · `src/services/` regras de negócio · `src/repos`, `src/db`, `src/parsers`, `src/store`, `src/components`, `src/lib`.
- `modules/` captura de notificações do banco (nativo; não existe no Expo Go) · `plugins/withWebViewSefazSsl` (SSL da SEFAZ, só em build própria) · `tools/` (`servidor-nfce.js` :3000, `check-inicializacao.js`).
- Arquivos grandes — `grep` antes de abrir: `app/lancamento.tsx` (1966 linhas), `app/fluxo.tsx` (1576), `src/services/TransactionService.ts` (1106), `NfceService.ts` (974).

## 4. Eficiência
- Edição pontual; nunca reescreva arquivo inteiro para poucas linhas.
- Reaproveite serviços/componentes/helpers. Consultas ao banco em lote, nunca dentro de loop; memoize.
- Não adicione dependência sem perguntar. Existindo jeito mais simples, use e diga o porquê em 1 frase.

## 5. Testes
- Não crie, edite, apague nem rode testes (`jest`, `npm test`): o usuário roda à parte.
- Se a mudança tornar um teste obsoleto, cite o arquivo na resposta final (1 linha); não o altere.
- `typecheck` não prova comportamento: não afirme que tela funciona no aparelho.

## 5.1 Versões travadas
`expo 58.0.23` (pin exato: teto do Expo Go 58.0.5 / core `58.0.x`; `expo@58.0.24+` exige core `58.1.0` que só existe em build própria) · `react-native 0.88.1` · `react 19.3.1` · `typescript ~5.9.3` · `jest ^29.7.0` (Jest 30 + TS 6 deu +4.196 erros TS em `test.each`; está em `expo.install.exclude`) · `react-native-gesture-handler ~3.3.0` (3.5 quebra) · `overrides` do `package.json` (reanimated/worklets/RN) sustentam o `npm install`. `query-string` foi removida: não reinstale.