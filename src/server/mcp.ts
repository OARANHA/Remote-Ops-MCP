import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import type { ZodRawShape } from "zod";
import { TOOL_DEFS, type ToolCtx } from "../tools/index.js";
import { OpsError, toolErrorPayload, loggableError } from "../lib/errors.js";
import { audit } from "../audit/audit.js";

interface RuntimeToolDef {
  name:string;description:string;inputSchema:ZodRawShape;
  run:(args:Record<string,unknown>,ctx:ToolCtx)=>Promise<unknown>;
  mutation?:boolean;destructive?:boolean;idempotent?:boolean;
}

async function optionalDeepharnessTools():Promise<RuntimeToolDef[]> {
  if(process.env.DSH_SEMANTIC_ENABLED!=="1")return [];
  const moduleUrl=new URL("../../integrations/deepharness/mcp-tools.mjs",import.meta.url);
  const integration=await import(moduleUrl.href) as {loadDeepharnessToolDefs:()=>Promise<RuntimeToolDef[]>};
  return integration.loadDeepharnessToolDefs();
}

async function createServer(ctx:ToolCtx):Promise<McpServer>{
 const server=new McpServer({name:"remote-ops-mcp",version:"1.1.0"},{instructions:"Servidor de operações remotas em VPS Linux via capabilities explícitas. Descubra targets com targets_list. Operações de escrita/processo só funcionam nas workspaces e programas allowlisted; não há sudo nem shell root implícito. Managed-admin, quando explicitamente habilitado, exige prepare/apply, confirmação humana e ticket root assinado de uso único. As ferramentas DeepHarness, quando ativadas, usam grants exatos por OAuth client/session, workspace, Lead e ação; o OAuth mcp:read sozinho não concede acesso a equipes nem autorização de escrita. Em chats de operador, apresente por padrão somente o resumo necessário à decisão; detalhe operacional completo deve ser consultado nas fontes autoritativas ou via visão full quando o usuário pedir explicitamente ou quando for necessário para uma decisão humana. O audit mantém seu contrato redigido de eventos. Todas as ações são auditadas."});
 const defs=[...TOOL_DEFS,...await optionalDeepharnessTools()];
 for(const def of defs){
   const mutation=def.mutation===true;
   server.registerTool(def.name,{description:def.description,inputSchema:def.inputSchema,
     _meta:{securitySchemes:[{type:"oauth2",scopes:["mcp:read"]}]},
     annotations:{readOnlyHint:!mutation,destructiveHint:def.destructive===true,
       idempotentHint:def.idempotent??!mutation,openWorldHint:false}},
   async(args:Record<string,unknown>)=>{
     const started=Date.now();
     const values=args??{};
     const base={ts:new Date().toISOString(),request_id:ctx.requestId,actor:ctx.actor,
       target:typeof values.target==="string"?values.target:undefined,
       workspace_id:typeof values.workspaceId==="string"?values.workspaceId:undefined,
       lead_session_id:typeof values.leadSessionId==="string"?values.leadSessionId:undefined,
       tool:def.name,mutation};
     try{
       const result=await def.run(values,ctx);
       audit({...base,duration_ms:Date.now()-started,result:"ok"});
       return{content:[{type:"text" as const,text:JSON.stringify(result,null,2)}]};
     }catch(err){
       if(!(err instanceof OpsError))console.error(JSON.stringify({ts:new Date().toISOString(),level:"error",
         msg:"tool_crash",tool:def.name,error:loggableError(err)}));
       const{payload,denied}=toolErrorPayload(err);
       audit({...base,duration_ms:Date.now()-started,result:denied?"denied":"error",error_code:payload.error.code});
       return{content:[{type:"text" as const,text:JSON.stringify(payload,null,2)}],isError:true};
     }
   });
 }
 return server;
}

export async function handleMcpRequest(req:Request,res:Response):Promise<void>{
 const verified=req as Request&{actor?:string;requestId?:string;oauthClientId?:string;oauthSessionId?:string};
 const ctx:ToolCtx={actor:verified.actor??"anonymous",requestId:verified.requestId??"unknown",
   clientId:verified.oauthClientId,sessionId:verified.oauthSessionId};
 const server=await createServer(ctx);
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
 res.on("close",()=>{void transport.close();void server.close();});
 await server.connect(transport);await transport.handleRequest(req,res,req.body);
}
