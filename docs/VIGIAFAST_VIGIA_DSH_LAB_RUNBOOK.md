# Runbook de autorização — laboratório DSH exclusivamente na VPS VIGIA

**Estado: PROPOSTO / NÃO EXECUTADO.** Documento de planejamento, não um instalador. Não concede acesso root, não cria dispositivo, não altera o daemon Docker de produção e não substitui autorização `APPROVE adm_...`.

**Decisão do proprietário (2026-10-09): a VPS utilizada é VIGIA (`vmi3617290`), não Wandora e não uma VPS adicional.** O alvo `vigia-agent` e os serviços atuais são de produção e não devem ser reutilizados como laboratório.

## 1. Fontes / cadeia de mudanças

- Discussão e decisões: [issue #53](https://github.com/OARANHA/Remote-Ops-MCP/issues/53).
- PRs empilhadas, **todas Draft** no preflight 2026-10-09: #51 (perfil Chutes) → #52 (runner Linux) → #54 (probe Docker offline) → #55 (capability MCP) → #56 (preset e modo de device restrito).
- CI #196 de #56 verde confirmada no SHA `e7dc15db6acfdc6578c1b861f6ec31df95d01908`. **CI não é implantação**, e nenhum desses PRs foi integrado em main.
- Em `main`, `.github/workflows/container.yml` publica imagem GHCR no `push`; **não fazer merge automaticamente**.
- Referências externas oficiais: [Docker rootless](https://docs.docker.com/engine/security/rootless/) e [Docker rootless troubleshooting / Ubuntu 24.04](https://docs.docker.com/engine/security/rootless/troubleshoot/). Versões de pacotes e requisitos precisam ser revalidados antes de instalar.

## 2. Inventário Vigia (leituras em 2026-10-09; não assumir permanente)

| Item | Evidência |
| --- | --- |
| Host/OS | `vmi3617290`, Ubuntu 24.04.5 LTS, Linux 6.8.0-142 x86_64 |
| CPU | 6 vCPUs, carga instantânea 1min ~2.4 na consulta |
| RAM | 12 GiB total, **~3,1 GiB disponíveis** na consulta posterior (em consulta anterior ~2,2 GiB); 0 swap |
| Disco | Raiz 193 GiB, ~124 GiB livres (37% ocupado) |
| Isolamento | cgroups v2 disponíveis; AppArmor carregado; `kernel.unprivileged_userns_clone=1`; userns configurável |
| MicroVM | `/dev/kvm` não existe, vmx/svm não vistos: **não presumir microVM acelerada** |
| Docker atual | `/usr/bin/docker`, `/usr/bin/dockerd` e socket em `/run/docker.sock` presentes: **não conectar o laboratório ao socket de produção** |
| Rootless não preparado | `dockerd-rootless.sh`, `rootlesskit`, `newuidmap`, `newgidmap`, `slirp4netns`, `fuse-overlayfs` e Podman não encontrados nos caminhos típicos inspecionados |
| Permissão MCP | `vigia-agent` sem `allowedDockerActions`; `vigia-managed-admin` tem allowlist de root, mas **não inclui `useradd`/`usermod`/`loginctl`** |
| API Docker via MCP | `docker_list(vigia-agent)` recusou `docker_read_proxy_required`. **Isso é controle, não erro a contornar** |
| Device dedicado | Não registrado; `vigiafast-dsh-lab` ainda não existe |

A ausência de binários em caminhos típicos é uma inspeção de instalação, não uma prova de ausência em todos os PATHs. **Revalidar inventário perto do gate.**

## 3. Arquitetura mínima, apenas teste sintético A1.7

```text
ChatGPT/Operador
    |
    v HTTPS + auditoria
Remote-Ops-MCP control plane existente
    |
    v Agent Mesh TLS (device NOVO e exclusivo)
VPS VIGIA — usuário OS dedicado sem sudo e sem grupo docker
    +-- agente dedicado / ID dev_ real
    |       VIGIAFAST_DSH_OFFLINE_DEVICE_MODE=1
    |       DOCKER_HOST=tcp://127.0.0.1:23751
    |       Somente vigiafast.dsh.offline_probe
    |
    +-- Docker proxy de laboratório (bind 127.0.0.1:23751)
    |       VIGIAFAST_DSH_OFFLINE_IMAGE_SHA256=sha256:<id verificado>
    |       DOCKER_SOCKET_PATH=<socket rootless do usuário lab>
    |       Sem acesso a /run/docker.sock, volumes ou credenciais do host
    |
    +-- Docker daemon ROOTLESS sob o usuário do lab, separado do Docker produção
            |
            +-- contêiner descartável do probe (SEM REDE / SEM PORTAS)
                   uid 10001; rootfs RO; cap_drop ALL
                   256 MiB / 0.5 CPU / 32 PIDs / tmpfs 16 MiB
                   sai e é removido ao final
```

**Acesso da rede:** o *agente de controle* precisa somente da conexão de saída ao endpoint MCP aprovado (TLS com CA verificada). O **contêiner do probe** não tem qualquer rede. Docker rootless e AppArmor não equivalem a uma VM: a documentação do Docker lista limitações de AppArmor em rootless. **Não executar código de agente não confiável, inferência ou shell arbitrário como consequência do sucesso de A1.7.**

## 4. Gates antes de qualquer mudança na Vigia

**Gate G0 — revisão de código e infraestrutura (somente leitura):**
1. Revalidar os 5 SHAs e green, diffs e workflows. Conferir que nenhuma PR publica segredos. Conferir se qualquer merge pode causar publicação/deploy; parar se houver deploy automático não aprovado.
2. Revalidar `MemAvailable`, disco, load e picos de uso dos serviços. **Proposta de NO-GO:** memória disponível abaixo de 2,5 GiB, disco abaixo de 80 GiB, load médio 5min acima de 4.0, ou qualquer incidente operacional aberto. Estes são limiares conservadores propostos, não SLO atual.
3. Confirmar o mecanismo de instalação de Docker já existente (`docker.io` x `docker-ce`) e disponibilidade/versionamento de pacotes `uidmap` e extras rootless. Não usar `curl | sh`, `latest`, upgrades de Docker de produção ou novos repositórios apt sem decisão específica.
4. Verificar domínio/certificados egress Agent Mesh sem compartilhar secrets. Verificar UIDs/subuids/subgids vagos e não sobrepostos, systemd user namespace policy e compatibilidade AppArmor Ubuntu 24.04.
5. Confirmar se uma conta OS nova e sem privilégios pode ser criada via fluxo aprovado. **A allowlist `vigia-managed-admin` atual não aceita `useradd`, `usermod` ou `loginctl`.** Não invocar `bash`, `docker` ou outro programa allowlisted como atalho para essas ações. Alternativas permitidas: administrador humano do host com ação registrada, ou implementação revisada de uma capability administrativa *específica*, sujeita a nova aprovação.

**Gate G1 — APROVAÇÃO ADMINISTRATIVA EXPLÍCITA** (não preparada neste documento):
- Para cada operação real, apresentar alvo, executável, argumentos exatos, impacto, limites, duração, pré-condições, pós-condições e rollback.
- Exigir resposta humana exata ao ticket `APPROVE adm_...` quando o MCP produzir um ticket aplicável. Aprovação de plano não autoriza uma cadeia ilimitada de comandos.
- **Nunca** habilitar o agente/usuário do lab no grupo `docker` do host; nunca dar `sudo`, `CAP_SYS_ADMIN`, `--privileged`, Docker socket ou mounts de produção.
- Não alterar ou parar `docker.service`, `docker.socket`, Agent Mesh Vigia existente, Portainer, stacks, proxies reversos, firewall de produção ou serviços de clientes.

## 5. Sequência de implantação proposta, cada subfase sujeita a autorização

### G1a — conta e dependências

- Registrar uma **conta nova OS** `vigiafast-dsh-lab` sem sudo, sem grupo docker e sem acesso aos diretórios de apps/segredos existentes. Separar home/data/cache/permissões. Conferir senha bloqueada, UIDs auxiliares exclusivos (>65.536 para cada subuid/subgid conforme documentação), ausência de capacidades extras, sem acesso ao socket rootful.
- O programa exato de criação de usuário requer canal autorizado pelo proprietário: hoje **fora da allowlist de comandos root do MCP**. Nenhuma alteração de allowlist por conveniência.
- Instalar apenas os pré-requisitos rootless auditados, depois de confirmar origem apt e versão, sem atualizar o Docker rootful. Priorizar `uidmap` + mecanismo de instalação rootless suportado pela distro; a documentação oficial menciona `docker-ce-rootless-extras` quando apropriado. Ubuntu 24.04 pode exigir política AppArmor para rootlesskit; não desativar AppArmor do host.
- Fixar uma versão e hash da imagem do probe a partir do Dockerfile da PR #54; construir/importar a imagem **fora do Docker de produção** e registrar ID do conteúdo e origem do artefato.

### G1b — daemon/proxy/Agente Mesh exclusivos

- Instalar o daemon Docker rootless para a nova conta com **socket próprio**, storage próprio, namespaces, systemd cgroups e política de egress; `docker info` como essa conta deve confirmar `rootless`, `cgroupv2`, limites efetivos e a ausência de conexão ao daemon rootful. Não usar `docker context default`.
- Implantar um proxy Docker local com `BIND_HOST=127.0.0.1`, `PORT=23751`, `DOCKER_SOCKET_PATH` apontando **exclusivamente** para o socket rootless, `ALLOWED_DOCKER_CONTAINERS` restrito ao nome fixo do probe, **sem** `ALLOWED_DOCKER_ACTIONS`, candidates, exec containers, image-load roots ou redes/portas candidatas.
- Inserir a imagem SHA-256 exata na variável protegida do proxy; sem chave Chutes e sem variáveis de produção.
- Parear um **device Agent Mesh novo**, com identity, state file e token próprios, sem reusar o token/device do `vigia-agent`. O usuário/modelo não recebe a credencial do device nem o socket do daemon.
- Enviar heartbeat **apenas** `vigiafast.dsh.offline_probe` no modo opt-in (`VIGIAFAST_DSH_OFFLINE_DEVICE_MODE=1` + `DOCKER_HOST=tcp://127.0.0.1:23751`). Criar o target dinâmico por `target_agent_prepare(preset=vigiafast-dsh-offline, target_id=vigiafast-dsh-lab, environment=development, device_id real)`, após revisão e aprovação explícita `target_agent_apply`. Os targets existentes permanecem intactos.

### Limites e expiração

- Contêiner: **256 MiB, 0.5 CPU, 32 PIDs, tmpfs 16 MiB, rede none, zero portas, sem restart** (já fixado pelo contrato da PR #55).
- Para o conjunto *daemon rootless + proxy + device*, propor uma `systemd slice` exclusiva com **MemoryMax 1 GiB, CPUQuota 75%, TasksMax 128** e sem proteção de recursos dos serviços de produção enfraquecida. **Validar aplicação desses limites e delegação de cgroup v2, não presumir que flags Docker bastam.** Parar se a quota mostrar incompatibilidade.
- Recomendação de **janela total de laboratório: até 30 minutos**, com desligamento explícito no fim e proibição de restart automático da sessão. O proxy tem mutex em memória; não é um orquestrador de TTL geral. Exigir supervisão e limpeza operacional com registro de evidência.
- Artefatos mínimos: imagem sintética sob ID exato; limite máximo de armazenamento da área do lab deve ser definido/aplicado (quota ou filesystem dedicado) antes do teste. Se quota por filesystem indisponível, **NO-GO** para operação autônoma e revisar desenho.
- Não usar o Docker rootful para preparar, puxar, construir, inspecionar ou limpar artefatos do laboratório.

## 6. Gate G2 — canário sintético ÚNICO

Executar uma única chamada da tool `vigiafast_dsh_offline_probe` com o alvo `vigiafast-dsh-lab`, sem parâmetros além do target. Exigir:
- `offline_lab_attestation.ok=true`, todos os checks booleanos explicitamente verdadeiros, `no_provider_material=true`, `read_only_root=true`, `loopback_only=true`.
- Docker host rootless comprovado **antes e depois**; nenhuma porta pública, montagem de projeto/segredo, processo lab persistente ou contêiner residual.
- Auditoria de ator/hora/target, commit/sha256 de imagem e recibo da execução, com redação de segredos; preservar só metadados técnicos suficientes.
- Se erro, timeout, contêiner órfão, memória host abaixo do limite, falha de quota ou suspeita de contato com produção: **STOP**, sem retry/polling; investigação em leitura e autorização para limpeza exata.

**Aprovado o G2 não significa que DeepSeek Harness, Chutes.ai e agentes de código já podem ser executados.** Exigirão gates A2/B posteriores, inclusive isolamento mais forte ou aceitação explícita do risco residual de compartilhar kernel do host.

## 7. Rollback — exclusivo e reversível, nunca global

Pela mesma identidade/aprovação administrativa utilizada no provisioning:
1. Suspender novas chamadas ao target lab (disable/revoke `vigiafast-dsh-lab`) sem alterar outros targets; guardar auditoria do canário.
2. Parar só o agente, proxy e daemon **do laboratório**; verificar que `vigia-agent`, Docker rootful, Portainer e demais serviços mantêm estado anterior.
3. Remover somente contêiner/artefatos com **nomes e identificadores exatos confirmados** do laboratório; não usar `docker system prune` global nem limpar `/var/lib/docker` de produção.
4. Desparear/revogar apenas o `dev_...` do lab, expirar o token dedicado; remover apenas o rootless data-root e serviço do usuário lab com path/owner comprovados, por ticket humano específico.
5. Desinstalar dependências **somente se** forem exclusivas do laboratório e sua remoção não afetar outro software; não executar `apt autoremove` indiscriminado.
6. Se não for possível identificar proprietário de recurso ou provar não-interferência: **parar rollback destrutivo** e escalar para revisão humana.

## 8. Critério de solicitação ao responsável — nenhum admin agora

**Proposta para aprovação inicial:** autorizar a **preparação de um plano administrativo restrito G1a na VPS Vigia** (conta `vigiafast-dsh-lab` e pré-requisitos Docker rootless), após apresentação dos comandos exatos e prova de que não afetam Docker/serviços atuais. Essa autorização de planejamento **não** inclui executar `useradd`, `apt-get`, alterar AppArmor/systemd, instalar daemon/proxy/Agent Mesh, habilitar Chutes, fazer merge ou publicar imagem.

Somente depois de aprovar o plano G1a, conferir as capacidades administrativas disponíveis e apresentar os tickets reais, pedir `APPROVE adm_...` para cada mutação suportada. Sem capability adequada, registrar **bloqueio operacional**, nunca contorná-la.

### Limitações expressas

Rootless Docker mitiga parte do risco de daemon com privilégio root, mas compartilha o kernel e tem limitações documentadas (incluindo AppArmor e certos recursos de rede). O sucesso do probe sintético não autoriza acesso de um modelo a shell ou a sistemas de produção. A VPS Vigia é decisão do responsável, não autorização para executar tarefas irrestritas nela.
