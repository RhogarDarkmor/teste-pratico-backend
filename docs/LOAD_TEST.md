# Teste de carga

O teste roda com `bun run test:load`. Antes, suba PostgreSQL e LocalStack com
`bun run infra:up`. O script cria um banco de teste e filas SQS temporários,
sobe três processos reais da API e remove os recursos temporários ao terminar.
Ele não usa o banco de desenvolvimento nem as filas habituais do projeto.

Por padrão, envia 300 requisições HTTP concorrentes (até 24 ao mesmo tempo)
para uma única carteira. Cada requisição é uma aposta `BET` de `0.01 BRL`, com
uma chave de idempotência diferente. O saldo inicial cobre todas as apostas.
O publisher do outbox fica ativo e envia eventos para uma fila FIFO exclusiva
do teste; o consumidor de entrada SQS e o worker de referências ficam desligados,
pois a carga medida é a entrada HTTP.

O throughput e as latências são medidos durante o envio das requisições; p50,
p95 e p99 usam a latência de cada resposta HTTP. A taxa de erro técnico conta
falhas de transporte e respostas HTTP 5xx; respostas fora do status esperado
também aparecem separadas. Conflitos de lock são a diferença do contador da
aplicação entre o início e o fim da execução, somada entre as três instâncias.
O lag máximo é o maior valor amostrado logo após a carga e enquanto o outbox
drena; o lag final precisa chegar a zero. O script também confere saldo, soma do
ledger e quantidade de transações e lançamentos.

## Última execução registrada

Executada em 22/10/2026, usando o padrão de 300 requisições e concorrência 24:

| Medida | Resultado |
|---|---:|
| Ambiente | Windows 11 Home Single Language, x64, 4 CPUs, 5.9 GiB de memória |
| Runtime | Bun 1.4.3 |
| PostgreSQL | 16.15 |
| Instâncias da API | 3 |
| Duração das requisições | 22.31 s |
| Throughput | 13.45 requisições/s |
| Latência p50 | 1337.08 ms |
| Latência p95 | 6494.38 ms |
| Latência p99 | 8599.29 ms |
| Erros técnicos | 0 (0%) |
| Status HTTP inesperados | 0; 300 respostas `201`; 0 falhas de transporte |
| Conflitos de lock | 0 |
| Maior lag amostrado do outbox | 9.94 s |
| Lag final do outbox | 0 s |
| Saldo da carteira / saldo reconstituído do ledger | `1.00 BRL` / `1.00 BRL` |
| Lançamentos no ledger | 301, incluindo a abertura da carteira |

Uma primeira execução no mesmo ambiente e com os mesmos parâmetros mediu
23.10 requisições/s (p50 1019.54 ms, p95 2061.65 ms, p99 2541.42 ms) e lag
máximo amostrado de 19.87 s. A variação entre execuções está registrada; não
trato uma única medição como capacidade garantida.

Este é um resultado de uma execução local, com uma carteira quente e serviços
em containers na mesma máquina. Serve para documentar a metodologia e o
comportamento observado; não representa capacidade de produção nem uma meta de
desempenho.

Todas as apostas disputam a mesma carteira. O `SELECT ... FOR UPDATE` faz uma
requisição aguardar a anterior terminar, então a carteira quente serializa o
trabalho e explica a latência crescente e o throughput observado; estes números
não indicam que a CPU seja o limite geral do serviço. Os zero conflitos de lock
são esperados com o lock pessimista: as requisições aguardam a vez em vez de
perderem uma atualização ou falharem por conflito otimista. O lag do outbox
reflete a publicação ordenada: só o primeiro evento pendente de cada carteira
fica elegível por ciclo. Com uma única carteira, os eventos saem em sequência;
o intervalo de polling também afeta o tempo quando o publisher está ocioso,
mas a fila serial por carteira é a característica mais relevante neste cenário.

Para ajustar o cenário, use `LOAD_REQUESTS` (1 a 5000), `LOAD_CONCURRENCY`
(1 até o total de requisições) e, se necessário, `LOAD_BASE_PORT` para escolher
uma porta base livre para os três processos.
