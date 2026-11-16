# COMECE AQUI — v90

Guia ÚNICO do projeto: instalar, rodar no dia a dia, os erros que já
apareceram (com a solução de cada um), versões travadas e como rodar os
testes. Histórico completo: `docs/CHANGELOG.md`. Regras para a IA:
`AGENTS.md`. Histórico completo: `docs/CHANGELOG.md`.

**Atenção (mudou na v88):**
- **Categorias** — o app não cria nenhuma categoria sozinho. Quem usa,
  cadastra em **Cadastro › Categorias** (inclusive a 1ª vez).
- **Ações rápidas da tela inicial** — só vêm OFX, Despensa e Notificações
  do banco, e **TODOS DESLIGADOS** na primeira abertura. Liga em
  **Ajustes › Preferencias**; a escolha fica salva.
- **Limpar tudo** — em **Ajustes › Dados** ficou só o botão
  "Começar do zero agora" (com confirmação). O toggle "a cada abertura" saiu.
- **Consolidado no Fluxo** — a data do card agora é a do mês visto (não
  mais a data do lançamento que ficava presa ao passar os meses).

## 1. Instalar (1ª vez, só uma vez)

1. O zip da entrega fica em
   `C:\Users\tiago\OneDrive\Desktop\MyFinance - appVersion\projeto-vXX.zip`.
   Descompacte-o **EM FORA do OneDrive** (o OneDrive quebra o `npm install`).
   A pasta de entrega serve só para guardar o zip; não rode o projeto de lá.
   A pasta correta é a de DENTRO — tem que ter `app/` e `src/`
   (ex.: `C:\myfinance\myfinance`).
2. Pausa o OneDrive 2 h (ícone perto do relógio) — senão ele corta o
   install no meio.
3. `npm run check` — confere pasta, dependências e sinais de problema.
4. `npm install` (se o check mandar).
5. Confere a trava: `npm list query-string` (tem que ser 8.x, nunca 9.x).

## 2. Rodar todo dia (2 terminais)

**Terminal 1 — Servidor NFC-e (com Chrome):**

```powershell
npm run dev:servidor
```

Tem que aparecer: `SERVIDOR NFC-e ... 3000`.

**Terminal 2 — Expo:**

```powershell
npm run dev:expo8082
```

Tem que aparecer o QR code limpo.

**NUNCA rode `npm run dev` + os 2 terminais juntos.** É um jeito ou outro.

## 3. Expo Go × Development Build

- **Expo Go (como roda hoje)**: abre na hora e serve para navegar telas e
  regras de negócio. MAS: o módulo nativo de CAPTURA DE NOTIFICAÇÕES DO
  BANCO não existe dentro do Expo Go — a tela "Notificações do banco" explica
  a limitação em vez de falhar. O plugin de SSL da SEFAZ
  (`plugins/withWebViewSefazSsl`) também só é aplicado em build própria.
- **Development Build (recomendado)**: é o SEU app instalado, com TODOS os
  módulos nativos — é o único jeito de a captura de notificações funcionar de
  verdade. Primeira build: `npx expo run:android` (Android Studio + USB) ou um
  perfil development no EAS. Depois disso o dia a dia é IGUAL ao de hoje:
  `npx expo start --dev-client` + escanear — mudança de JS recarrega quente,
  sem rebuild; a build nativa só se refaz quando entra módulo/dependência
  nova (raro).
- **Regra de bolso**: Expo Go = espiar; Development Build = testar de verdade
  (o ganho principal é a captura de notificações do banco).

## 4. Erros que já deram (e a solução)

| O que apareceu | Faz isso |
|---|---|
| `Need to install expo@58` + `npm error canceled` | Pasta errada (sem `package.json`). Rode o `cd` do passo 1 — o `npm run check` avisa. |
| `Invalid regular expression, js engine: hermes` (tela vermelha) | `query-string` v9 instalada. Volte: `npm uninstall query-string` + `npm install query-string@8.1.0`. |
| `Unable to resolve query-string` | O expo-router precisa dele; está travado em `8.1.0`. Mesmo remédio da linha acima. |
| `VirtualizeUtils` / arquivos sumindo, cada vez um diferente | OneDrive cortou o install no meio. Pause o OneDrive e rode `npm run check` + `npm install`. |
| `EADDRINUSE :8081 / :8082` | Outro Metro já está rodando. Feche o terminal antigo (ou `npx kill-port 8081 8082`). |
| `EADDRINUSE :3000` | O servidor NFC-e já está rodando em outro terminal — feche um dos dois. |
| QR "não achei 44 dígitos" | O código escaneado não é o QR fiscal da NFC-e (SAT/cupom) ou o link veio truncado. Use o QR da NFC-e paulista / cole a URL inteira (44 dígitos, validação com DV). |
| `Request Rejected / Your support ID` na NFC-e | Firewall F5 BIG-IP do portal SEFAZ-SP. A leitura é SÓ pelo motor do aparelho (WebView oculta): aguarde alguns minutos e tente de novo — e o Terminal 1 precisa estar aberto. |
| Tela vermelha com outro arquivo faltando | `npm run check`, depois `npm install` com o OneDrive pausado. |

## 5. Versões travadas (não atualiza)

- `expo ~53.0.9` — o upgrade SDK 53→58 foi PERMANENTEMENTE ARQUIVADO (quebrou
  o install); e fora da pasta, `npx expo` tenta baixar o Expo 58.
- `expo-router ~5.1.11` — precisa do `query-string@8.1.0`.
- `query-string 8.1.0` — a v9 quebra o Hermes do RN 0.79.
- `react-native 0.79.6` / `react 19.0.0`.

## 6. Testes (bateria por TEMA)

```bash
npm test                            # tudo: 71 suítes / ~1.688 testes (~50 s)
npx jest src/__tests__/<tema>       # só um tema, durante o trabalho
npx jest -t "MÊS DA COMPRA"         # só os testes casando o nome
```

Temas: `infra/` (migrações, inicialização, versão relacional) ·
`saldo-fluxo/` · `lancamentos/` · `cartoes/` · `nfce/` · `ofx/` ·
`orcamentos/` · `despensa/` · `notificacoes/` · `regressao/` (baterias
transversais). Na raiz ficam só `helpers.ts` e `fixtures/`.

Regras (AGENTS.md §3): feature nova e conserto entram NO arquivo do tema —
nunca `vNN.test.ts` novo; teste que depende do "hoje" usa datas RELATIVAS
(`addDays(todaySP(), n)`); o teste de versão (`infra/versao.test.ts`) é
relacional — não se edita.

## 7. Mapa do projeto

- `app/` — telas (expo-router) · `src/services/` — regras de negócio (testadas)
- `src/db/migrations.ts` — migrações (PRAGMA user_version; esquema 54)
- `docs/CHANGELOG.md` — TODO o histórico · `AGENTS.md` — diretrizes para a IA
