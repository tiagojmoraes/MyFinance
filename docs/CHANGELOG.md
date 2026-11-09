# CHANGELOG — MyFinance & Pantry Manager

Histórico UNIFICADO do projeto (1 arquivo). Os guias antigos de cada versão
(BATERIA-v*, OTIMIZACAO-v*, etc.) foram movidos para `docs/arquivo/` — continuam
disponíveis, mas fora da raiz.

Como rodar os testes: `npm test` · Instruções iniciais: `COMEÇAR-AQUI.md`.

---

## v74

**INFRA / ORGANIZAÇÃO**
- CI no GitHub Actions executa typecheck e a bateria completa em pushes e PRs.
- `npm test` é o único comando da bateria; documentação de versões permanece
  consolidada neste changelog, com o README raiz reduzido ao essencial.
- Cadastros de contas e cartões permitem selecionar Inter, Itaú ou Caixa;
  contas guardam o código FEBRABAN para conciliação OFX.
- Parser NFC-e ganha contratos explícitos para o layout dos campos da chave.

**BUGS / MELHORIAS**
- Fluxo usa a data representativa do mês ao exibir/editar pagamentos
  consolidados, retorna ao mesmo mês após a edição e remove o rótulo e ícone
  "Consolidado".
- Reservas da Lista de Desejos sincronizam conta, valor e movimentos ao editar
  transferências; excluir devolve o valor reservado. Exclusões de previsões
  mensais de Poupança preservam a exclusão sem recriar a transação.
- A Poupança no Fluxo mostra apenas programado, falta transferir e efetivado;
  o programado mensal usa o saldo efetivado no fim do mês menos o valor
  mensal previsto. Valores pagos/recebidos ficam cinza e a carga inicial usa
  skeleton.
- Novo lançamento inverte a cor do ícone de Transferência quando selecionado.
  Despensa abre o cadastro pelo botão "＋" e oferece Unidade, Gramas e Quilos.
- Contas calculam movimentos em uma consulta agregada e Cartões carregam a
  próxima fatura aberta de todos os cartões em uma consulta em lote.

---

## v73

**MELHORIAS**
- **Desempenho**: telas fora de foco não repetem cargas globais; Fluxo usa
  lista virtualizada, consultas em lote para grupos e atualizações em lote
  para alternar status, preservando as validações e datas dos movimentos.
- **NFC-e**: a consulta oficial continua no WebView do aparelho, mas sem a
  tela intermediária “Consultando a SEFAZ”; em caso de falha, o app exibe
  apenas uma mensagem e, em caso de sucesso, preenche o formulário como antes.

---

## v72

**BUGS**
- **Fluxo — saldo previsto final**: o último saldo do dia desconta o saldo
  restante dos Orçamentos e da Lista de Desejos antes do Fechamento do Mês;
  a estimativa da Poupança considera essas alocações.
- **Novo Lançamento — Consolidado**: o resumo do grupo soma débitos e créditos
  de todas as linhas, incluindo fixas e parceladas.
- **Novo Lançamento — QR Code**: Categoria (opcional) fica oculta durante
  todo o fluxo de leitura da NFC-e.
- **PDR — zerar base**: nova ação em Ajustes › Dados apaga todos os registros
  e preferências, sem recriar cadastros ou dados de demonstração.

**MELHORIAS**
- **Catálogo de Produtos**: cadastro com unidade de medida (Unidade, Quilos
  ou Gramas); unidades desconhecidas recebidas na leitura da NFC-e são
  registradas.
- **NFC-e**: removida a opção de Ajustes e o bypass de certificados TLS não
  confiáveis. Uma resposta explícita de bloqueio da SEFAZ encerra a consulta
  sem repetição ou redirecionamento automático. Removido também o proxy local
  que imitava Chrome/headless e repetia consultas; a tela usa somente o WebView
  oficial do aparelho.
- **Desempenho**: saldos da tela inicial e saldos gerais são consultados em
  agregações SQL, evitando uma consulta por conta.
- **Produção**: instalação nova começa vazia, sem categorias, contas/cartões
  de demonstração ou lançamentos.

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
