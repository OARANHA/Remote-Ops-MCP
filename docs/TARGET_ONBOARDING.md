# Target Onboarding — adicionando uma nova VPS

O onboarding é **administrativo** (você, no terminal) — nunca via tool do modelo.

## Fluxo (por target)

```
provisionar usuário -> instalar public key -> capturar host fingerprint
  -> registrar no targets.json -> connectivity test -> read-only verification -> ativo
```

## 1. No host do MCP (gera chave dedicada)

```bash
ssh-keygen -t ed25519 -f /opt/remote-ops-mcp/secrets/<target-id> -N "" -C "remote-ops-mcp-<target-id>"
```

## 2. Na nova VPS

```bash
sudo adduser --disabled-password --gecos "Remote Ops MCP" ops-mcp
sudo install -d -m 700 -o ops-mcp -g ops-mcp /home/ops-mcp/.ssh
sudo install -m 600 -o ops-mcp -g ops-mcp /dev/null /home/ops-mcp/.ssh/authorized_keys
# cole o conteúdo da chave PÚBLICA gerada no passo 1:
echo "ssh-ed25519 AAAA..." | sudo tee -a /home/ops-mcp/.ssh/authorized_keys >/dev/null

# Não adicione ops-mcp ao grupo docker por padrão: esse grupo é equivalente a acesso root no host.
# Mantenha allowedDockerContainers vazio até existir um broker/proxy Docker explicitamente read-only.
sudo usermod -aG systemd-journal ops-mcp   # opcional; logs podem conter dados sensíveis

# fingerprint do host key (vai para o targets.json):
ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null | ssh-keygen -lf -
```

Recomendado no `/etc/ssh/sshd_config` do target:
`PasswordAuthentication no`, `PubkeyAuthentication yes`, `PermitRootLogin no`.

## 3. Registro no Target Registry

Adicione em `/opt/remote-ops-mcp/config/targets.json`:

```json
{
  "id": "medicspro-prod",
  "host": "IP-OU-HOST",
  "port": 22,
  "username": "ops-mcp",
  "keyFile": "/app/secrets/medicspro-prod",
  "hostKeyFingerprint": "SHA256:xxxx",
  "environment": "production",
  "capabilityProfile": "prod-read-mostly",
  "allowedPaths": ["/opt/medicspro"],
  "allowedDockerContainers": [],
  "allowedServices": [],
  "allowedGitRepos": ["/opt/medicspro"],
  "enabled": true,
  "transport": "ssh"
}
```

E monte o arquivo da chave no compose (volume `secrets` já cobre `/app/secrets`).

### Target na mesma VPS que hospeda o container MCP

Dentro do container, `127.0.0.1` aponta para o próprio container, não para o host Docker. Para operar a mesma VPS que hospeda o Remote Ops MCP, use `host.docker.internal` no `targets.json`. O compose canônico adiciona explicitamente `host.docker.internal:host-gateway`.

Para uma VPS remota, continue usando o IP/FQDN real do target. O fingerprint fixado continua sendo o fingerprint da chave SSH do host de destino; o alias Docker não altera essa identidade.

## 4. Validação read-only (antes de liberar no dia a dia)

Via ChatGPT (conectado) ou curl com token:

1. `targets_list` — novo target aparece;
2. `host_status(target="medicspro-prod")` — responde com hostname/uptime;
3. `docker_list`, `service_status`, `read_file` em caminho permitido;
4. **testes adversariais**: `read_file` em `.env` (deve dar `SECRET_PATH_DENIED`),
   caminho fora da allowlist (`PATH_DENIED`), target inexistente (`TARGET_NOT_FOUND`).

## Isolamento entre targets (garantias)

- Cada target resolve credencial/fingerprint **por id** — sem compartilhamento.
- Allowlists de paths/containers/serviços/repositórios são **por target**.
- Conexões SSH em pool separado por target.
- Nenhuma tool aceita host/usuario/chave como parâmetro — apenas o `id`.

## Runtime revoke is not target onboarding

The admin console can temporarily revoke an already-authorized target. This is a runtime **deny overlay** only. It does not create targets, change SSH addresses/keys, widen paths, add containers/services/repos, or override `enabled: false` in `targets.json`.

Adding or widening a target remains a reviewed configuration change followed by host-key and read-only capability validation.
