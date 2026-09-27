# Agent Mesh — onboarding de uma VPS nova

O Agent Mesh é o transporte preferido para novos devices. A VPS inicia uma conexão outbound para o control plane; não é necessário expor um endpoint de administração inbound nem cadastrar chave SSH como caminho principal.

## Instalação em um comando

Em uma VPS Debian/Ubuntu nova:

```bash
curl -fsSL https://raw.githubusercontent.com/OARANHA/Remote-Ops-MCP/main/install-agent.sh | sudo bash
```

O instalador:

1. verifica/instala dependências base;
2. garante Node.js 22 em `/usr/bin/node`;
3. cria o usuário restrito `ops-mcp`;
4. baixa e compila o Remote-Ops-MCP;
5. cria o usuário isolado `wandora-exec`;
6. cria `/opt/wandora/ops-workspace`;
7. instala `wandora-ops-exec-broker.service` com socket Unix isolado;
8. instala `wandora-ops-agent.service` ligado ao broker;
9. solicita pairing no control plane;
10. mostra o código de uso único `WD-XXXX-XXXX`;
11. mostra um link clicável para `https://mcp.wandora.com.br/admin`;
12. espera aprovação em **Agent Mesh Devices → Approve pairing**;
13. valida a credencial com heartbeat;
14. habilita/inicia broker + agent.

O pairing **não é autoaprovado** pelo instalador.

## Experiência esperada

```text
Wandora Ops Agent Installer

✓ Base packages ready
✓ Node.js v22.x ready
✓ Restricted service user ready
✓ Agent installed
✓ Isolated execution user/workspace ready
✓ Execution broker is active
✓ systemd units installed

============================================================
  WANDORA AGENT MESH — DEVICE PAIRING
============================================================

Approve this device in Agent Mesh Devices:
  https://mcp.wandora.com.br/admin

Wandora Ops Agent pairing

One-time pairing code:

+------------------+
|   WD-ABCD-EFGH   |
+------------------+

Waiting for administrator approval...
```

Depois da aprovação:

```text
PAIRING=GREEN
device_id=dev_...

HEARTBEAT=GREEN
WANDORA_AGENT=READY
device_id=dev_...
service=wandora-ops-agent.service
broker=wandora-ops-exec-broker.service
workspace=/opt/wandora/ops-workspace
```

## Abrir o Admin

Quando o instalador roda em terminal gráfico local e `xdg-open` está disponível, ele tenta abrir o Admin.

Quando roda via SSH — o caso normal de VPS — uma shell remota não consegue abrir o navegador da máquina do administrador. Nesse caso o instalador imprime um hyperlink de terminal para o Admin. Use Ctrl+click/click conforme o terminal.

## Device não é Target

Pairing cria um **Agent Mesh Device** e emite:

```text
device_id=dev_...
```

Para as tools MCP usarem o device, ainda é necessário um Target Registry apontando para esse device. O caminho preferido agora é fazer isso pelo próprio MCP com aprovação humana explícita:

```text
target_agent_prepare(
  target_id=medicspro-agent,
  device_id=dev_...,
  preset=operator-workspace
)

→ approval_id=adm_...
→ required_confirmation="APPROVE adm_..."

Usuário no chat:
APPROVE adm_...

target_agent_apply(...)
→ target aplicado sem restart
```

O target dinâmico é persistido em `/app/data/dynamic-targets.json` e sobreposto ao registry estático em memória. Targets estáticos não podem ser sobrescritos por esse mecanismo.

O preset `operator-workspace` libera apenas:

- escrita/processos em `/opt/wandora/ops-workspace`;
- programa allowlist conhecido;
- restart de `wandora-ops-agent.service` e `wandora-ops-exec-broker.service`;
- **nenhum acesso Docker**.

Aprovar pairing não concede implicitamente target, Docker ou sudo. Criar/alterar target é uma segunda decisão explícita.

## Managed-admin opcional

Para uma VPS em que o objetivo seja permitir administração remota ampla sem voltar ao SSH para tarefas rotineiras, use o bootstrap explícito:

```bash
curl -fsSL https://raw.githubusercontent.com/OARANHA/Remote-Ops-MCP/main/install-agent.sh \
  | sudo bash -s -- --managed-admin
```

Além do Agent Mesh e do execution broker normal, esse modo instala `wandora-ops-admin-broker.service` como root. O agente `ops-mcp` continua fora de `sudo` e do grupo Docker.

O broker administrativo só aceita tickets Ed25519 emitidos pelo control plane. Cada ticket:

- nasce de `host_admin_prepare`;
- depende do usuário confirmar exatamente `APPROVE adm_...`;
- é ligado ao target e ao `device_id`;
- descreve programa, argv, cwd e timeout exatos;
- expira em no máximo 2 minutos;
- possui nonce de uso único com proteção de replay persistida no host;
- é verificado novamente contra allowlists locais antes da execução.

O device só anuncia `host.managed_admin` quando o socket do broker existe. Por isso o target `preset=managed-admin` falha fechado se o broker não estiver instalado/ativo.

Exemplo de target:

```text
target_agent_prepare(
  target_id=medicspro-admin,
  device_id=dev_...,
  preset=managed-admin
)

→ APPROVE adm_...
→ target_agent_apply(...)
```

Depois, cada comando root é uma decisão separada:

```text
host_admin_prepare(
  target=medicspro-admin,
  program=docker,
  args=["compose","-f","/opt/wandora/stacks/app/compose.yaml","pull"],
  cwd=/opt/wandora
)

→ APPROVE adm_...
→ host_admin_apply(...)
```

O preset não inclui shell, interpretadores, `sudo`, `su` ou `pkexec`. Ele cobre administração rotineira por programas administrativos explicitamente allowlisted. Um eventual modo break-glass root shell é outra capability e não faz parte deste bootstrap.

### Rollback / remoção do managed-admin

Para retirar somente a autoridade root e preservar Agent Mesh, pairing, workspace e execution broker normal:

```bash
sudo bash /opt/wandora/remote-ops-agent/uninstall-agent-managed-admin-broker.sh
```

O script desabilita/remove `wandora-ops-admin-broker.service`, remove a chave pública local e o replay state, mas não toca em `/var/lib/wandora-ops-agent/device.json`, `/opt/wandora/ops-workspace` nem `wandora-ops-exec-broker.service`. Depois, revogue ou desabilite o target `managed-admin` correspondente no control plane. Sem o socket do broker, o device deixa de anunciar `host.managed_admin` e novas ações falham fechadas.

## Segurança do instalador

O instalador deliberadamente:

- não adiciona `ops-mcp` aos grupos `sudo` ou `docker`;
- não instala nem exige Docker;
- instala execution broker local isolado, sem acesso ao Docker socket;
- restringe execução a `/opt/wandora/ops-workspace` e a uma allowlist de programas;
- não autoaprova pairing;
- não cria target automaticamente;
- mantém o token do device em `/var/lib/wandora-ops-agent/device.json` com acesso restrito;
- executa o serviço como `ops-mcp`, não root;
- aplica `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=yes` e capability set vazio;
- deixa a definição de capabilities efetivas no Target Registry/control plane.

## Re-pairing

Se o device foi revogado e precisa receber uma identidade nova:

```bash
curl -fsSL https://raw.githubusercontent.com/OARANHA/Remote-Ops-MCP/main/install-agent.sh \
  | sudo bash -s -- --re-pair
```

O estado anterior é preservado como backup antes de um novo pairing.

## Outro control plane ou ref

```bash
curl -fsSL https://raw.githubusercontent.com/OARANHA/Remote-Ops-MCP/main/install-agent.sh \
  | sudo bash -s -- \
      --control-plane https://mcp.wandora.com.br \
      --ref main
```

Para produção madura, prefira um `--ref` imutável de release/tag em vez de `main`.

## Operação

```bash
systemctl status wandora-ops-exec-broker.service
systemctl status wandora-ops-agent.service
systemctl status wandora-ops-admin-broker.service   # somente com --managed-admin
journalctl -u wandora-ops-exec-broker.service -n 100 --no-pager
journalctl -u wandora-ops-agent.service -n 100 --no-pager
```

Estado local do agent:

```bash
sudo -u ops-mcp \
  env HOME=/var/lib/wandora-ops-agent \
      WANDORA_CONTROL_PLANE=https://mcp.wandora.com.br \
      WANDORA_AGENT_STATE=/var/lib/wandora-ops-agent/device.json \
  /usr/bin/node /opt/wandora/remote-ops-agent/dist/agent/cli.js status
```

O token persistente nunca deve ser impresso/copied para tickets ou chats.
