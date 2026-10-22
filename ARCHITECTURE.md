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

Usei MikroORM para configurar o PostgreSQL, controlar transações e rodar migrations. Escolhi SQL parametrizado nos repositórios porque preciso deixar explícitos os `FOR UPDATE`, `SKIP LOCKED`, constraints e consultas de ledger. Assim não uso o Unit of Work, o Identity Map nem o `LockMode` do ORM; em troca, as queries críticas e seus locks ficam visíveis e sob controle.

## Dinheiro

Nada de `number`. Money usa decimal.js com 2 casas e na API vai como string. No Postgres o valor fica em `numeric(20,2)` e a moeda em uma coluna separada. As consultas leem o decimal com `::text` e reidratam o objeto com `Money.fromPersisted`; valores que chegam pela API passam por `Money.from`.

## Concorrência

Lock pessimista por carteira: a transação começa com `SELECT ... FOR UPDATE` na wallet e quem chega depois espera. Optimistic lock numa hot wallet ia virar um monte de retry, e um update com `balance >= x` não resolve o ledger. Assim as duas apostas de 80 com saldo 100 sempre dão uma ok e uma rejeitada. Deadlock e erro de serialização tem retry.

## Idempotência

Tudo no banco, com unique no id do provedor, na `idempotency_key` e no ledger. Guardo o hash do payload: mesmo hash devolve a resposta original, diferente da 409. Se duas iguais chegam juntas uma toma `23505`, tenta de novo e acha a linha da outra.

## Transições da transação

```
PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais: depois deles não há novas transições.

## Reversões

Interpretação minha: uma aposta só pode ser revertida uma vez, por refund ou rollback, senão o dinheiro voltava duas vezes. Tem um indice unico parcial garantindo. Se o estorno chega antes da aposta fica `PENDING_REFERENCE` e um worker tenta de novo com backoff (2s a 30s, até 10 min). Comecei com teto de 5 min mas no teste com 5 instâncias tinha estorno travado, baixei pra 30s.

Por que 10 min: fora de ordem normalmente é questão de segundos (fila, retry do provedor). Se em 10 min a aposta não apareceu, é bem provavel que ela não existe, e o provedor precisa de uma resposta final em vez de ficar esperando pra sempre. Aí vira `REJECTED` com `REFERENCE_NOT_FOUND` e sai o evento de rejeição.

## Mensageria

Na entrada grava no inbox, processa e marca, tudo junto. O ack só sai depois do commit, então se cair a mensagem volta e o inbox segura. Erro permanente vai direto pra DLQ, transitório depois de 5 tentativas.

No fluxo de entrada, uma falha permanente encaminha a mensagem para a DLQ; o consumidor não grava a transação como `FAILED`. A falha pode ocorrer antes de haver uma transação válida para atualizar ou quando não é seguro contar com o banco. Por isso, `FAILED` está definido no domínio, mas fica reservado e não é produzido atualmente pelo fluxo SQS.

Na saída o evento vira `OutboxMessage` com `enqueue`. A mensagem encapsula tentativas, backoff e publicação; o publisher chama `scheduleRetry` ou `markPublished`, e o repositório persiste o novo estado. O publisher lê o outbox com `SKIP LOCKED` e usa o id do evento como dedup no SQS, porque pode publicar duas vezes. Um sequence gerado pelo Postgres ordena os eventos; eventos anteriores da mesma carteira bloqueiam os seguintes até serem publicados, inclusive durante retries.

## Observabilidade

Log em JSON com correlation id, `/metrics` pro Prometheus (outbox lag vem do banco pra valer pra todas as instâncias), `/health/live` e `/health/ready`. A conciliação compara saldo com a soma do ledger e loga se der diferença.

## Autenticação

Não fiz, não vale ponto e preferi focar no financeiro. O `ProviderAuthGuard` está ligado ao endpoint de transações como ponto explícito de extensão; hoje ele permite a chamada sem autenticação. Faria com Keycloak via OIDC e um guard checando se o provedor do token é o mesmo da transação.

## Limitações

- Metricas em memoria por instância.
- Conciliação só sob demanda.
- Eventos de carteiras diferentes não têm uma ordem global garantida.
- O teste de carga local é um cenário reproduzível, não uma medição de capacidade de produção; os resultados dependem da máquina e do Docker.

## Como rodar

`bun run infra:up`, `bun run db:migrate` e `bun run test`. O teste mais completo de concorrência é `test/integration/multi-instance.test.ts`; para a medição de carga, rode `bun run test:load` e consulte `docs/LOAD_TEST.md`.
