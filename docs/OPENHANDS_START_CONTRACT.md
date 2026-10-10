# OpenHands Agent Canvas — contrato de criação de conversa (issue #61)

**Status:** correção em PR; **não implantada** na VPS Vigia. Registro sintético e sem credenciais de clientes.

## Evidência e escopo

- Em 2026-10-10, `openhands.health` e `openhands.list` responderam com autenticação válida, mas uma chamada autorizada `openhands.start` recebeu **HTTP 422**.
- A implementação anterior de `src/agent/openhands.ts` omitia `agent`, `agent_settings` e `agent_profile_id`. O SDK do Agent Server v1.53.0, usado pelo Agent Canvas v1.26.0, exige um desses três campos (`StartConversationRequest._require_agent`).
- A correção usa o endpoint existente `GET /api/settings` autenticado. Solicita **apenas exposição criptografada** (`X-Expose-Secrets: encrypted`) e prefere `active_agent_profile_id` quando configurado. Sem perfil ativo, encaminha `agent_settings` criptografado com `secrets_encrypted:true`, deixando a descriptografia exclusivamente ao servidor OpenHands. Nunca solicita valores `plaintext`.
- Se as configurações de agente ou o modelo não estiverem disponíveis, o adaptador **falha antes do POST**, sem iniciar conversa e sem retornar o conteúdo das configurações ou das mensagens de erro do servidor.
- A criação mantém `LocalWorkspace` em `/projects/mcp-coordination-lab`, `AlwaysConfirm`, limite de **20** iterações, `worktree:false` e `initial_message.run:true`. Este limite de workspace é um parâmetro da API; não equivale a sandbox ou barreira de isolamento total.
- A chave de sessão permanece somente no arquivo local protegido do Agent Mesh; não foi copiada para o repositório.

## Testes e gates

- Testes de regressão sintéticos em `test-openhands-bridge.mjs`: cabeçalhos de autenticação, seleção de perfil existente, round-trip cifrado, rejeição sem modelo, sanitização de erros, escopo de workspace e restrições de execução.
- Comando previsto no workflow de CI: `node --experimental-strip-types --test test-openhands-bridge.mjs`. **Não afirmar resultado até execução da CI**.
- Não fazer polling de CI; operador informa `green`/`red`.
- CI aprovada não autoriza merge nem implantação. Implantação no Agent Mesh exige aprovação explícita e procedimento de atualização do agente existente, sem alterar Canvas/volumes/outros serviços.
- Após implantação, fazer **um único** canário autorizado de instrução textual sintética, sem ferramentas nem escrita; verificar `openhands.status` e resposta final; não usar dados reais nem alegar execução por conta da mera criação da conversa.

## Referências upstream fixadas

- [OpenHands Agent Canvas v1.26.0 — start conversation builder](https://github.com/OpenHands/OpenHands/blob/v1.26.0/src/api/agent-server-adapter.ts)
- [SDK v1.53.0 — StartConversationRequest](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/openhands-sdk/openhands/sdk/conversation/request.py)
- [SDK v1.53.0 — GET settings e exposição de segredos](https://github.com/OpenHands/software-agent-sdk/blob/v1.53.0/openhands-agent-server/openhands/agent_server/settings_router.py)
- [Issue #61](https://github.com/OARANHA/Remote-Ops-MCP/issues/61)
