# API HTTP

Todos os valores monetários entram e saem como texto, com a moeda explícita.
O endpoint de transações exige `Idempotency-Key`; a chave é persistida no banco
e uma repetição com o mesmo conteúdo devolve o resultado original.

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
- `400`: corpo, cursor, limite ou chave de idempotência inválidos.
- `404`: carteira ou transação inexistente.
- `409`: carteira duplicada ou conflito de idempotência.
- `422`: transação rejeitada por uma regra de negócio; o corpo inclui
  `failureCode`.
- `503`: dependência temporariamente indisponível; é seguro tentar novamente.

O cursor do ledger é opaco, versionado e carrega a precisão completa do
timestamp usado na ordenação, além do ID como desempate.
