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
5. instala `wandora-ops-agent.service` com hardening systemd;
6. solicita pairing no control plane;
7. mostra o código de uso único `WD-XXXX-XXXX`;
8. mostra um link clicável para `https://mcp.wandora.com.br/admin`;
9. espera aprovação em **Agent Mesh Devices → Approve pairing**;
10. valida a credencial com heartbeat;
11. habilita/inicia o serviço persistente.

O pairing **não é autoaprovado** pelo instalador.

## Experiência esperada

```text
Wandora Ops Agent Installer

✓ Base packages ready
✓ Node.js v22.x ready
✓ Restricted service user ready
✓ Agent installed
✓ systemd unit installed

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
```

## Abrir o Admin

Quando o instalador roda em terminal gráfico local e `xdg-open` está disponível, ele tenta abrir o Admin.

Quando roda via SSH — o caso normal de VPS — uma shell remota não consegue abrir o navegador da máquina do administrador. Nesse caso o instalador imprime um hyperlink de terminal para o Admin. Use Ctrl+click/click conforme o terminal.

## Device não é Target

Pairing cria um **Agent Mesh Device** e emite:

```text
device_id=dev_...
```

Para as tools MCP usarem o device, ainda é necessário um Target Registry apontando para esse device:

```json
{
  "id": "medicspro-prod",
  "deviceId": "dev_...",
  "environment": "production",
  "capabilityProfile": "read-only",
  "transport": "agent",
  "enabled": true
}
```

O target deve começar com o menor perfil necessário. Aprovar pairing não concede implicitamente Docker, sudo ou operador amplo.

## Segurança do instalador

O instalador deliberadamente:

- não adiciona `ops-mcp` aos grupos `sudo` ou `docker`;
- não instala nem exige Docker;
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
systemctl status wandora-ops-agent.service
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
