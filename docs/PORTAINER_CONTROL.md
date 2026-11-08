# Controle do Portainer pelo Remote Ops MCP

Esta integração permite que o ChatGPT opere o Portainer através do **Remote Ops MCP**, sem expor o Docker socket ao modelo e sem armazenar a API key no GitHub.

## Portainer

Instância configurada:

`https://portainer.wandora.com.br`

A API oficial do Portainer autentica access tokens pelo header `X-API-Key`.

## Credencial

O token **não** deve ser salvo em:

- GitHub
- `.env`
- compose
- documentação
- mensagens de chat

O control plane lê a credencial somente de:

`/app/secrets/portainer_api_key`

Este path já está sob o volume read-only de segredos do container `remote-ops-mcp`.

### Criar o token

No Portainer:

1. Abra **My Account**.
2. Abra **Access tokens**.
3. Crie um token dedicado, por exemplo `remote-ops-mcp`.
4. Copie o token uma única vez.
5. Grave o valor no arquivo host que é montado como `/app/secrets/portainer_api_key`.
6. Permissões do arquivo no host devem ser restritas ao operador/deploy.

Não envie o token em issue, commit ou pull request.

## Instâncias nomeadas (Wandora e Vigia)

O MCP usa duas conexões **fixas e independentes**, sem endpoint arbitrário informado pelo solicitante:

| `connection` | Portainer | Arquivo dentro do contêiner |
| --- | --- | --- |
| `wandora` (padrão legado) | `https://portainer.wandora.com.br` | `/app/secrets/portainer_api_key` |
| `vigia-elus` | `https://ops-vigia.wandora.com.br` | `/app/secrets/portainer_vigia_api_key` |

Os arquivos são distintos. **Não substitua** `portainer_api_key` com o token do Vigia.
No servidor Wandora inspecionado em 2026-11-08, o mount real do Docker
`remote-ops-mcp` foi confirmado como:

`/opt/wandora/stacks/remote-ops-mcp/runtime/secrets -> /app/secrets`

Logo, no host, guarde o token Vigia em
`/opt/wandora/stacks/remote-ops-mcp/runtime/secrets/portainer_vigia_api_key`.
Arquivo restrito, não comitar e não retornar token ao cliente. Mantenha o token
Wandora no arquivo `portainer_api_key`. Se o token antigo foi substituído,
restaure/rotacione **somente** o token Wandora antes de reiniciar o MCP.

Todas as ferramentas `portainer_*` aceitam o parâmetro opcional
`connection: "wandora" | "vigia-elus"`. O padrão é `wandora` por
compatibilidade. Selecione `vigia-elus` **explicitamente** em toda operação
sobre a stack ELUS360. IDs de stacks e endpoints são locais a cada instância:
sempre liste e confirme a stack na instância selecionada antes de mutações.
A seleção é isolada por contexto assíncrono; cada conexão usa credencial e cache
independentes. Recarregue o processo depois de rotacionar uma chave, porque a
chave bem-sucedida pode permanecer em cache.

O conjunto de destinos é fechado no código. A conexão Vigia é fixada em
`https://ops-vigia.wandora.com.br`; não há URL arbitrária por parâmetro.
Manter `prune:false` em redeploy, preservar digests e verificar o rollback.

## Ferramentas adicionadas

### Leitura

- `portainer_status`
- `portainer_endpoints_list`
- `portainer_stacks_list`
- `portainer_stack_get`

Valores de environment variables são sempre retornados como `[REDACTED]`.

### Escrita

- `portainer_stack_update_env`
- `portainer_stack_git_redeploy`
- `portainer_stack_create_git`
- `portainer_stack_start`
- `portainer_stack_stop`
- `portainer_stack_delete`

As mutações de lifecycle exigem `stack_id` e confirmação exata do nome da stack para reduzir risco de operar o ID errado.

A exclusão não remove volumes por padrão. Para uma remoção intencional de dados persistidos, o chamador precisa definir explicitamente `remove_volumes=true`.

A criação Git inicial aceita somente repositório público. Credenciais Git privadas não fazem parte desta primeira versão.

## Atualização de variáveis

A implementação preserva as variáveis existentes por padrão e altera somente os nomes solicitados.

Para stack criada por Git:

`PUT /api/stacks/{id}/git/redeploy?endpointId={endpointId}`

Para stack criada por editor/Compose:

1. lê o stack file atual;
2. mescla as variáveis no control plane;
3. envia `PUT /api/stacks/{id}?endpointId={endpointId}`.

Nenhum valor existente de variável é retornado ao modelo.

## Regra para novos projetos

Projetos novos devem preferencialmente nascer como:

```text
GitHub
  ↓
Portainer Stack criada a partir de Git
  ↓
variáveis administradas no Portainer
  ↓
Docker Standalone
```

Isto evita stacks descobertas como `Control: Limited` e mantém o Compose versionado no Git.


## Lifecycle de stack

As operações governadas usam os endpoints oficiais do Portainer associados ao `EndpointId` já registrado na stack:

- start: `POST /api/stacks/{id}/start?endpointId={endpointId}`;
- stop: `POST /api/stacks/{id}/stop?endpointId={endpointId}`;
- delete: `DELETE /api/stacks/{id}?endpointId={endpointId}&removeVolumes={bool}`.

A implementação primeiro lê a stack, valida `confirm_stack_name` contra o nome real e só então executa a mutação. Não existe ferramenta de request HTTP arbitrário para o Portainer.
