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
