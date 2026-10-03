# Elus VendaERP DANFE readonly canary — semantic boundary

Esta capability executa uma passagem controlada do fluxo
`Elus → VendaERP → Pedido → Pessoa → contato → NFe → DANFE → preview`.

Ela **não** transforma o Remote-Ops em provider de ERP. A semântica de negócio continua no artefato CRM-WANDORA/Elus.

## Topologia canônica

O canário é executado no host que possui o Elus:

```text
MCP client
  → Remote-Ops control plane
    → vigia-agent / Agent Mesh
      → Portainer local do host (127.0.0.1:9443)
        → descobre a stack elus e seu EndpointId
          → elus-app
```

O control plane **não acessa o Portainer Vigia** e **não armazena seu token**.
Não existe fallback do canário para Docker proxy, docker.sock, managed-admin ou shell genérico.

A credencial do Portainer é local ao Agent Mesh e fica em:

`/var/lib/wandora-ops-agent/secrets/portainer_api_key`

com owner `ops-mcp` e modo `0600`. O instalador mantém o diretório
`/var/lib/wandora-ops-agent/secrets` persistente e `0700`.

O cliente local de Portainer aceita somente o loopback fixo
`https://127.0.0.1:9443`. TLS sem validação de CA é permitido somente nessa conexão loopback;
o token nunca é enviado a host remoto.

## Target de longa duração

O uso normal reaproveita o target permanente do próprio host, `vigia-agent`, adicionando
somente `elus.vendaerp_danfe_canary_readonly` à allowlist semântica desse target.
Isso evita criar um target descartável por execução.

Um target separado, como `vigia-elus`, continua possível quando se desejar isolamento
adicional de autoridade, mas não é requisito operacional.

O preset dinâmico `elus-danfe-canary` permanece apenas para bootstrap/testes e não participa
do fluxo normal.

## Preflight oficial

`elus_vendaerp_danfe_canary_preflight` é read-only e usa a mesma capability de autoridade.
Ele valida, sem chamadas ao VendaERP e sem criação de containers:

- autenticação no Portainer local;
- descoberta de exatamente uma stack `elus` ativa e de seu `EndpointId`;
- `elus-app` existente e running;
- presença das quatro variáveis seladas, apenas como booleano;
- estado do candidate;
- estado do receipt.

Nenhum valor de secret, PII, XML ou payload de ERP é retornado.

## Efeitos permitidos

- VendaERP: **somente GET**;
- Supabase/Storage: um preview temporário do DANFE;
- WhatsApp: **nenhum envio**;
- VendaERP writes: **zero**.

A tool de execução é `mutation=true` e `idempotent=false` porque o preview é uma escrita
fora do VendaERP.

## Segredos do Elus

A execução lê internamente o `Config.Env` do container fixo `elus-app` e copia somente:

- `NEXT_PUBLIC_SUPABASE_URL`;
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`;
- `SUPABASE_SERVICE_ROLE_KEY`;
- `AI_CRED_AES_KEY`.

Nenhuma outra variável atravessa o boundary. Os valores não entram no resultado MCP nem no receipt.

## Pin de supply chain

A configuração exige simultaneamente:

- repositório fixo `ghcr.io/oaranha/elus-danfe-canary`;
- referência `@sha256:...`;
- revisão Git de 40 hex.

Antes do start, a runtime confere `RepoDigests` e
`org.opencontainers.image.revision`. Divergência falha fechado.

Também são fixos no Agent Mesh:

- source container: `elus-app`;
- candidate: `wandora-elus-danfe-canary-once`;
- receipt: `wandora-elus-danfe-canary-receipt`;
- network: `bridge`;
- stack `elus` descoberta dinamicamente no Portainer local;
- `EndpointId` obtido da própria stack.

## Uma execução real, sem retry

O fluxo é:

1. receipt existente com o mesmo hash de escopo → resultado sanitizado com `replayed=true`, sem nova execução;
2. receipt existente com outro escopo → `canary_already_consumed`;
3. candidate existente e rodando → `canary_in_progress`;
4. candidate existente e parado → lê somente o JSON final, cria receipt e remove candidate, sem rerun;
5. primeira execução → cria/starta o candidate uma vez, materializa o resultado, cria receipt e remove candidate.

Timeout/perda de resposta não abre automaticamente uma segunda chamada real ao ERP.

## Isolamento do candidate

O container do canário:

- usa imagem por digest;
- não recebe Docker socket;
- não recebe bind mounts;
- `Privileged=false`;
- `CapDrop=ALL`;
- `no-new-privileges`;
- rootfs read-only;
- `/tmp` tmpfs `noexec,nosuid,nodev`;
- sem restart;
- limites de memória/PIDs;
- rede fixa `bridge`.

## Saída

O resultado é reconstruído por allowlist.

Sucesso expõe somente números de pedido/NFe, rótulos de evidência de identidade,
as três chamadas GET esperadas, tamanho/assinatura do PDF, estado do preview e
`whatsapp_sent=false` / `vendaerp_writes=0`.

Falha expõe somente um `code` allowlisted. CPF, telefone, e-mail, conversation ID,
storage path, signed URL, XML, token e payload ERP bruto são descartados.
