import net from "node:net";

export interface ManagedAdminBrokerRequest {
  ticket: Record<string, unknown>;
  signature: string;
}
export interface ManagedAdminBrokerResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const SOCKET_PATH = process.env.WANDORA_ADMIN_BROKER_SOCKET ?? "/run/wandora-ops-admin/admin.sock";

export async function callManagedAdminBroker(
  req: ManagedAdminBrokerRequest,
  timeoutMs = 30_000,
): Promise<ManagedAdminBrokerResponse> {
  return await new Promise<ManagedAdminBrokerResponse>((resolve,reject)=>{
    const socket=net.createConnection({path:SOCKET_PATH});
    let data="";
    let settled=false;
    const finish=(err?:Error,response?:ManagedAdminBrokerResponse)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      socket.destroy();
      if(err)reject(err);else resolve(response??{ok:false,error:{code:"BROKER_EMPTY",message:"empty managed admin broker response"}});
    };
    const timer=setTimeout(()=>finish(new Error("managed_admin_broker_timeout")),Math.min(Math.max(timeoutMs,1000),125_000));
    socket.setEncoding("utf8");
    socket.on("connect",()=>socket.write(JSON.stringify(req)+"\n"));
    socket.on("data",(chunk)=>{
      data+=chunk;
      if(data.length>5*1024*1024)return finish(new Error("managed_admin_broker_response_too_large"));
      const nl=data.indexOf("\n");
      if(nl<0)return;
      try{finish(undefined,JSON.parse(data.slice(0,nl)) as ManagedAdminBrokerResponse);}
      catch{finish(new Error("managed_admin_broker_invalid_json"));}
    });
    socket.on("error",(err)=>finish(err));
    socket.on("end",()=>{if(!settled)finish(new Error("managed_admin_broker_disconnected"));});
  });
}
