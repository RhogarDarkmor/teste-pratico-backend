# API HTTP

Valor monetário sempre entra e sai como texto, com a moeda junto.
O endpoint de transações exige `Idempotency-Key`. A chave fica salva no banco,
então repetir com o mesmo conteúdo devolve o resultado original.
O valor precisa caber em `numeric(20,2)`, ou seja, no máximo
`999999999999999999.99`. Acima disso volta 400.

## Endpoints

- `POST /wallets` abre uma carteira. O corpo recebe `playerId` e
  `initialBalance: { amount, currency }`.
- `GET /wallets/:walletId` consulta saldo e versão.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50` consulta o ledger em
  ordem estável. O limite aceito vai de 1 a 100.
- `POST /wagering/transactions` recebe os campos da transação e `money:
  { amount, currency }`.
- `GET /wagering/transactions/:transactionId` consulta por ID interno.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
  consulta pela identificação do provedor.
- `POST /wallets/:walletId/reconciliation` compara o saldo armazenado com a
  soma do ledger. Divergências são sinalizadas na resposta e no log; não há
  correção automática.
- `GET /health/live` verifica se o processo está ativo.
- `GET /health/ready` verifica PostgreSQL e a fila SQS configurada.

## Respostas

- `201`: carteira ou transação criada/processada.
- `202`: transação aceita, aguardando uma referência.
- `400`: corpo, cursor, limite ou chave de idempotência inválidos. O corpo
  sempre traz `code` (`INVALID_PAYLOAD`, `IDEMPOTENCY_KEY_REQUIRED` ou o código
  do erro de domínio).
- `404`: carteira ou transação inexistente.
- `409`: carteira duplicada ou conflito de idempotência.
- `422`: transação rejeitada por uma regra de negócio; o corpo inclui
  `failureCode`.
- `503`: dependência temporariamente indisponível; é seguro tentar novamente.

## Códigos de falha

Toda rejeição (`422`) vem com um `failureCode`. A ideia é o provedor saber o que fazer sem ler a mensagem:

| Código | Quando | O que o provedor faz |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desiste |
| `REVERSAL_WOULD_OVERDRAW` | estorno deixaria o saldo negativo | desiste, precisa de análise manual |
| `BALANCE_LIMIT_EXCEEDED` | crédito ultrapassaria o limite de `numeric(20,2)` | corrige o valor ou solicita análise |
| `CURRENCY_MISMATCH` | moeda diferente da carteira | corrige o payload |
| `PLAYER_MISMATCH` | player não é o dono da carteira | corrige o payload |
| `REFERENCE_NOT_FOUND` | a referência não chegou dentro do prazo (10 min) | confere se a aposta original foi enviada |
| `REFERENCE_MISMATCH` | referência de outro provider, player, carteira, moeda ou rodada | corrige o payload |
| `REFERENCE_INVALID_KIND` | tipo de referência não permitido (ex: REFUND de um WIN) | corrige o payload |
| `REFERENCE_NOT_PROCESSED` | a referência foi rejeitada | desiste |
| `REFERENCE_AMOUNT_MISMATCH` | valor diferente da referência | corrige o payload |
| `ALREADY_REVERSED` | a referência já foi estornada | desiste, ja foi feito |
| `INTERNAL_ERROR` | não deveria acontecer | fala com a gente |

Rejeição é resposta final, reenviar a mesma coisa devolve a mesma rejeição (replay).

## Hash do payload

SHA-256 de um JSON canônico (chaves em ordem alfabética, sem espaços) com só os campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` (`null` se não tiver). O valor passa pelo Money antes, então `"25"` e `"25.00"` dão o mesmo hash. O header `Idempotency-Key` e os ids internos não entram. Código em `src/domain/wagering/payload-hash.ts`.

O cursor do ledger é opaco e versionado. Por dentro ele leva o timestamp com
precisão completa e o id pra desempate.
