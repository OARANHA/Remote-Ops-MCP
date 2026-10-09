# DeepSeek Harness Linux — runner governado VIGIAFAST (slice 2)

**Status: CÓDIGO PROPOSTO, NÃO INSTALADO, NÃO CONECTADO AO MCP.** Esta PR depende da PR #51 e não muda `main`, targets, control-plane, Agent Mesh, broker existente ou deploys. Este runbook é um contrato para revisão e futuro laboratório, não instrução para instalar na VPS compartilhada.

## Reutilização da infraestrutura

O Remote-Ops-MCP **já possui** `start_process`, `send_process_input`, `read_process_output`, `kill_process` e `list_processes` para um target Agent Mesh `operator`. Reutilizar essas chamadas, sem implementar outro servidor remoto. A aplicação DeepSeek é subprocesso que roda num **target de desenvolvimento isolado**, com modelo Chutes.ai configurado pelo patch da PR #51.

O `src/dsh/runner.ts` é um **programa específico**, que só chama `dsh --profile headless --patch <fixed> --json -`, filtrando o stream. Não aceita `program`, `cwd`, `args`, `--patch`, endpoint, modelo, URL, variáveis de ambiente ou paths livres do chamador. Sem shell implícito. A instalação precisa definir os paths fixos abaixo em uma imagem de worker separada.

| Destino fixado no código | Finalidade |
| --- | --- |
| `/opt/vigiafast-agent/worktree/CRISE` | checkout Git isolado, único cwd aceito |
| `/usr/local/bin/dsh` | executável CLI versionado e revisado |
| `/etc/vigiafast-dsh/chutes-headless.patch.yml` | configuração Chutes da PR #51, somente leitura |

O wrapper contém uma regra do SHA inicial exato e nega um checkout sujo em sessão **nova**. Para continuar sessão, o caller fornece o `session_id` da mesma workspace e `expected_sha`; o próprio Harness deve restringir a retomada por cwd/escopo. Em execução futura, o coordenador é responsável por amarrar o processo e seu ID a um usuário, branch e tarefa; o protocolo atual ainda não persiste isso como uma nova autorização independente.

## Contrato de chamada (futuro laboratório)

**Não executar este contrato em `wandora-prod` ou target de outra aplicação.**

1. Criar um **device/target exclusivo para desenvolvimento**, sem acesso a arquivos/serviços de outros projetos. Criar um broker/usuário dedicado ou VM própria; não reutilizar o `wandora-exec` compartilhado de produção. Recursos limitados: começar com 1 tarefa por vez. Container/VM isolado, sem `docker.sock`, host SSH, volumes de clientes ou acesso a redes internas.
2. Publicar binário construído a partir de commit fixado: compilar o repo Remote-Ops-MCP em ambiente de build, `install -m 0755 dist/dsh/runner.js /usr/local/bin/vigiafast-dsh-runner`. O CLI `dsh` também precisa estar instalado em `/usr/local/bin/dsh`. **Não fazer isso agora.**
3. Provisionar a credencial Chutes no **credential store do perfil** do Harness correspondente ao usuário do worker, não no prompt, YAML versionado ou saída do MCP. O execution broker existente remove variáveis de ambiente arbitrárias: `CHUTES_API_KEY` não será automaticamente repassada de um secret manager para `dsh`. Validar como a chave será referenciada via `apiKeyEnv` e o armazenamento do Harness antes do primeiro uso.
4. Configurar allowlist do target **exclusivamente** com `allowedProcessPrograms: ["vigiafast-dsh-runner"]`, `allowedProcessCwds: ["/opt/vigiafast-agent/worktree/CRISE"]`, o processo local do broker limitado àquele diretório e user sem privilégios. As permissões genéricas do host broker não podem servir de substituto às regras do target. Tokens GitHub com mínimo privilégio, nunca com merge, admin ou deploy.
5. Emitir chamada `start_process` com `program="vigiafast-dsh-runner"`, `cwd="/opt/vigiafast-agent/worktree/CRISE"`, `args=[]`; salvar o `ps_...` retornado.
6. Enviar pelo `send_process_input` **uma única linha JSON terminada por `\\n`**:

```json
{"request_id":"vigiafast_smoke_01","expected_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","task":"Apenas confirme que o processo esta funcional, sem ler dados de clientes."}
```

O SHA de exemplo é fictício — substituir pelo commit real autorizado. O runner devolve `started`, `session`, `status`, `final`, `complete` como JSONL sanitizado. `thinking`, fragmentos intermediários, chamadas/ferramentas, stderr bruto e payloads desconhecidos são descartados. Na falha, devolve um código genérico sem vazar os detalhes internos. Não assumir que qualquer `final` é prova de conclusão: exigir `complete.ok=true`, SHA e revisão de diff/testes.

7. Ler output incrementalmente por `read_process_output` e, para cancelar, `kill_process` com a sessão correta. O wrapper tenta encerrar o grupo de processos do `dsh` quando recebe SIGTERM/SIGINT; isso não é substituto para isolamento OS. O broker retém saídas em memória por tempo limitado.

### Primeiro experimento permitido depois de aprovação

Uma chamada **sintética**, sem cliente real, com branch dedicada e modelo autorizado. Verificar: build TypeScript; testes `node test-dsh-protocol.mjs`; invocação com falso checkout/sem chave deve falhar fechado; execução em ambiente descartável com chave custodiada e limite financeiro; `--json` filtrado; read/cancel; sessão; GitHub diff e CI. Não chamar quatro agentes antes de dimensionamento.

## Memória canônica

Prompt de execução obriga a leitura no checkout SHA-preciso: `docs/PROJECT_SOURCE.md` → `AGENTS.md` → `docs/CANONICAL_STATE.md` → `MEMORY.md` → status das ADRs e demais fontes. O wrapper confirma **presença, paths, SHA e limpeza inicial**, não comprova cognitivamente que o LLM assimilou cada arquivo: exigir prova textual verificável e revisão do coordenador. ADR-0003 e ADR-0004 do VIGIAFAST seguem **propostas**, nunca licenças para mudar RBAC ou evidências privadas.

## Riscos e pendências

- O Harness é *developer preview* sem auditoria de segurança: um modelo com ferramentas de shell pode ler qualquer recurso liberado ao seu usuário. **Isolamento OS e segredos fora do alcance do usuário do executor ainda precisam de avaliação**; armazenar a chave no mesmo HOME do processo do agent traz risco de leitura/exfiltração. Considerar proxy de egress com injeção de token fora do processo antes de conceder acesso a código sensível.
- Não há prova de funcionamento Linux/chamadas Chutes, configuração real de modelo, sessão GitHub, multiagentes ou isolamento de cliente. `--json` não fornece um log completo, e o filtrador deliberadamente remove eventos internos.
- A configuração Chutes de quatro modelos existe na PR #51, mas o wrapper não implementa roteamento dinâmico por tarefa; inicialmente usa o default. Para quatro agentes, primeiro validar worktrees, limites de custo e decisão do coordenador.
- Há nomes/caminhos fixos propositais, ainda não parametrizados nem homologados. Não criar permissões globais para contorná-los.
- Expor a Web UI requer revisão separada, autenticação e túnel privado; **não está contemplado nesta PR**.
- Não criar/alterar target, pairing, perfil do broker, fluxo de CI, commit/merge ou deploy pelo chat sem autorização específica.

## CI e aceite

Esta PR inclui teste negativo unitário para schema, redator e filtro de eventos; adiciona o comando à CI, após o build. **O workflow ainda precisa rodar e passar antes do aceite.** CI sintética não substitui smoke real em ambiente isolado.

Dois gates explícitos: revisão de segurança desta PR e **autorização humana separada para instalação**. Até lá, só existem código, documentação e plano de operação.
