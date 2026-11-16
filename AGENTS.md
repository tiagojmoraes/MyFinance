# MyFinance — diretrizes para a IA

App Expo / React Native (Android) de finanças pessoais, cartões, NFC-e e despensa.
Leia este arquivo antes de qualquer alteração. Responda sempre em português.

## 0. Toda e qualquer alteração ou versionamento no aplicativo deve ter autorização expressar para continuar.
- deve explicar, sucintamente o que vai alterar
- ter cronograma de trabalho com as alterações

## 1. Versionamento (toda entrega sobe a versão)

Formato `X.Y.Z` (ex.: `82.0.0`). Ao entregar, atualize **todos** estes lugares, na mesma versão:

- `package.json` → `version`
- `package-lock.json` → `version` (linha 3) e `packages[""].version` (linha 9)
- `app.json` → `expo.version`
- `docs/CHANGELOG.md` → nova seção `## vX` no topo (BUGS / MELHORIAS / INFRA)
- `COMECE-AQUI.md` → título `# COMECE AQUI — vX`
- Nome e pasta do zip entregue (regra 2):
  `...\MyFinance - appVersion\projeto-vXX.zip`
- O teste de versão (`src/__tests__/infra/versao.test.ts`) é RELACIONAL:
  confere `package.json` = `package-lock.json` = `app.json` = título do
  `docs/CHANGELOG.md` na mesma versão — NÃO se edita ao subir versão. Se ele
  falhar, falta atualizar algum desses arquivos.

Não mexer em `AutoBackupService.ts` (`version: 46`): é o formato do backup, não a versão do app.
Antes de entregar, rode `grep -rn "<versão antiga>"` (sem `node_modules`) para achar o que sobrou.

## 2. Entrega: somente o .zip da última versão

- Entregue **apenas um arquivo**: `projeto-vXX.zip` — `XX` é o NÚMERO MAJOR da
  versão atual (`84.0.0` → `projeto-v84.zip`; `85.0.0` → `projeto-v85.zip`) —,
  salvo em **`C:\Users\tiago\OneDrive\Desktop\MyFinance - appVersion\`**.
- O zip tem uma única pasta raiz `myfinance/` com o projeto completo (código,
  configurações, `assets/`, `docs/`, `modules/`, `plugins/`, `scripts/`,
  `tools/`), exceto os itens da linha abaixo.
- Nunca entregue arquivos soltos, patches ou várias versões. **Não apague nem
  renomeie** os zips anteriores dessa pasta.
- Fora do zip: `node_modules/`, `.expo/`, `.jest-coverage/`, `dist/`, `*.apk`, `*.aab`, `.env*`.
- Rode `npm run typecheck` e `npm test` antes de zipar. Se algo falhar, corrija antes de entregar.
- Na resposta, diga em poucas linhas o que mudou, a versão nova e o caminho
  completo do zip gerado.

## 3. Testes (bateria por TEMA, independente de versão)

- Toda feature nova ou bug corrigido ganha teste, na mesma entrega — e entra
  NO arquivo do tema (ou cria arquivo novo dentro do tema se for área inédita).
  NUNCA crie `vNN.test.ts`; o nome do arquivo descreve o ASSUNTO.
- **Uma única versão de cada teste.** Se o comportamento mudou, edite o teste
  existente. Não crie `*-v2`, `*-novo`, cópias nem arquivos `_1`/`_2`.
  Apague testes obsoletos.
- Pastas: `infra/` (migrações, inicialização, `versao.test.ts`), `saldo-fluxo/`,
  `lancamentos/`, `cartoes/`, `nfce/`, `ofx/`, `orcamentos/`, `despensa/`,
  `notificacoes/`, `regressao/` (baterias transversais). Na raiz ficam só
  `helpers.ts` (`makeCtx`, `seedAccount`, `seedCard`, `getAccountBalance`,
  `expectRejects`) e `fixtures/`. O `jest.config.js` é mínimo (só `testMatch`).
- O `infra/versao.test.ts` é RELACIONAL (package.json = lock = app.json =
  título do CHANGELOG): NÃO se edita ao subir versão.
- Durante o trabalho rode só o tema (`npx jest src/__tests__/<tema>`); a
  bateria completa (`npm test`) só antes de entregar.
- Teste que depende do "hoje" NÃO usa data fixa: cria com datas RELATIVAS
  (`addDays(todaySP(), n)`) ou mês futuro — datas fixas quebraram quando o
  calendário passou (corrigido na v72).
- Jest só cobre serviços e regras de negócio; não afirme que uma tela funciona
  no aparelho sem ter testado.

## 4. Eficiência

- Leia só o que precisa. Use `grep` para localizar antes de abrir arquivos grandes
  (`app/lancamento.tsx`, `app/fluxo.tsx`, `NfceService.ts`, `TransactionService.ts`).
- Faça edições pontuais. Não reescreva arquivo inteiro para mudar poucas linhas.
- Reaproveite serviços, componentes e helpers existentes antes de criar novos.
- Agrupe consultas ao banco em lote; evite consulta dentro de loop. Memoize o que for recalculado.
- Rode primeiro só os testes afetados (`npx jest <caminho>`); a bateria completa só antes de entregar.
- Se houver um jeito mais simples ou rápido de fazer, use e diga em uma frase por quê.
- Não adicione dependência sem perguntar.

## 5. Documentação (só estes arquivos .md são oficiais)

- `COMECE-AQUI.md`: guia ÚNICO para o humano — instalar, rodar, erros e
  soluções, versões travadas, testes; título `# COMECE AQUI — vX`.
- `docs/CHANGELOG.md`: todo o histórico. Não criar guia por versão.
- `AGENTS.md`: este arquivo.
