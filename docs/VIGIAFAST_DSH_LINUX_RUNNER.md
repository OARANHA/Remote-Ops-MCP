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
| `/opt/vigiafast-runner/dist/` | distribuição compilada **completa**, incluindo `dsh/runner.js`, `dsh/protocol.js` e `security/redact.js` |
| `/usr/local/bin/vigiafast-dsh-runner` | launcher Node pinado (`bin/vigiafast-dsh-runner`), único programa do broker |
| `/var/lib/vigiafast-dsh/dsh` | `DSH_HOME` fixo para o perfil/credenciais do executor dedicado |

O wrapper contém uma regra do SHA inicial exato e nega um checkout sujo em sessão **nova**. Para continuar sessão, o caller fornece o `session_id` da mesma workspace e `expected_sha`; o próprio Harness deve restringir a retomada por cwd/escopo. Em execução futura, o coordenador é responsável por amarrar o processo e seu ID a um usuário, branch e tarefa; o protocolo atual ainda não persiste isso como uma nova autorização independente.

## Contrato de chamada (futuro laboratório)

**Não executar este contrato em `wandora-prod` ou target de outra aplicação.**

1. Criar um **device/target exclusivo para desenvolvimento**, sem acesso a arquivos/serviços de outros projetos. Criar um broker/usuário dedicado ou VM própria; não reutilizar o `wandora-exec` compartilhado de produção. Recursos limitados: começar com 1 tarefa por vez. Container/VM isolado, sem `docker.sock`, host SSH, volumes de clientes ou acesso a redes internas.
2. Empacotar a **árvore compilada completa** (`dist/`) do Remote-Ops-MCP no destino root-owned `/opt/vigiafast-runner/dist/`; incluir `package.json` com `"type":"module"` no diretório pai e todas as dependências de runtime necessárias. Copiar o launcher `bin/vigiafast-dsh-runner` para `/usr/local/bin/vigiafast-dsh-runner` com modo executável. **Não copiar somente `dist/dsh/runner.js`**, pois ele possui imports relativos. O CLI `dsh` revisado deve ser instalado em `/usr/local/bin/dsh` com destino final root-owned. Patch Chutes em `/etc/vigiafast-dsh/chutes-headless.patch.yml`, também root-owned, nunca gravável pelo usuário de execução. **Não fazer isso agora.**
3. Fixar `HOME=/var/lib/vigiafast-dsh` e `DSH_HOME=/var/lib/vigiafast-dsh/dsh` como no executor; **não** herdar `HOME=/var/lib/wandora-exec` do broker genérico. O runner define `DSH_PERMISSION_MODE=workspace-write` e `DSH_TELEMETRY_DISABLED=1`, mas essas variáveis **não criam isolamento suficiente**. Provisionar a credencial Chutes no **credential store do perfil** do Harness do usuário dedicado, nunca no prompt, YAML versionado ou saída do MCP. O broker existente remove envs arbitrárias: `CHUTES_API_KEY` não será automaticamente repassada. **Bloqueador:** o modelo com ferramentas de shell pode tentar ler arquivos de credenciais acessíveis pelo mesmo usuário. Exigir segredo de canário com quota estrita e isolamento/egress ou solução de proxy com injeção fora do processo antes de permitir trabalhos com dados sensíveis.
4. Configurar allowlist do target **exclusivamente** com `allowedProcessPrograms: ["vigiafast-dsh-runner"]`, `allowedProcessCwds: ["/opt/vigiafast-agent/worktree/CRISE"]`, o processo local do broker limitado àquele diretório e user sem privilégios. As permissões genéricas do host broker não podem servir de substituto às regras do target. Tokens GitHub com mínimo privilégio, nunca com merge, admin ou deploy.
5. Emitir chamada `start_process` com `program="vigiafast-dsh-runner"`, `cwd="/opt/vigiafast-agent/worktree/CRISE"`, `args=[]`; salvar o `ps_...` retornado.
6. Enviar pelo `send_process_input` **uma única linha JSON terminada por `\\n`**:

```json
{"request_id":"vigiafast_smoke_01","expected_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","task":"Apenas confirme que o processo esta funcional, sem ler dados de clientes."}
```

O SHA de exemplo é fictício — substituir pelo commit real autorizado. O runner devolve `started`, `session`, `status`, `final`, `complete` como JSONL sanitizado. `thinking`, fragmentos intermediários, chamadas/ferramentas, stderr bruto e payloads desconhecidos são descartados. Na falha, devolve um código genérico sem vazar os detalhes internos. Não assumir que qualquer `final` é prova de conclusão: exigir `complete.ok=true`, SHA e revisão de diff/testes.

7. Ler output incrementalmente por `read_process_output` e, para cancelar, `kill_process` com a sessão correta. O wrapper tenta encerrar o grupo de processos do `dsh` quando recebe SIGTERM/SIGINT; isso não é substituto para isolamento OS. O broker retém saídas em memória por tempo limitado.

### Primeiro experimento permitido depois de aprovação

Uma chamada **sintética**, sem cliente real, com branch dedicada e modelo autorizado. Verificar: build TypeScript; testes `node test-dsh-protocol.mjs` e `node test-dsh-runner-gates.mjs`; invocação com falso checkout/sem chave deve falhar fechado; execução em ambiente descartável com chave custodiada e limite financeiro; `--json` filtrado; read/cancel; sessão; GitHub diff e CI. Não chamar quatro agentes antes de dimensionamento.

## Memória canônica

Prompt de execução obriga a leitura no checkout SHA-preciso: `docs/PROJECT_SOURCE.md` → `AGENTS.md` → `docs/CANONICAL_STATE.md` → `MEMORY.md` → status das ADRs e demais fontes. O wrapper confirma **presença, paths, SHA e limpeza inicial**, não comprova cognitivamente que o LLM assimilou cada arquivo: exigir prova textual verificável e revisão do coordenador. ADR-0003 e ADR-0004 do VIGIAFAST seguem **propostas**, nunca licenças para mudar RBAC ou evidências privadas.

## Riscos e pendências

- O Harness é *developer preview* sem auditoria de segurança: um modelo com ferramentas de shell pode ler qualquer recurso liberado ao seu usuário. **Isolamento OS e segredos fora do alcance do usuário do executor ainda precisam de avaliação**; armazenar a chave no mesmo HOME do processo do agent traz risco de leitura/exfiltração. Considerar proxy de egress com injeção de token fora do processo antes de conceder acesso a código sensível.
- Não há prova de funcionamento Linux/chamadas Chutes, configuração real de modelo, sessão GitHub, multiagentes ou isolamento de cliente. `--json` não fornece um log completo, e o filtrador deliberadamente remove eventos internos.
- A configuração Chutes de quatro modelos existe na PR #51, mas o wrapper não implementa roteamento dinâmico por tarefa; inicialmente usa o default. Para quatro agentes, primeiro validar worktrees, limites de custo e decisão do coordenador.
- Há nomes/caminhos fixos propositais, ainda não parametrizados nem homologados. Não criar permissões globais para contorná-los. O executor exige CLI e patch efetivos de propriedade `root` e sem bits de escrita para grupo/outros; a árvore compilada e o launcher também devem ser implantados como root-owned e read-only ao worker.
- O stream externo inclui texto de resposta final após redação sintática de segredos conhecidos. **Isso não garante remoção de PII ou segredos desconhecidos.** Nunca disponibilizar dados reais de clientes no ambiente do executor. A aprovação de acesso aos dados e egress é independente deste filtro.
- Expor a Web UI requer revisão separada, autenticação e túnel privado; **não está contemplado nesta PR**.
- Não criar/alterar target, pairing, perfil do broker, fluxo de CI, commit/merge ou deploy pelo chat sem autorização específica.

## CI e aceite

A PR passou pela primeira rodada de CI conforme comunicação do operador (`green` para head anterior). Após correções de segurança e novo commit, **é necessária nova CI do head atualizado**; não presumir que o sinal anterior abranja estas mudanças. Testes unitários do protocolo e de falha fechada do runner estão na CI, após o build. CI sintética não substitui smoke real em ambiente isolado.

Dois gates explícitos: revisão de segurança desta PR e **autorização humana separada para instalação**. Até lá, só existem código, documentação e plano de operação.
