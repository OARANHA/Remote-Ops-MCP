# Fase A1 — contêiner de laboratório offline VIGIAFAST

**Status: PROPOSTO / Draft PR, não instalado na VPS.** A CI foi informada `green` para o head anterior; as correções da verificação de montagem exigem CI nova. Segue a [issue #53](https://github.com/OARANHA/Remote-Ops-MCP/issues/53) e depende das Draft PRs #51 (Chutes provider) e #52 (runner Linux). Este slice **não instala nem executa DeepSeek Harness**, usa apenas um probe Node.js para verificar condições de isolamento de um contêiner descartável.

## Objetivo e contrato

O experimento anterior, A0, comprovou o protocolo `start_process → send_process_input → read_process_output → kill_process` via MCP existente. **A0 não comprovou isolamento OS:** o broker do target de produção compartilhava usuário e workspace com outros projetos.

A1 testa um ambiente de contêiner **sem rede** e sem qualquer montagem de diretório do host, sem Chutes API key ou token GitHub. Requisitos expressos no `compose.yaml`:

- `profiles: ["manual"]`; serviço jamais inicia por `docker compose up` sem habilitar perfil.
- `network_mode: none`, nenhum `ports`, `expose` nem ingresso do host; nenhuma chamada a modelos.
- `read_only: true` e nenhum `volumes`/bind mount; apenas `/tmp` temporário `tmpfs`.
- `user: 10001:10001`, `cap_drop: ALL`, `no-new-privileges`, sem socket Docker, privilégio elevado nem paths de produção.
- `mem_limit: 256m`, `cpus: 0.5`, `pids_limit: 32`, `restart: no`, `init: true`.
- Base Node `24.21.0-bookworm-slim` (versão explícita; **digest deve ser fixado** antes de qualquer implantação duradoura).

`probe.mjs` atesta UID, capabilities, `NoNewPrivs`, apenas loopback, **opções de montagem `ro` da raiz obtidas em `/proc/self/mountinfo`**, ausência de socket Docker, nenhuma env de segredo e `/tmp` efêmero. Uma simples tentativa de escrita em `/etc` por usuário sem privilégios produz `EACCES` mesmo num rootfs `rw` e **não comprova** montagem read-only; por isso foi substituída. O teste negativo exercita explicitamente rootfs `rw`, flags ambíguas e múltiplos registros da raiz.

**Limitação:** estas verificações observam o próprio contêiner; não garantem que o daemon Docker/host esteja endurecido, que o kernel não tenha vulnerabilidades ou que o acesso a redes/arquivos de produção esteja impossível em qualquer cenário. Verificar a configuração resultante do daemon e aplicar mitigação adicional (AppArmor/seccomp, limites de cgroup, política host de egress) antes de permitir código não confiável.

## Primeiro teste possível, somente em CI descartável

A CI da PR valida sintaxe do `compose.yaml`, invariantes via `node test-dsh-offline-lab.mjs` (incluindo parser de `mountinfo` com cenários negativos) e executa um contêiner descartável na máquina efêmera do GitHub Actions, sem credencial externa. Essa CI **não equivale a execução na VPS Wandora**.

Comandos documentados **para ambiente descartável e autorizado**, nunca executar em target atual de produção só porque a documentação os cita:

```bash
node test-dsh-offline-lab.mjs
docker compose -f labs/dsh-offline/compose.yaml config --quiet
docker compose -f labs/dsh-offline/compose.yaml run --rm --build --no-deps vigiafast-dsh-offline
```

Exigir `offline_lab_attestation.ok = true` e exit status zero. Não iniciar execução persistente. Container sai sozinho. Não criar token nem key para essa fase.

## Gate para executar na VPS do MCP

O alvo `wandora-agent` é produção e seu `docker_action(candidate_run)` permite apenas a imagem `wandora/web:candidate-*` na rede `wandora-core` com portas específicas. Esse contrato é **incompatível** com a imagem e com `network_mode: none` desta proposta. `start_process(program=docker)` não deve contornar a capacidade dedicada nem iniciar contêineres por fora das allowlists.

**Não há autorização operacional implícita por este PR.** Para uma execução isolada na VPS, primeiro precisamos:
1. Revisar o código e a CI desta PR, fixar digest de imagem, definir TTL e rollback de recursos;
2. Criar uma operação MCP **específica e de menor privilégio** para esta única imagem/ação, ou usar um mecanismo administrativo de aprovação explícita sem ampliar o target compartilhado indiscriminadamente;
3. Apresentar ao responsável a ação/risco exatos para aprovação, antes de criar target, Docker container, serviço ou stack.

Sem esse gate, só o experimento em GitHub Actions é permitido.

## Depois de A1

- A2: construir e executar `dsh` em sandbox usando uma versão npm fixada, ainda sem Chutes key e sem acesso externo; validar `--profile headless --help`, `--patch` e negação de execução quando o provider não tem credenciais. Não assumir que a imagem deste probe já contém o Harness.
- B: proteger a chave Chutes **fora do usuário das ferramentas do agente**, impor quota e egress controlados; pedir autorização separada para uma única chamada real com dados sintéticos.
- C: integrar um target governado com roteamento de modelos, sessões e memória canônica, e só então ampliar de 1 para 4 agentes.

## JEV.1 / decisão

Em 2026-10-09 o `jev_route_task` escolheu `split_task` (probabilidade 0.67) para separar manifesto/CI do provisionamento da VPS. Após a primeira CI `green` informada, nova revisão JEV indicou `deep_review` (0.54) e `jev_guard_action` `allow` (0.72) para corrigir o falso positivo do teste sem deploy. O `jev_guard_action` rejeitou (`deny`, 1.00) contornar a allowlist atual usando Docker CLI genérico. Decisão adotada: **preparar a A1 em Draft PR, sem deploy e sem segredos**. O julgamento é consultivo; política e testes determinísticos prevalecem.

A documentação canônica do CRISE permanece em seu repositório. Nada aqui aceita ADR-0003/0004 nem dá acesso a cliente real.
