# CHANGELOG — MyFinance

Histórico UNIFICADO do projeto (1 arquivo). Os guias antigos de cada versão
(BATERIA-v*, OTIMIZACAO-v*, etc.) foram removidos do projeto — o histórico
completo de cada entrega é ESTE arquivo.

Como rodar o projeto e os testes: `COMECE-AQUI.md` (raiz).

---

## v90 (2026-11-15) - Cascata mês a mês; cartão Poupança enxuto; atalhos/Fluxo separados

### BUGS
- **Programação de Compra: SALDO MÊS A MÊS em cascata.** Antes, a projeção
  repetia a sobra do mês VISTO em todos os meses (capacidade fixa). Agora
  `getProjection(month)` usa o **saldo previsto real do fim de cada mês**
  (via `BalanceService.getDailyBalancesDual(m)` ou `opts.fetcher`) — uma
  sobra grande em dez/2026 é USADA em dez, e o que sobrar dela (carryover)
  segue para jan/2027 em diante. A cascade é sempre respeitada
  `Prioridade → Necessário → Desejo`, e o carryover zera quando o mês está
  na modalidade POUPANÇA "Fechamento do Mês" (o restante vai pra poupança).
- **Reserva de valor atualiza o saldo da Programação.** A reserva é uma
  transferência real (caixinha ou conta poupança) — `dual.previsto` do mês
  da reserva JÁ Sente a saída. A cascade passa a considerar a `falta`
  correta (`target − reserved`) por classe, sem precisar de um sinal
  separado. Antes, o saldo da Programação ficava congelado.
- **Poupança mensal: lança no mês corrente mesmo quando o dia já passou.**
  Antes (v89), se o dia escolhido (ex.: dia 10) já tinha passado em
  nov/2026, o lançamento só aparecia em dez/2026. Agora o lançamento do mês
  corrente SEMPRE nasce (PENDING) — o usuário pode fazer o "a transferir"
  retroativo; das demais semanas em diante segue no dia escolhido.
  Reforço: `generateForecast()` também roda na troca de mês do Fluxo
  (antes só a rotina de arranque garantia — podia aparecer atrasado no
  primeiro render).
- **Cards Orçamento e Poupança escondidos em meses ANTERIORES à criação.**
  Os cards não somem mais em meses passados com "0 orçamento(s) ativo(s)" /
  "N plano(s) cadastrado(s)" — o `createdMonth` (mês de criação do
  orçamento / plano) agora serve de portão: o card só aparece a partir
  desse mês.
- **Linha "Projeção mês a mês (…)" do card da Programação de Compra saiu.**
  Cada mês da projeção já mostra o valor usado (`+X`) — o cabeçalho da
  linha era ruído sem informação nova.

### MELHORIAS
- **Tela Cadastro reordenada**: **Contas › Cartões de Crédito › Categorias ›
  Catálogo de Produtos** (antes vinha Cartões primeiro).
- **Ajustes › Preferencias** dividida em DUAS subseções dentro do mesmo
  grupo: **"Atalhos na tela inicial"** (só OFX, Despensa, Notificações do
  banco) e **"Tela de Fluxo"** (Saldo do dia, Orçamento, Poupança e
  Programação de Compra — o que vira CARD no Fluxo). A mensagem
  "As preferências ficam salvas…" saiu (a explicação longa e desatualizada
  da v68 confundia).
- **Card Poupança enxuto** (Menos é mais: "Quanto menos informação melhor!").
  Por plano: nome + "Guardado X de Y" + barra de progresso em %. Saíram do
  card: linhas "Programado / Falta transferir / Já transferido"
  (repetição do cabeçalho), modalidade ("Mensal todo dia X / Fechamento"),
  e a lista das últimas 5 transferências.
- **Card Poupança ENXUTO cabeçalho**: subtítulo passou de "N plano(s) cadastrado(s)"
  para "Guardado no mês X de Y" (o que importa para acompanhar).

### INFRA
- `WishlistService.getProjection(month, opts)` reescrito: loop mês a mês
  com carryover, dependente do `dataVersion` (recalcula a cada mudança).
  Novo `opts.fetcher(month)` opcional para a tela passar o saldo+resumos
  cacheados por mês. `opts.saldoPrevistoAjustadoFimCents` continua valendo
  como override do PRIMEIRO mês (Fluxo, compat).
- `BudgetService.getMonthSummary` ganhou `createdMonth` (`YYYY-MM`) por
  item do resumo.
- `SavingsService` ganhou `createdMonth` em `SavingsPlanView`; a janela do
  `generateForecast` agora sempre inclui o mês corrente.
- `app/fluxo.tsx`: manutenção do Fluxo agora roda `savings.generateForecast`
  em paralelo (independente das outras rotinas); ordem dos cards no topo
  continua Orçamento → Programação de Compra → Poupança; cards condicionam
  por `showBudgetCard`/`showSavingsCard` (portão pelo mês de criação).
- 18 testes/asserções atualizadas em `orcamentos/wishlist-projecao-mensal.test.ts`
  (cascade real com `fetcher`, carryover, prioridade dinâmica, reserva +
  capacidade), regressão de string do card da Poupança em
  `saldo-fluxo/fluxo-esqueleto-saldo.test.ts` e
  `regressao/bateria-fluxo-ajustes.test.ts`.

---

## v89 (2026-11-15) - Saldo do dia reflete poupança; Poupança e Programação de Compra com cascata
### BUGS
- **Saldo do dia (Efetivado/Previsto)**: a compensação da poupança (v68) que
  *devolvia* o valor transferido ao saldo exibido foi REMOVIDA. Lançar a
  Poupança Mensal com data anterior ao último lançamento agora reflete no
  Saldo do dia corretamente (ele *cai*), e meses subsequentes seguem
  corretos (a compensação não se propagava para sempre).
- **Fechamento do Mês**: o botão "Poupar X (transferência no fim do mês)"
  do card Poupança do Fluxo e do Card da tela Poupança SAÍRAM (a estimativa
  virou ao vivo; o usuário efetiva com uma transferência manual quando
  quiser — avulsas já contam em "Já transferido").
### MELHORIAS
- **Chip "Transferido / Não transferido"** no lançamento da transferência
  do plano (MONTHLY/CLOSING) no Fluxo, no mesmo lugar visual do chip
  Pago/Não pago; alterna PENDING↔CONFIRMED (com `payment_hold`) via novo
  `TransactionService.setTransferStatus` (espelha `setPaymentStatus` v87).
- **Card Poupança expandido**: uma `ProgressBar` por plano cadastrado
  ("Poupança Mensal: programado × guardado" e "Poupança Fechamento: estimativa
  × guardado"). Linhas "Programado / Falta / Já transferido" mantidas.
- **Programação de Compra**: nova projeção MÊS A MÊS (cascata Prioridade →
  Necessário → Desejo) exibida quando o card do Fluxo está expandido, com
  barra de progresso por classe em cada mês. Frases "Para comprar tudo de
  Prioridade…", "Para comprar tudo…" e "Sobra do mês …" SAÍRAM do card do
  Fluxo e da tela — a mesma frase de "Compra tudo em X meses" continua na
  projeção (calculada sob demanda via `WishlistService.getProjection(month)`).
### INFRA
- Novo helper `lib/monthEndBalance.mergeDailyAdjust(base, budAdj)` (só usa
  o ajuste do Orçamento no número exibido).
- Novo método `WishlistService.getProjection(month, opts?)` com cache por
  `dataVersion` aplicado no Fluxo.
- 5 testes novos em `orcamentos/wishlist-projecao-mensal.test.ts`
  (repro do relato + cascata + classes vazias + reserva parcial).

## v88 (2026-11-15) - Fluxo por mês, categorias sob controle, atalhos enxutos

**BUGS**
- **CONSOLIDADO no Fluxo: a data acompanha o mês do filtro** — o card do
  grupo mostrava SEMPRE a data do lançamento original (cabeçalho). Ao passar
  os meses, a data ficava "presa" no dia do lançamento e não batia com o mês
  que o usuário estava olhando. Agora a data é a DO MÊS VISTO: no mês do
  cabeçalho continua sendo a data do lançamento; nos outros meses é a 1ª
  ocorrência/vencimento daquele mês (o card fica sempre dentro do mês).
  A regra ficou em `groupMonthDate` (`src/lib/flowModel.ts`), testável, e o
  card do Fluxo usa a mesma data que posiciona ele na lista.
- **NENHUM texto fora de `<Text>` (qualquer tela)** — o React Native avisa
  no terminal "Text strings must be rendered within a <Text> component."
  quando uma string/número é renderizada fora de `<Text>`. A varredura de
  TODAS as 44 telas (TypeScript E Babel) não achou nenhum caso no app — e
  agora existe um **teste de regressão** que falha se algum aparecer
  (`src/__tests__/regressao/texto-fora-de-text.test.ts`): texto solto,
  string/número como expressão, template sem interpolação e ternário com
  string são detectados em qualquer tela.
- **CATEGORIAS QUE O USUÁRIO NÃO CADASTROU** — o app criava 13 categorias
  padrão (Mercado, Alimentação, Transporte…) sozinho na primeira abertura.
  Agora o app **não cria categoria nenhuma**: quem usa, cadastra (Cadastro ›
  Categorias). Bancos já existentes perdem as categorias do seed antigo
  pela migração v57 — com duas proteções: só sai a categoria **intacta**
  (se o usuário renomeou, fica) e só a que **não está em uso** (movimento,
  conta fixa, catálogo da despensa ou subcategoria) — nenhum dado quebra.

**MELHORIAS**
- **Ajustes › Dados sem o toggle confuso** — "Começar do zero a cada
  abertura" saiu da tela (o usuário não sabia para que servia): os dados
  NUNCA são apagados sozinhos ao abrir o app. Ficou só o botão
  "Começar do zero agora", com confirmação. A preferência
  `zerar_ao_abrir` e a limpeza do arranque foram removidas do código.
- **1ª abertura com TUDO desligado** — os atalhos OFX e Despensa vinham
  LIGADOS por padrão. Agora **nenhum** atalho vem ligado na primeira
  abertura; a escolha continua salva no banco (liga/desliga e fica).
- **Ações rápidas só com 3 opções** — a tela inicial mostra apenas
  **OFX · Despensa · Notificações do banco**. Orçamento, Poupança e
  Programação de Compra saíram da tela inicial e continuam nos cards do
  FLUXO (ligados nos toggles de Ajustes).
- **"Começar do zero agora" não inventa mais categorias** — apaga os dados
  e deixa o banco como o usuário deixou (as categorias que ele cadastrou
  continuam; nenhuma é recriada).

**INFRA**
- Migração **v57** (`v88_remove_categorias_padrao`): limpeza das categorias
  do seed antigo (só as intactas e sem uso).
- Migração v2 (`seed_categories`) deixou de inserir categorias — banco novo
  nasce vazio.
- Novo helper de teste `seedCategory` (`src/__tests__/helpers.ts`) e testes
  novos: data do consolidado por mês (tema `saldo-fluxo`), texto fora de
  `<Text>` e atalhos/dados da tela inicial (tema `regressao`), migração v57
  e seed de categorias (tema `infra`).

---

## v87 (2026-11-15) — Correção geral da auditoria: dados à prova de balas, NFC-e, Fluxo, segurança

**BUGS ALTA**
- **Restauração de backup à prova de balas (UX-safe)**: a versão anterior
  APAGAVA o banco ANTES de validar o arquivo escolhido e não limpava
  `-wal`/`-shm` — um PDF/foto escolhido por engano deixava o app sem banco e
  sem volta. Agora o arquivo é copiado para um temporário, validado
  (SQLite íntegro + tabelas do MyFinance via `expo-sqlite` independente),
  e só então o banco é trocado com um snapshot de segurança do estado
  atual (`pre-restore-<data>.db` em `backups/`). Sem validação, nada muda.
- **Parcela nova de CARTÃO sempre vira item de fatura**: aumentar o
  nº de parcelas de um plano de cartão criava parcelas novas com
  `invoice_id = NULL` que NUNCA eram cobradas (o parcelamento "sumia"
  parcialmente). Agora toda parcela em aberto sem item recebe
  automaticamente o item (e o desconto da nota é respeitado, ver NFC-e).
- **Edição do parcelamento é atômica** (`updatePlanFields`): antes,
  dezenas de escritas (âncora, parcelas, itens, moves, totais) rodavam
  sem transação. Falha no meio → banco alterado pela metade + erro.
  Agora é tudo ou nada (idempotente).
- **Edição do parcelamento preserva o prefill do campo "Total restante"**:
  o prefill era o `plan.total_cents` (TOTAL do plano, incluindo pagas), e o
  "Salvar" redistribuía esse valor entre as parcelas em ABERTO — parcelas
  futuras dobravam. Agora o campo abre com a soma das PENDENTES.
- **Compra no cartão sem compra órfã**: se a fatura recusava o item
  (paga + depois do fechamento, mês inválido) o `onCardPurchase` rodava
  FORA da transação e a compra ficava GRAVADA sem item de fatura. Agora
  o hook é chamado DENTRO da transação — a compra só existe se a fatura
  aceitou.
- **"Não Pago" escolhido pelo usuário NÃO é desfeito sozinho**: a marca
  `payment_hold` (coluna nova, migração v56) é gravada quando o usuário
  marca "Não Pago" e respeitada pelas promoções automáticas do boot.
  Antes, o "Não Pago" era revertido na próxima abertura do app e o saldo
  mudava sozinho.
- **Exclusão de ocorrência de fixa SEMANAL registra exclusão POR DATA**:
  o código só aceitava o formato `REC:{regra}:{AAAA-MM}` (mensal); refis
  semanais com ref `REC:{regra}:D:{AAAA-MM-DD}` caíam fora da regex e a
  ocorrência RECRIAVA no próximo boot. Agora a chave por data é
  `D:AAAA-MM-DD` e uma exclusão semanal só afeta aquela data (as outras
  ocorrências da mesma semana continuam).
- **Editar regra SEMANAL mantém a cadência**: o reposicionamento das
  parcelas PENDING colapsava todas na mesma data (refis semanais viravam
  mensais). Agora a mudança de dia anda a cadência de 7 em 7 dias.
- **Servidor do PC sem porta aberta para o navegador**: o `tools/servidor-nfce.js`
  aceitava QUALQUER requisição, com `Access-Control-Allow-Origin: *` e
  escutando em `0.0.0.0` — qualquer página no navegador do PC (ou peer
  da LAN) podia usar seu IP contra a SEFAZ (queima do portão anti-ban).
  Agora: bind no loopback e nos IPs de LAN (sem VPN/Docker), exige o
  header `X-MyFinance-Nfce: 1`, recusa requisições com `Origin` (navegador),
  exige origem da rede local e token opcional por env. O app envia o
  header em `/health` e `/consultar`. A trava do portão também é marcada
  ANTES da espera (sem duas consultas batendo na SEFAZ).
- **Regex "rs" no parser de notificações**: o padrão `(?:r\$|rs)` casava
  dentro de palavras ("sem juros 12x" virava R$ 12,00) e, quando a
  captura saía suja ("."), a notificação com valor legítimo era DESCARTADA.
  Agora "R$" e "Rs" exigem fronteira de palavra (sem capturar dentro de
  "juros"), e quando a primeira captura falha o parser tenta o fallback
  "valor: X,XX" antes de desistir.
- **Desconto da NFC-e integra o lançamento**: sem "Valor Pago" no
  layout da nota, o lançamento era gravado como `grossTotal` (soma dos
  produtos), ignorando o desconto. Agora: sem "Valor Pago" →
  `grossTotal − discount` (e a tela de revisão mostra `amount_paid_cents`
  com o valor real).

**MÉDIA**
- **MAX → SUM nas faturas do mesmo vencimento**: `BalanceService` usava
  `MAX(0, total - ...)` no GROUP BY do previsto — em SQLite, `max` com
  dois argumentos é função ESCALAR, e com GROUP BY o valor saía de uma
  linha arbitrária. Duas faturas de cartões distintos vencendo no mesmo
  dia faziam o previsto descontar só uma. Agora `SUM(MAX(0, ...))`.
- **Saldo da conta X Efetivado do Fluxo**: o `getAccountBalance` somava
  parcelas PENDING vencidas (o dinheiro não saiu — é previsão); o
  Saldo do dia Efetivado do Fluxo excluía. Resultado: os dois "efetivados"
  para o mesmo dia não batiam. Agora os dois usam a mesma regra.
- **`runDueRecurrences` não gera ocorrência antes de `start_date`**
  (alinhado com a previsão): uma regra criada em 20/01 com dia 5 criava
  uma transação datada 05/01 que entrava retroativamente no saldo.
- **Driver de transação com fila (EXPO + Better)**: duas transações de
  topo simultâneas se misturavam (a segunda virava savepoint dentro da
  primeira e o ROLLBACK da primeira levava junto). Agora transações de
  topo são serializadas; as aninhadas continuam usando savepoint.
- **Abertura do banco cabe no retry**: uma rejeição na abertura deixava a
  promise rejeitada em cache — o app nunca reabria o banco sem reiniciar.
- **NFC-e — idempotência dentro da transação**: o teste "já registrada"
  era feito FORA da transação de inserção, e a segunda de uma leitura
  repetida do mesmo QR estourava o UNIQUE(source_system, external_ref_id)
  com erro cru na tela. Agora o teste é refeito DENTRO da transação.
- **NFC-e — guard do scanner (ref)**: a trava era o ESTADO do React
  (`busy`), que só chega no re-render; duas leituras do mesmo QR em
  sequência rápida entravam dois fluxos. Agora trava via `busyRef`
  síncrono.
- **OFX — encoding Latin-1/CP1252**: "AÇOUGUE" lido como UTF-8 virava
  "A OUGUE" em todo o memo. Agora: lê em UTF-8; se aparecer o caractere
  de substituição (``), relê em base64 e decodifica em Latin-1.
- **OFX — valor "1.234" no padrão oficial**: a heurística antiga
  tratava como milhar BR (R$ 1.234,00); o padrão OFX é ponto decimal
  ("1.234" = R$ 1,23). Agora o ARQUIVO decide: se algum valor usa VÍRGULA
  = milhar BR; senão, ponto decimal OFX.
- **OFX — fitid por conta + linha malformada**: o FITID era único por
  extrato, não globalmente — o mesmo fitid de duas contas distintas
  colidia no UNIQUE(source_system, external_ref_id) e o import INTEIRO
  era revertido. Agora a chave é `${conta}:${fitid}`. Linhas com
  DTPOSTED inválido ou valor zero vão para `errors` (antes revertiam o
  import).
- **Notificação bancária — recusa/fatura/boleto**: "compra recusada"
  viravaExpense sugerida; "sua fatura fecha dia 10" viravaExpense
  fantasma. Agora mensagens SEM movimento real não entram na lista
  (a regra "fatura/boleto SEM palavra de pagamento" cobre os avisos).
- **Notificação bancária — estorno é crédito**: "estorno de compra R$ X"
  virava DEBIT. Agora qualquer palavra de estorno/reembolso/devolução
  vence o débito.
- **Notificação bancária — mês curto (validade "12/26")**: virava data
  da transação ("…-26-12") e sumia da conciliação. Agora só datas com
  mês 1–12 viram data.
- **Poupança: plano desativado sai dos totais**: o "programado/Falta" do
  Fluxo somava entradas de planos inativos (desligar parava de gerar
  entries, mas o saldo antigo continuava contando). Agora o overview e a
  sobra do fechamento só consideram planos ativos.
- **Desejo: reserva atômica**: a transferência + o INSERT na
  `wishlist_reserves` + o `UPDATE wishlist_items.reserved_cents` rodavam
  sem transação — se o app morresse entre a transferência e o INSERT, o
  dinheiro saía e o item não somava. Agora é tudo ou nada.
- **Programa de Compras da wishlist: orçamento E poupança como o Fluxo**:
  a tela chamava `getMethodology(month)` SEM os resumos de orçamento/poupança
  e a "sobra" ignorava o abatimento dos dois. Agora a tela passa os mesmos
  resumos do card do Fluxo.
- **Migração com rollback seguro (`v87 user_version`)**: a migração
  que falhava por "duplicate column"/"already exists" marcava o
  `user_version` mesmo assim (a transação era revertida) → drift de
  esquema permanente e a migração nunca mais rodava. Agora a versão só
  é marcada em uma 2ª tentativa bem-sucedida, e "no such column" deixa
  a migração PENDENTE (sem drift) — o reparo v49 pode corrigir depois.
- **Parcelamento no `updatePlanFields` preserva o passo (semanal /
  bimestral…)** e a edição da data da 1ª parcela em aberto descola
  todas pelas cadência (`step_days` ou `step_months`).
- **Cadência da edição da regra SEM (`updateRule`)**: o reposicionamento
  das parcelas PENDING aplicava o mesmo `dayInMonth` em todas (semanais
  viravam mensais). Agora a mudança de dia aplica o DELTA em dias a
  partir da ocorrência do mês corrente — a cadência de 7 em 7 é
  preservada.

**BAIXA**
- **Consolidado e Fatura do Fluxo expandiam/não expandiam**: a lista
  virtualizada (FlashList, v86) só redesenhava as linhas quando o `data`
  mudava. A expansão é só ESTADO VISUAL — a setinha girava o estado e o
  Consolidado/Fatura não abriam. O usuário reportou, e agora a expansão
  é avisada ao FlashList via `extraData={expansaoTick}`. A expansão
  também não é mais limpa em toda recarga do Fluxo (era de TODAS) — só
  quando o MÊS muda.
- **Transferência com duplo toque**: o `saving` nunca era ligado e a
  trava era o estado do React (chega tarde). Agora trava via ref
  síncrono — toque duplo não cria duas transferências.
- **Soma de inteiros sem estourar**: `sumCents` truncava com `| 0`
  (valores acima de ~R$ 21 mi viravam lixo e os centavos sumiam). Agora
  soma correta com `Math.round`.
- **N+1 nos cartões da tela Início**: `listCardsWithCurrentInvoice`
  fazia 1 consulta por cartão. Agora 2 consultas totais (cartões +
  faturas do mês).
- **Cartão sem FATURA em branco nem itens**: a tela das Contas e
  Cartões usa `Date.now() +1 day` (UTC) e `Date.toISOString()` — perto
  da virada do mês o saldo e o mês corrente saíam errados. Agora usa
  `addDays(todaySP(), 1)` e `monthOf(todaySP())`. "Emissão" da NFC-e
  interpretada como UTC (21h+) virou data do dia seguinte na revisão;
  agora usa `spDateOfIso`.
- **`sumCents` sem mask `| 0`** (acima).
- **`Exportação de compactado** (timestamp do backup não vencia, etc.)
  são preservados na migração v86.
- **Poupança: destino só de conta POUPANÇA**, dia do mês validado
  (1–31, NaN nem vai pro serviço).
- **Despensa: limpar limite mínimo AGORA limpa** (antes era eterno).
- **Despensa: carrinho do `toggleCart` resistia a toques rápidos**
  (closure do estado); agora usa ref.
- **Lista de Desejos: a tela carregava 2x** (origem estava no deps);
  agora atualização funcional.
- **`{ bug crítico }` na tela de fatura com id VAZIO**: se a parcela
  sumiu do banco, a tela abria um plano em branco. Agora: erro + aborta.
- **Categorias: `usageCount` ignorava `budgets` → FK estourava**;
  **categorias: mover uma que TEM FILHAS era permitido** (criava 2 níveis).
- **Try/catch em todos os handlers de mutação** (`doArchive`,
  `toggleInclude`, `toggle`, `ignore`, `Vincular OFX`, etc.) — erros
  viram unhandled rejection e sem feedback; agora mostram toast.
- **Footer com `router.replace`**: trocar de aba não empilha mais
  telas (o "voltar" do Android voltava para a aba anterior).
- **`AutoBackupService` e outros dead code** foram simplesmente NÃO
  tocados (AGENTS.md veda); documentados.
- **`installments.createPlan` agora é uma chamada única** sem
  duplicação por cadência.

**INFRA**
- Migração **v56** `v87_nao_pago_manual` com a coluna `transactions.payment_hold`
  (NOT NULL DEFAULT 0, marcador de "Não Pago" do usuário).
- Driver de transação com FILA para transações de topo (before/savepoints
  aninhadas mantidos).
- `MoneyInput` continua sendo o mesmo (sem alterações); `TextEncoder`
  não adicionado (encoding do OFX é manual em base64 em
  `src/lib/ofxEncoding.ts` — sem nova dependência).
- `@shopify/flash-list` continua o mesmo; o `extraData` é a chave da
  expansão no FlashList.
- Versão **87.0.0** alinhada em `package.json`, `package-lock.json`,
  `app.json`, título do CHANGELOG e do guia.
- 1743 testes passando em 76 suítes (15 v87 novos: backup seguro,
  compra sem órfã, parcelamento + cadência + edição, recorrência semanal,
  "Não Pago" manual, servidor do PC seguro + header, OFX valor+encoding,
  parser de mensagens, despensa+limite, poupança+totais, fatura vazia,
  Fluxo expansão, migração 56).

---

## v86 (2026-11-13) — Desempenho: consultas, índices, listas virtualizadas e fim do apagamento no arranque

**BUGS**
- **Dados apagados a cada abertura (v83)**: o app zerava TODAS as tabelas em
  cada inicialização. Agora os dados **persistem** por padrão; a limpeza virou
  opção em Ajustes › Dados ("Começar do zero a cada abertura", desligada), e
  há o botão **"Começar do zero agora"** — que apaga os dados e recoloca as
  categorias padrão (antes o app abriria sem categoria nenhuma);
- **Previsão das contas fixas**: `runForecast` decidia mês a mês, com uma
  consulta por mês e um BEGIN/COMMIT por ocorrência. Agora calcula os
  candidatos em memória, faz 1 leitura por regra e grava tudo em UMA transação
  por regra — continua idempotente (mesma chave `REC:{regra}:{AAAA-MM}`);
- **Carga em cascata**: cada gravação recarregava TODAS as telas montadas e o
  Fluxo recarregava duas vezes (bump + foco). Agora só a tela em foco carrega,
  uma vez por versão de dados.

**MELHORIAS**
- **Consultas por mês**: `substr(coluna,1,7) = ?` e `LIKE 'AAAA-MM%'` foram
  trocados por faixa (`>= início AND < início do mês seguinte`) em 8 consultas
  (lançamentos, movimentações, faturas, parcelas, orçamento, poupança, saldo do
  dia e fluxo) — o SQLite volta a usar índice em vez de varrer a tabela;
- **N+1 eliminado**: `buildGroupMonths` passou de 5 consultas por grupo para 5
  consultas fixas (distribuição em memória); a fatura do mês carrega os itens
  de todas as faturas numa consulta; `rebuildTotalsMany` recalcula várias
  faturas em uma transação;
- **Telas virtualizadas**: Fluxo e Despensa (estoque) usam `FlashList` — só as
  linhas visíveis são montadas; trocar mês/filtro não remonta a lista inteira;
- **Saldo do dia sob demanda**: só é calculado quando a opção "Exibir saldo por
  dia" está ligada (ou quando a Programação de Compra depende dele);
- **Manutenção 1× por mês**: promoção de vencidas + previsão das fixas não
  rodam mais a cada gravação — só na abertura do mês (ou quando o dia vira);
- **Medição**: linha `[perf] Fluxo · …` no terminal do Metro (só em
  desenvolvimento) mostra o tempo de cada estágio da carga do Fluxo.

**INFRA**
- Migração **v55** `v86_indices_performance` com 7 índices:
  `transactions(occurred_on)`, `transactions(recurrence_rule_id, occurred_on)`,
  `financial_moves(effective_date)`, `invoices(due_date)`, `installments(due_date)`,
  `recurrence_rules(group_transaction_id)` e `installment_plans(group_transaction_id)`;
- Nova dependência `@shopify/flash-list` 1.7.6 (autorizada pelo usuário);
- Novos helpers: `monthRange` (`lib/dates`), `resetUserData` (`db/seed`),
  `SettingsService.zerarAoAbrir` e `src/lib/perf.ts`;
- `Screen` ganhou `body` (corpo virtualizado) e `overlay`;
- Versão **86.0.0** alinhada em `package.json`, `package-lock.json` (2 lugares),
  `app.json`, título do CHANGELOG e título do guia.


## v85 (2026-11-13) — Entrega padronizada · guia sem cedilha

**MELHORIAS**
- **Entrega padronizada**: o zip de cada versão passa a ser salvo em
  `C:\Users\tiago\OneDrive\Desktop\MyFinance - appVersion\` com o nome
  `projeto-vXX.zip` (XX = major da versão; `85.0.0` → `projeto-v85.zip`); os
  zips anteriores são preservados;
- **Guia sem cedilha**: `COMEÇAR-AQUI.md` virou `COMECE-AQUI.md` (título
  `# COMECE AQUI — vX`), evitando problemas de codificação em zip, terminal e
  OneDrive; o conteúdo e a função do guia não mudaram.

**INFRA**
- Versão **85.0.0** alinhada em `package.json`, `package-lock.json` (2 lugares),
  `app.json`, título do CHANGELOG e título do guia;
- `AGENTS.md` §1/§2/§5 atualizados: pasta de destino do zip, nome do guia e
  descrição correta do conteúdo do pacote (projeto completo, não só `app/` e
  `src/`).

## v84 (2026-11-12) — Consolidado editável · saldo no primeiro lançamento · scanner NFC-e

**BUGS**
- **Saldo do Fluxo**: remove a linha sintética do primeiro dia do mês; os saldos
  efetivo e previsto passam a aparecer na primeira data que tem lançamento;
- **Edição de Consolidado**: Alterar abre o formulário com as linhas existentes
  para editar, adicionar e remover; a exclusão do grupo continua apagando a
  operação, e a ação "+Incluir" foi removida;
- **Linhas à vista**: ao mudar débito/crédito, a direção do movimento financeiro
  acompanha o tipo atualizado da transação.

**MELHORIAS**
- **Scanner NFC-e**: câmera em modal imersivo sem a barra superior do sistema,
  com moldura quadrada, autofoco e zoom leve; erros aparecem junto à câmera e,
  quando a leitura funciona, a tela abre diretamente os itens da nota.

**INFRA**
- Testes cobrindo a edição de linhas do Consolidado, o saldo apenas em dias com
  lançamentos reais e o contrato visual do scanner.

## v83 (2026-11-12) — Correções da Poupança, Consolidado e saldo previsto

**BUGS**
- **Excluir plano de Poupança Mensal**: as ocorrências que referenciam as
  transferências são removidas antes das transferências pendentes, evitando
  falha de chave estrangeira;
- **Saldo previsto**: o último dia com atividade é consultado diretamente no
  banco, considerando lançamentos previstos e efetivados sem depender da ordem
  ou da forma como os itens aparecem na tela. A hierarquia Orçamento →
  Programação de Compra → Poupança permanece aplicada no saldo final;
- **Consolidado**: Alterar no cabeçalho abre Novo Lançamento para editar a
  descrição e a data e exibe seus itens sem ações. Itens expandidos no Fluxo
  também ficam somente para visualização.

**MELHORIAS**
- **Inicialização sem dados**: conforme solicitado, todos os dados locais do
  banco são apagados a cada inicialização do app; não são recriadas contas ou
  cartões de demonstração e nem os cadastros feitos em sessões anteriores.

**INFRA**
- Testes cobrindo remoção de plano, limpeza integral mantendo schema, ordem de
  cadastro dos módulos no saldo previsto e itens somente leitura no Consolidado.

## v82 (2026-11-12) — Saldo no último lançamento · início zerado · consultas em lote

**MELHORIAS**
- **Saldo previsto do mês**: a hierarquia Orçamento → Programação de Compras
  → Poupança Mensal → Fechamento é aplicada no último lançamento do mês, sem
  criar uma linha artificial no último dia do calendário. Quando o Fechamento
  rege, a abertura prevista do mês seguinte permanece zerada;
- **Aplicativo começa zerado**: as contas de exemplo não recebem saldos
  iniciais nem transações; dados de instalações existentes não são alterados;
- **Home mais rápida**: saldos das contas são calculados em uma consulta
  agregada, em vez de uma consulta adicional por conta; a Home reutiliza essa
  lista para calcular o saldo geral;
- **Novo Lançamento**: removido apenas o resumo visual do grupo Consolidado;
  cálculos e demais valores da tela permanecem.

**INFRA**
- Testes cobrindo início sem saldos, data do último lançamento e a remoção
  somente do resumo visual do Consolidado.

## v81 (2026-11-12) — Desempenho e robustez

**MELHORIAS**
- **Abertura mais rápida**: o bootstrap libera a UI (tela "Preparando seus
  dados...") JÁ COM o banco pronto (abertura + migrações + seed). As 4
  rotinas pesadas do arranque (recorrências vencidas, previsão das contas
  fixas, promoção de pendências e previsão da poupança) passam a rodar EM
  SEGUIDA, em background, depois da 1ª tela — a abertura não fica mais refém
  delas (eram o grosso do atraso). Continuam idempotentes (ARQ-003) e o Fluxo
  as reforça ao abrir (v50);
- **Falha isolada no arranque**: as 4 rotinas compartilhavam um único
  try/catch — a 1ª que falhasse pulava as demais. Agora vivem em
  `runStartupRoutines` (services/index.ts), cada uma com captura própria: uma
  falha não interrompe as seguintes;
- **Boundary global de erro** (`src/components/ErrorBoundary.tsx`): um erro
  de renderização em qualquer tela não derruba mais o app inteiro — a raiz
  assume com tela de recuperação (marca, mensagem do erro e botão "Tentar de
  novo", que remonta a árvore; o banco local não é afetado). Antes, só a
  câmera NFC-e tinha boundary próprio;
- **_layout.tsx enxuto**: as rotinas do arranque rodavam 2× no boot
  (bootstrap + layout, com guard de data) — agora vivem APENAS no bootstrap.

**INFRA**
- Bateria: novo tema `infra/arranque-robusto.test.ts` (5 testes: ordem do
  boot ready → rotinas; falha isolada em ordem; boundary montado na raiz;
  layout sem repetição das rotinas; componente com captura + "Tentar de
  novo"). Bateria completa: 71 suítes / 1.671 testes.

## v80 (2026-11-12) — Documentação unificada · bateria de testes por tema

**MELHORIAS**
- **Guias unificados**: `COMEÇAR-AQUI.md` é o ÚNICO guia — absorveu
  `INICIO-AQUI.md` (instalar/rodar/erros/versões travadas) e
  `BATERIA-COMO-RODAR.md` (testes), que saem da raiz. Uma fonte de verdade
  só; a contradição "Expo Go × Development Build" virou seção própria com a
  recomendação (Expo Go = espiar; Development Build = testar de verdade — é o
  único jeito de a captura de notificações funcionar);
- **Bateria de testes organizada por TEMA** — fim da organização por versão:
  10 pastas (`infra/`, `saldo-fluxo/`, `lancamentos/`, `cartoes/`, `nfce/`,
  `ofx/`, `orcamentos/`, `despensa/`, `notificacoes/`, `regressao/`) e
  arquivos com nome por ASSUNTO; os 62 arquivos `vNN.test.ts` viraram 70
  arquivos de tema (v24, v54, v69, v70 e v71 foram divididos); TODOS os
  testes continuam rodando: 1.665 antes → 1.666 depois (−2 testes de versão
  com número fixo, +3 do teste relacional). Na raiz ficam só `helpers.ts` e
  `fixtures/`;
- **Teste de versão RELACIONAL** (`src/__tests__/infra/versao.test.ts`):
  confere `package.json` = `package-lock.json` (2 lugares) = `app.json` =
  título do `docs/CHANGELOG.md`, SEM número fixo — nunca mais se edita ao
  subir versão;
- **package.json sem os 11 scripts `test:bateria*`** — `npm test` roda tudo
  (70 suítes, ~16 s) e `npx jest src/__tests__/<tema>` durante o trabalho;
- **AGENTS.md §1/§3/§5 alinhados**: teste de versão relacional (nada a
  editar), regras da bateria por tema (feature/conserto entram no arquivo do
  tema, nunca `vNN`), 3 documentos oficiais (COMEÇAR-AQUI, CHANGELOG,
  AGENTS) + `docs/arquivo/` como acervo.

**INFRA**
- Nada em `src/services`, `src/db`, `src/lib` ou `app/` mudou — a v80 é
  organização de testes e documentação; bateria completa e typecheck verdes;
- Saíram da raiz os 2 guias absorvidos (`INICIO-AQUI.md`,
  `BATERIA-COMO-RODAR.md`) e os scripts órfãos `scripts/run-bateria.bat` /
  `.ps1` (só chamavam os scripts `test:bateria*` removidos — o jeito novo é
  `npm test` ou `npx jest src/__tests__/<tema>`).

---

## v79 (2026-11-12) — Marca "MyFinance" em tudo · versão 79.0.0

**MELHORIAS**
- **O app agora se chama só "MyFinance"** — o nome que aparece no ícone no
  aparelho (`app.json` → `name`), o título da tela inicial, o SOBRE do Ajustes
  e os textos de permissão (notificações do banco e câmera) saíram de
  "MyFinance & Pantry Manager" para "MyFinance";
- **Splash regenerado sem a tagline "& Pantry Manager"**
  (`scripts/gera-splash.py` → `assets/splash.png` + `assets/splash-icon.png`) —
  na arte fica só "MyFinance";
- **Versão 79.0.0** em todos os lugares da regra 1 do AGENTS.md
  (`package.json`, `package-lock.json`, `app.json`, COMEÇAR-AQUI e o teste de
  versão);
- **Pasta do projeto** agora é `myfinance` — o check inicial
  (`tools/check-inicializacao.js`) e o `INICIO-AQUI.md` apontam para a pasta
  nova, inclusive o caso de pasta dobrada `myfinance\myfinance`;
- **Nome do download**: `projeto-v79.zip` — o zip é SEMPRE `projeto-vXX.zip`
  (XX = número da versão atual), com uma única pasta raiz `myfinance/`;
- `slug` e `scheme` viraram `myfinance`. O `android.package`
  (`com.zai.myfinancepantry`) NÃO muda de propósito: é o identificador técnico
  do Android — trocar faria o aparelho instalar um app NOVO ao lado do atual e
  o banco de dados já gravado no aparelho não seria aberto;
- `INICIO-AQUI.md` ficou só com preparação de ambiente e erros comuns — o
  histórico de versões é todo do `docs/CHANGELOG.md` (regra 5 do AGENTS.md);
- **AGENTS.md alinhado ao que existe de verdade**: saíram instruções que
  descreviam coisa inexistente (subpastas de teste por área, `freezeDate()`,
  cobertura mínima no `jest.config.js`, "teste de higiene"); a regra de datas
  em testes agora é a real (datas RELATIVAS com `todaySP()`, corrigido na
  v72); §5 lista TODA a documentação oficial (inclui `COMEÇAR-AQUI.md` e
  `BATERIA-COMO-RODAR.md`) e marca `docs/arquivo/` como acervo.

## v72 (2026-11-12)

**BUGS**
- **1.1 Orçamento pelo MÊS DA COMPRA** (regra do usuário: "o orçamento é
  dentro do mês mesmo que o pagamento seja no próximo"): as PARCELAS — em
  conta e no cartão — passam a somar NO MÊS DA COMPRA (`BudgetService`), o
  plano INTEIRO, pela data da transação-âncora; acabou o gasto "aparecendo
  em jan/2027" pelos vencimentos futuros. A âncora continua fora da soma
  (não conta em dobro);
- **1.2 Saldo desce NA COMPRA e fica descido ATÉ O PAGAMENTO**: compra no
  cartão EFETIVADA também reserva desde a data da compra até a véspera da
  fatura no "Saldo do dia" do Fluxo (antes só a pendente reservava — entre a
  compra e a fatura vencer o saldo fingia que nada tinha sido gasto);
- **1.3 Pai cobre a SUBÁRVORE inteira**: o gasto do item pai do orçamento
  inclui TODAS as subcategorias dele — com ou sem orçamento próprio, em
  qualquer profundidade. Antes, subitens SEM orçamento escapavam da
  composição e o pai mostrava menos do que foi gasto de verdade;
- **1.4 Novo Lançamento: CONSOLIDADO calcula o valor**: o "Resumo do grupo"
  agora mostra o total CALCULADO (−débitos · +créditos) somando TODAS as
  linhas — à vista inteira, fixa mensal e a PARCELA do mês do parcelado
  (Dividir total = 1ª parcela do reparte; Parcela fixa = valor digitado) —
  como os outros tipos mostram o valor deles. O cálculo virou função pura
  (`src/lib/consolidado.ts`) com testes;
- **1.5 Testes com data fixa quebraram com o calendário** (falhavam do dia 11
  em diante): v67 REGRESSÃO (saldo do dia), v21 promoção automática e v70
  conciliação bancária agora usam datas RELATIVAS a hoje / fixam a data da
  notificação — determinísticos em qualquer dia do mês.

**MELHORIAS**
- **2.1 "Lista de Desejos" passou a se chamar "Programação de Compra"**:
  telas (Fluxo, tela inicial, Ajustes, tela da feature), atalho, fechinha da
  reserva e textos — a LÓGICA é a mesma (fila Prioridade › Necessário ›
  Desejo, reservas, metodologia). A caixinha "Reserva · Lista de Desejos" do
  banco é RENOMEADA pela migração v54 para "Reserva · Programação de Compra"
  (mesmo id, saldo e reservas — sem criar conta duplicada);
- **2.2 Despensa ganhou a LISTA DE COMPRA**: aba nova ao lado do Estoque —
  monte o carrinho TOCANDO nos produtos da despensa, ou de uma vez com o
  botão "＋ Abaixo do mínimo" (tudo que está com estoque baixo). O app diz
  DE ONDE comprar mais barato usando as NOTAS LIDAS (`nfce_items`, sem
  tabela nova): preço unitário = valor ÷ quantidade; por loja vale a compra
  mais recente; KG nunca mistura com UN (guarda de dimensão). DUAS VISÕES:
  ① POR CATEGORIA — o menor preço de cada item + loja + data da compra;
  ② POR LOJA — loja ▸ categoria (▸ subcategoria) ▸ preço do item, com o
  TOTAL da lista naquela loja e as lojas ordenadas da mais barata. O
  carrinho fica salvo no banco e sobrevive a fechar o app;
- **2.3 Ajustes › Preferencias sem a opção NFC-e** (e sem o atalho NFC-e na
  tela inicial): a entrada para ler nota ficou ÚNICA — o botão QR dentro do
  Novo Lançamento. O toggle "NFC-e" saiu do grupo (7 opções).

**INFRA**
- **3.1 NFC-e: LEITURA INVISÍVEL, um método só** — o teste real do usuário
  decidiu: 1ª nota leu, 2ª foi recusada pelo firewall e nada mais conseguia.
  Ficou APENAS o MOTOR DO APARELHO (NfceWebEngineView — WebView oculta de
  1×1 px no layout raiz, identidade genuína). Saiu TODA a cadeia de
  fallback: serviço de leitura na nuvem, fetch direto Dalvik e o navegador
  interno VISÍVEL (NfceWebFetch) — nenhuma tela abre durante a leitura; o
  resultado aparece no RODAPÉ da tela NFC-e (⏳ lendo… / ✓ nota registrada /
  ✗ não conseguiu ler) e, no Novo Lançamento, em toast. Reprocessar itens
  usa o motor ou a PÁGINA CAPTURADA da leitura anterior (reserva local, sem
  rede). Arquivos removidos: `NfceWebFetch.tsx`, `NfceSingle.ts`,
  `lib/nfceGate.ts`, `lib/nfceReader.ts` (+ testes da cadeia v32/v33/v34 e
  do portão v40.1; bateria NFC-e reescrita para ingestão direta por HTML);
- **3.2 Migração v54** (renomeia a conta Reserva — ver 2.1);
- **3.3 Guias da raiz restaurados** (tinham sumido do pacote):
  `COMEÇAR-AQUI.md` (reinício do projeto + todos os erros já vistos, com o
  título da versão nova) e `BATERIA-COMO-RODAR.md` (como rodar os testes).

---

## v71 (2026-11-09)

**BUGS**
- **1.1 Notificações do banco — adeus copiar/colar**: o botão "Colar
  Notificação" (e a caixa de colar texto) SAIU da tela "Notificações do banco"
  — com dezenas de notificações acumuladas era inviável. Agora o app CAPTURA
  as notificações do banco direto da barra do aparelho:
  · MÓDULO NATIVO (`modules/bank-notifications`, Expo Modules API +
    NotificationListenerService): o usuário autoriza em "Acesso às
    notificações" (tela do sistema Android, pedida pelo botão "Permitir
    acesso às notificações") e o serviço captura as notificações que JÁ
    ESTÃO na barra (as 09 acumuladas, por exemplo) e as que CHEGAREM
    (tempo real — o grid atualiza sozinho quando o banco manda avisos);
  · GRID com cada notificação do banco (filtro por pacote/nome de app
    bancário + dedupe) e 02 BOTÕES por card: "Lançar" — importa a notificação
    e abre o Novo Lançamento JÁ PREENCHIDO (débito = despesa, crédito =
    receita, valor, data e cartão pelo final quando citado, mesma mecânica
    v70); "Excluir" — tira a mensagem do grid (a notificação segue na barra);
  · a mensagem que já está na lista/foi lançada NÃO repete no grid; nada é
    lançado sozinho; onde o sistema não permite ler notificações de outros
    apps (iOS/web), a tela explica a limitação.

**MELHORIAS**
- **2.1 Tela "Notificações do banco" — texto removido**: saiu o subtítulo
  "Compras sem NFC-e (Shopee, online, assinatura)"; o atalho em Ajustes ›
  Preferências acompanhou ("Captura as notificações do banco: você decide
  Lançar ou Excluir.").

---

## v70 (2026-11-08)

**BUGS**
- **1.1 Lista de Desejos fora dos Orçamentos**: o card da Lista de Desejos SAIU
  de dentro do card de Orçamento e virou BLOCO PRÓPRIO no Fluxo, com a mesma
  visualização de Orçamento/Poupança (fechinha para expandir, classificações
  Prioridade/Necessário/Desejo com itens e barra de progressão).
- **1.2 Fechamento Mensal recalcula na hora** (`SavingsService.recalcClosing`):
  qualquer alteração de data, valor, lançamento ou transferência refaz a
  estimativa confirmada (a transferência pendente acompanha o saldo real; se
  não sobra nada, sai — se sobrar de novo, a sugestão volta).
- **1.3 Saldo do dia Previsto com Fechamento Mensal**: nos meses regidos pelo
  fechamento, o saldo carregado dos meses anteriores foi RETIDO para a
  poupança — o "Saldo do dia Previsto" não começa com ele
  (`BalanceService` passou a devolver a ABERTURA do mês) e o último dia com
  lançamento fecha em R$ 0,00.
- **1.4 Notificação bancária (NÃO SMS)**: parser GENÉRICO para notificações de
  app de banco (exemplos do Inter: "Você acaba de comprar R$ 126,24 em TikTok
  Shop. A compra foi no crédito nacional, com o cartão final 6830." e "você
  acaba de comprar no débito SORVETERIA GYGABOM o valor de R$ 59,47."). Extrai
  valor, local/loja, forma de pagamento (débito/crédito) e final do cartão —
  sem estar preso a banco ou nome de usuário. Tela, tabela e rotinas renomeadas
  para "Notificações do banco"; "Lançar" preenche o Novo Lançamento distinguindo
  débito/crédito e seleciona o cartão pelo final quando cadastrado;
  "Deletar" tira da lista; NUNCA cria lançamento sozinho.
- **1.5 OFX real**: parser robusto para arquivo oficial do banco — MEMO sujo
  (aspas, GUIDs), entidades HTML, mojibake CP1252 ("Ã§" → "ç"), caracteres de
  controle, CRLF/BOM, DTPOSTED com hora/fuso; funciona sem LEDGERBAL/AVAILBAL;
  valor em formato BR negativo ("-1.234,56") corrigido. Amarração por data+valor
  mantida; FITID único; reimportar NÃO duplica NFC-e/notificações — e o lançar
  uma notificação sobre linha NEW_TX do OFX APAGA o lançamento duplicado que o
  próprio OFX tinha criado.

**MELHORIAS**
- **2.1** Ordem no Fluxo: Orçamentos → Lista de Desejos → Poupança.
- **2.2** Splash: app.json com imagem (`assets/splash.png`, marca verde do app)
  e tela de carga com a marca — abertura nunca mais em branco.
- **2.3** Telas de cadastramento próprias: "＋" em Contas e Cartões de Crédito
  abre tela de verdade (`/conta-nova`, `/cartao-novo`); o mesmo padrão em todo o
  app — Categorias (`/categoria-nova`) e alteração de conta fixa
  (`/recorrencia-alterar`) saíram do "formulário embaixo da lista".
- **2.4** "Cartões de Crédito" em todo o app (título, menu do Cadastro, seção
  da tela Início); campos "Dia do fechamento" e "Dia do vencimento"; removido
  o "(1-31)" dos campos de dia (validação 1–31 mantida).
- **2.5** Ajustes › Preferencias: "ATALHOS NA TELA INICIAL" no TOPO, sugerindo
  o que forma a seção AÇÕES RÁPIDAS.
- **2.6** Texto da opção Lista de Desejos reduzido ("Itens para comprar por
  Prioridade, Necessário e Desejo.").
- **2.7** BACKUP: lembrete sucinto abaixo de "Criar Backup agora".
- **2.8** DADOS: texto da limpeza em linguagem de usuário, claro e sucinto.
- **2.9** Cadastro: sem a pergunta "O que você quer cadastrar"; "Catálogo de
  Produtos" com o texto "Produtos importados diretamente das NFC-e".

**LIMPEZA**
- Raiz só com o essencial: os guias por versão (BATERIA-v50/51/52/52-ALL/53/54/
  57/67, OTIMIZACAO-v43/46/47/48/50, GARANTIA-v49, NFCE-v45) foram para
  `docs/arquivo/` e a história consolidada é ESTE arquivo.

## v69 (2026-11-07)

- **Notificações/mensagens bancárias (base do 1.4 da v70)**: área temporária com
  "Lançar" (abre o Novo Lançamento preenchido) e "Deletar"; nunca cria
  lançamento sozinho; conciliação automática com OFX por data + valor; atalho
  na tela inicial via Ajustes.
- **Lista de Desejos**: cadastro (Prioridade*, Descrição*, Valor*, Link),
  classificações Prioridade/Necessário/Desejo, metodologia (Orçamento + Poupança
  Mensal primeiro; sobra concorre Prioridade > Necessário > Desejo; Poupança
  "Fechamento do Mês" por último), barra de progressão, Reservar (caixinha fora
  do saldo geral ou fatia na conta Poupança com fechinha na tela inicial),
  Alterar/Excluir, comprar vira lançamento normal.
- **Fluxo/Poupança**: cabeçalho do card mostra o plano real (fim do "R$ 0,00 /
  Nenhum plano" com plano ativo); "Programado p/ poupança", "Falta transferir"
  e "Já transferido"; "Orçado • Previsto • Gasto" numa linha só com porcentagem
  redonda (`orcadoPrevistoGastoLinha`); com Fechamento do mês, o último dia com
  lançamento fecha em R$ 0,00.
- **Repetir** no Novo Lançamento como cadência (Semanal…Anual) para Fixo e
  Parcelado; **seta antes do rótulo** em Ajustes + SOBRE sempre aberto + layout
  de grupos; **ordem dos botões do consolidado**: +Incluir → Alterar → Excluir.

## v68

- "Repetir" (cadência) nas regras e planos (`step_months`/`step_days`);
  atalhos NFC-e/OFX/Despensa viram toggles em Ajustes (AÇÕES RÁPIDAS some se
  tudo desligado); "Saldo do dia" passa a incorporar Orçamento e Poupança
  (Previsto = base + previsto dos módulos); linha de orçamentos saiu do
  cabeçalho do dia; cabeçalho do dia em linhas empilhadas (v67 BUG 1
  consolidado); nova bateria `v68.test.ts`.

## v67

- Esqueleto ÚNICO de linhas do Fluxo (`LancamentoRow`); cabeçalho do dia em
  linhas separadas; saldo dos cards Orçamento/Poupança nunca desaparece;
  Catálogo de Produtos no menu Cadastro; correções de fatura/próxima fatura em
  aberto; nova bateria `v67-correcoes.test.ts`.

## v60–v66

- v60: preflight de inicialização (`v60-preflight.test.ts` + `COMEÇAR-AQUI.md`
  reescrito); v61: reparo automático do banco (`v61-reparo-banco.test.ts`);
  v62: banco novo/zerar tudo com schema atualizado
  (`v62-banco-novo-zerar.test.ts`); v63–v66: correções de inicialização e do
  Fluxo (saldo do dia instável com alteração de datas — acumulador relê o
  histórico entre âncora e mês visto).

## v57–v59

- v57: produtos (catálogo, EAN, alias, fuzzy só SUGERE, sem unificar sozinho) —
  `v57-produtos.test.ts`; v58: tela de Produtos (`v58-produtos-tela.test.ts`);
  v59: sem EAN, fuzzy só sugere (`v59-sem-ean-fuzzy-sugere.test.ts`).

## v55–v56

- OFX: amarração por data+valor com FITID único (`v55-ofx-amarracao.test.ts`).

## v53–v54

- v53: Despensa, produtos fuzzy, backup com timestamp, dashboard, busca,
  categorias pai/sub e bateria de volume (`BATERIA-v53.md` em docs/arquivo/);
  v54: bancos com logo (catálogo FEBRABAN), contas com bank_code/bank_acct_last4
  e OFX de cartão amarrado por últimos 4 dígitos.

## v49–v52

- v49: GARANTIA DE ATUALIZAÇÃO — editar valor OU data bump() → dataVersion++ →
  recálculo garantido do saldo do dia e dos grupos; v50: bateria completa +
  SQL do saldo sem subquery correlacionada; v51: bateria definitiva (alterações,
  exclusões, cálculos, todas as classes, crédito/débito, NFC-e completa);
  v52: caça-bugs (divideCents negativo, formatCentsInput, datas 31/fev,
  idempotência).

## v43–v48 (performance — sem mudar layout)

- v43: índices SQLite + queries únicas (N+1 → GROUP BY); v45: NFC-e método
  único (navegador interno resolve o desafio do portal); v46: OFX em lote,
  parcelamentos com JOIN, recorrência incremental; v47: PRAGMAs (cache/mmap),
  services lazy, formatBRL cacheado; v48: cache de totais por grupo, useMemo
  na Home, boot sem previsão repetida, remoção de duplicados _1/_2.

## v1–v42

- Base do app: lançamentos (à vista/fixo/parcelado/consolidado), contas e
  cartões com faturas, categorias, Fluxo com saldos do dia, NFC-e com QR e
  importação, OFX batch (v7), Orçamentos e Poupança (v42) — detalhes por versão
  nos guias preservados em `docs/arquivo/`.
