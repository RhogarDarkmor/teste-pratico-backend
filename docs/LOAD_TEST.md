# Teste de carga

Roda com `bun run test:load`, depois de subir Postgres e LocalStack com
`bun run infra:up`. O script cria um banco e filas SQS só pra ele, sobe três
processos reais da API e apaga tudo no final. Não mexe no banco de dev nem nas
filas normais do projeto.

## Como funciona

Por padrão manda 300 requisições HTTP (até 24 ao mesmo tempo) pra uma carteira
só. Cada uma é uma `BET` de `0.01 BRL` com uma chave de idempotência diferente,
e o saldo inicial cobre todas. O publisher do outbox fica ligado e publica numa
fila FIFO do próprio teste. O consumer do SQS e o worker de pendentes ficam
desligados, porque o que eu queria medir era a entrada HTTP.

O que é medido:

- throughput e latência (p50, p95, p99) durante o envio, pela resposta de cada
  requisição;
- erro técnico: falha de transporte ou resposta 5xx. Status fora do esperado
  aparece separado;
- conflitos de lock: diferença do contador da aplicação entre o começo e o fim,
  somando as três instâncias;
- lag do outbox: o maior valor visto logo depois da carga e enquanto o outbox
  esvazia. No final ele tem que chegar a zero.

No fim o script confere saldo, soma do ledger e quantidade de transações e
lançamentos.

## Última execução

Rodei em 22/10/2026 com o padrão (300 requisições, concorrência 24):

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

Antes dessa rodei uma vez com os mesmos parâmetros e deu 23.10 requisições/s
(p50 1019.54 ms, p95 2061.65 ms, p99 2541.42 ms) e lag máximo de 19.87 s. Deixei
as duas pra mostrar que varia bastante de uma execução pra outra.

## O que eu tiro disso

Tudo roda na mesma máquina, com uma carteira quente e os serviços em container.
Serve pra mostrar o comportamento, não é capacidade de produção nem meta.

Todas as apostas disputam a mesma carteira, e o `SELECT ... FOR UPDATE` faz
cada uma esperar a anterior terminar. Ou seja, a carteira serializa o trabalho,
e é isso que explica a latência subindo e o throughput baixo. Não quer dizer que
a CPU seja o limite do serviço. Zero conflitos de lock é o esperado com lock
pessimista: a requisição espera a vez, em vez de falhar ou perder atualização.

O lag do outbox vem da publicação em ordem: só o primeiro evento pendente de
cada carteira pode sair por ciclo, então com uma carteira só os eventos saem em
fila. O intervalo de polling pesa um pouco quando o publisher está parado, mas
a fila por carteira é o que mais conta nesse cenário.

## Ajustando o cenário

Dá pra mudar com `LOAD_REQUESTS` (1 a 5000), `LOAD_CONCURRENCY` (1 até o total
de requisições) e, se a porta estiver ocupada, `LOAD_BASE_PORT` pra escolher a
porta base dos três processos.
