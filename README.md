# Distributed Wagering Processor

Processador de transações de apostas (BET, WIN, REFUND, ROLLBACK) feito para o desafio de backend da Jungle Gaming. Bun, NestJS, TypeScript, PostgreSQL, MikroORM e SQS (LocalStack), tudo rodando em Docker Compose.

- Enunciado do desafio: [docs/DESAFIO.md](docs/DESAFIO.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)
- Endpoints e respostas: [docs/API.md](docs/API.md)

## O que precisa ter instalado

- [Bun](https://bun.sh) 1.4 ou mais novo
- Docker com Docker Compose

## Subindo tudo

```bash
bun install
cp .env.example .env      # no PowerShell: Copy-Item .env.example .env
bun run infra:up          # Postgres 16 e LocalStack (cria as filas sozinho)
bun run db:migrate        # aplica as migrações
bun run start             # API em http://localhost:3000
```

O `infra:up` espera os dois serviços ficarem saudáveis antes de devolver o terminal. As filas criadas são `wager-transactions.fifo`, a DLQ `wager-transactions-dlq.fifo` e `wager-events.fifo` (eventos de saída).

As variáveis de ambiente ficam em `.env.example`. O Bun lê o `.env` da raiz sozinho, então basta copiar o arquivo.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a API |
| `bun run start:dev` | sobe a API recarregando ao salvar |
| `bun run test` | roda todos os testes |
| `bun run typecheck` | confere os tipos |
| `bun run db:migrate` | aplica as migrações |
| `bun run db:rollback` | desfaz a última migração |
| `bun run db:status` | mostra o estado das migrações |
| `bun run infra:up` / `infra:down` | sobe e derruba o Postgres e o LocalStack |

## Testes

Os testes de integração usam o Postgres e o LocalStack de verdade, então rode `bun run infra:up` antes. Cada suíte cria um banco próprio e o apaga no final.

```bash
bun run test
```

O mais completo é `test/integration/multi-instance.test.ts`: sobe 5 instâncias reais da API, mistura HTTP e SQS, envia tudo duplicado, mata uma instância no meio e no fim confere saldo, ledger, DLQ, outbox e conciliação. Ele leva uns 2 minutos.

## Configuração

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `3000` | porta da API |
| `DATABASE_URL` | Postgres local do compose | conexão com o banco |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | endpoint do LocalStack |
| `AWS_REGION` | `us-east-1` | região |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` | credenciais do LocalStack |
| `SQS_QUEUE_URL` | | fila de entrada. Sem ela o consumer não sobe |
| `SQS_DLQ_URL` | derivada da fila | DLQ |
| `SQS_MAX_ATTEMPTS` | `5` | tentativas antes de ir para a DLQ |
| `OUTBOX_QUEUE_URL` | | fila de eventos. Sem ela o publisher não sobe |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_POLL_INTERVAL_MS` | `20` / `500` | lote e intervalo do publisher |
| `PENDING_REFERENCE_TTL_MS` | `600000` | quanto tempo um estorno espera a aposta (10 min) |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `40` | máximo de tentativas do worker |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `2000` | intervalo do worker |

Para desligar um componente numa instância: `SQS_CONSUMER_ENABLED=false`, `OUTBOX_PUBLISHER_ENABLED=false` ou `PENDING_REFERENCE_WORKER_ENABLED=false`.

## Testando na mão

```bash
# abre uma carteira com 100.00 BRL
curl -X POST localhost:3000/wallets -H "Content-Type: application/json" \
  -d '{"playerId":"jogador-1","currency":"BRL","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

A resposta traz o `id` da carteira, que vai no `walletId` das transações enviadas para `POST /wagering/transactions`. Esse endpoint exige o header `Idempotency-Key`: repetir a mesma chamada com a mesma chave devolve o resultado original sem cobrar duas vezes. O corpo completo e todas as respostas estão em [docs/API.md](docs/API.md).

Outros endpoints úteis:

- `GET /health/live` e `GET /health/ready`
- `GET /metrics` (formato Prometheus)
- `POST /wallets/:id/reconciliation` compara o saldo com a soma do ledger

## Estrutura

```
src/domain         regras de negócio (Money, Wallet, transações), sem banco nem framework
src/application    casos de uso
src/infra          Postgres, SQS, outbox, worker de pendentes, retry
src/http           controllers e filtro de erros
src/observability  logs em JSON, métricas e correlation id
test/              unitários e de integração
docs/              enunciado e documentação da API
```
