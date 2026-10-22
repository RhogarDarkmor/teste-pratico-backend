# Arquitetura

Como montei o processador e por que. Onde foi interpretação minha eu aviso.

## Visão geral

HTTP e o consumer do SQS chamam os mesmos casos de uso. Tudo que mexe com dinheiro roda numa transação do Postgres, e os eventos vão pro outbox na mesma transação. Depois um publisher manda pra fila.

```
HTTP ──┐
       ├─> casos de uso ──> PostgreSQL (wallets, transações, ledger, outbox, inbox)
SQS  ──┘                              │
                                      ├─> publisher do outbox ──> SQS de eventos
                                      └─> worker de referências pendentes
```

As regras ficam em `src/domain` (Money, Wallet, WagerTransaction), sem banco nem framework. `application` tem os casos de uso e `infra` o resto.

## ORM e persistência

O MikroORM cuida da conexão, das transações e das migrations. Nos repositórios usei SQL parametrizado na mão, porque queria ver exatamente onde entra cada `FOR UPDATE` e `SKIP LOCKED`. Com isso abri mão do Unit of Work, do Identity Map e do `LockMode` do ORM. Pra esse problema achei que valia a troca: as queries que mexem com dinheiro e os locks delas ficam todos à vista.

## Dinheiro

Nada de `number`. Money usa decimal.js com 2 casas e na API vai como string. No Postgres o valor fica em `numeric(20,2)` e a moeda em uma coluna separada. Na leitura o decimal vem com `::text` e vira Money pelo `Money.fromPersisted`. O que chega pela API passa pelo `Money.from`, que é mais rígido.

## Concorrência

Lock pessimista por carteira: a transação começa com `SELECT ... FOR UPDATE` na wallet e quem chega depois espera. Optimistic lock numa hot wallet ia virar um monte de retry, e um update com `balance >= x` não resolve o ledger. Assim as duas apostas de 80 com saldo 100 sempre dão uma ok e uma rejeitada. Deadlock e erro de serialização tem retry.

## Idempotência

Tudo no banco, com unique no id do provedor, na `idempotency_key` e no ledger. Guardo o hash do payload: mesmo hash devolve a resposta original, diferente da 409. Se duas iguais chegam juntas uma toma `23505`, tenta de novo e acha a linha da outra.

## Transições da transação

```
PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais, depois deles a transação não muda mais.

## Reversões

Interpretação minha: uma aposta só pode ser revertida uma vez, por refund ou rollback, senão o dinheiro voltava duas vezes. Tem um indice unico parcial garantindo. Se o estorno chega antes da aposta fica `PENDING_REFERENCE` e um worker tenta de novo com backoff (2s a 30s, até 10 min). Comecei com teto de 5 min mas no teste com 5 instâncias tinha estorno travado, baixei pra 30s.

Por que 10 min: fora de ordem normalmente é questão de segundos (fila, retry do provedor). Se em 10 min a aposta não apareceu, é bem provavel que ela não existe, e o provedor precisa de uma resposta final em vez de ficar esperando pra sempre. Aí vira `REJECTED` com `REFERENCE_NOT_FOUND` e sai o evento de rejeição.

## Mensageria

Na entrada grava no inbox, processa e marca, tudo junto. O ack só sai depois do commit, então se cair a mensagem volta e o inbox segura. Erro permanente vai direto pra DLQ, transitório depois de 5 tentativas.

Uma coisa que deixei de fora: quando a mensagem vai pra DLQ eu não gravo a transação como `FAILED`. Na maioria dos casos o erro acontece antes de existir uma transação válida, ou é justamente o banco que está com problema. Então o `FAILED` existe no domínio mas hoje nenhum fluxo usa.

Na saída o evento vira `OutboxMessage` pelo `enqueue`. Tentativas e backoff ficam na própria mensagem (`scheduleRetry` e `markPublished`), o repositório só salva. O publisher lê com `SKIP LOCKED` e usa o id do evento como dedup no SQS, porque pode publicar duas vezes. A ordem vem de um sequence do Postgres: enquanto um evento da carteira não sai, os seguintes dela esperam, mesmo durante o retry.

## Observabilidade

Log em JSON com correlation id, `/metrics` pro Prometheus (outbox lag vem do banco pra valer pra todas as instâncias), `/health/live` e `/health/ready`. A conciliação compara saldo com a soma do ledger e loga se der diferença.

## Autenticação

Não fiz, não vale ponto e preferi focar no financeiro. Deixei o `ProviderAuthGuard` ligado no endpoint de transações como ponto de extensão, hoje ele deixa tudo passar. Faria com Keycloak via OIDC e um guard checando se o provedor do token é o mesmo da transação.

## Limitações

- Metricas em memoria por instância.
- Conciliação só sob demanda.
- Eventos de carteiras diferentes não têm uma ordem global garantida.
- O horário do ledger e do retry do outbox vem do relógio da instância. Se os relógios estiverem defasados, a listagem do ledger (ordenada por `created_at`) pode mostrar um lançamento fora de ordem e um retry pode sair uns segundos antes ou depois. Saldo, conciliação e ordem dos eventos não mudam. Daria pra resolver com um sequence no ledger, igual fiz no outbox.
- O teste de carga roda local, então mostra o comportamento e não a capacidade real. Os números mudam bastante conforme a máquina e o Docker.

## Como rodar

`bun run infra:up`, `bun run db:migrate` e `bun run test`. O teste mais completo de concorrência é o `test/integration/multi-instance.test.ts`. O de carga é `bun run test:load`, e os resultados estão no `docs/LOAD_TEST.md`.
