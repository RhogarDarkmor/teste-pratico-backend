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

## Dinheiro

Nada de `number`. Money usa decimal.js com 2 casas, no banco é `numeric(20,2)` e na API vai como string.

## Concorrência

Lock pessimista por carteira: a transação começa com `SELECT ... FOR UPDATE` na wallet e quem chega depois espera. Optimistic lock numa hot wallet ia virar um monte de retry, e um update com `balance >= x` não resolve o ledger. Assim as duas apostas de 80 com saldo 100 sempre dão uma ok e uma rejeitada. Deadlock e erro de serialização tem retry.

## Idempotência

Tudo no banco, com unique no id do provedor, na `idempotency_key` e no ledger. Guardo o hash do payload: mesmo hash devolve a resposta original, diferente da 409. Se duas iguais chegam juntas uma toma `23505`, tenta de novo e acha a linha da outra.

## Reversões

Interpretação minha: uma aposta só pode ser revertida uma vez, por refund ou rollback, senão o dinheiro voltava duas vezes. Tem um indice unico parcial garantindo. Se o estorno chega antes da aposta fica `PENDING_REFERENCE` e um worker tenta de novo com backoff (2s a 30s, até 10 min). Comecei com teto de 5 min mas no teste com 5 instâncias tinha estorno travado, baixei pra 30s.

Por que 10 min: fora de ordem normalmente é questão de segundos (fila, retry do provedor). Se em 10 min a aposta não apareceu, é bem provavel que ela não existe, e o provedor precisa de uma resposta final em vez de ficar esperando pra sempre. Aí vira `REJECTED` com `REFERENCE_NOT_FOUND` e sai o evento de rejeição.

## Mensageria

Na entrada grava no inbox, processa e marca, tudo junto. O ack só sai depois do commit, então se cair a mensagem volta e o inbox segura. Erro permanente vai direto pra DLQ, transitório depois de 5 tentativas.

Na saída o publisher lê o outbox com `SKIP LOCKED` e usa o id do evento como dedup no SQS, porque pode publicar duas vezes. Um sequence gerado pelo Postgres ordena os eventos; eventos anteriores da mesma carteira bloqueiam os seguintes até serem publicados, inclusive durante retries.

## Observabilidade

Log em JSON com correlation id, `/metrics` pro Prometheus (outbox lag vem do banco pra valer pra todas as instâncias), `/health/live` e `/health/ready`. A conciliação compara saldo com a soma do ledger e loga se der diferença.

## Autenticação

Não fiz, não vale ponto e preferi focar no financeiro. O `ProviderAuthGuard` está ligado ao endpoint de transações como ponto explícito de extensão; hoje ele permite a chamada sem autenticação. Faria com Keycloak via OIDC e um guard checando se o provedor do token é o mesmo da transação.

## Limitações

- SQL na mão em vez de entidade, pra ter controle dos locks.
- Metricas em memoria por instância.
- Conciliação só sob demanda.
- Eventos de carteiras diferentes não têm uma ordem global garantida.
- Não fiz teste de carga, só o de 5 instâncias.

## Como rodar

`bun run infra:up`, `bun run db:migrate` e `bun run test`. O teste mais completo é o `test/integration/multi-instance.test.ts`.
