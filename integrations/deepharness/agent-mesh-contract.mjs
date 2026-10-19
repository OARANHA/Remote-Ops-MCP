/**
 * Review-only, pure Agent Mesh envelope contract for the DeepHarness bridge.
 * No dispatch, listener, target grant, certificate, Docker access or model.
 * The already-authenticated Remote-Ops policy must authorize an exact caller,
 * workspace, Lead and action before constructing this envelope.
 */
const OP="deepharness.semantic";
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ENVELOPE_BYTES=16_384;
const deny=()=>{throw Error("deepharness_agent_mesh_contract_denied");};
const isRecord=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const exact=(obj,names)=>{
  if(!isRecord(obj)||Object.keys(obj).length!==names.length||
     names.some(key=>!Object.hasOwn(obj,key))||
     Object.keys(obj).some(key=>!names.includes(key)))deny();
};
const safeId=value=>typeof value==="string"&&ID.test(value)?value:deny();

function checkArgs(args) {
  if(!isRecord(args)||typeof args.operation!=="string")deny();
  const operation=args.operation;
  const common=["operation","workspaceId"];
  const withLead=[...common,"leadSessionId"];
  if(operation==="listTeams")exact(args,common);
  else if(operation==="getTeamStatus"||operation==="listTasks")exact(args,withLead);
  else if(operation==="readLeadChat"){
    exact(args,[...withLead,"maxMessages"]);
    if(!Number.isSafeInteger(args.maxMessages)||args.maxMessages<1||args.maxMessages>20)deny();
  }else if(operation==="sendLeadInstruction"){
    exact(args,[...withLead,"requestId","text"]);
    if(typeof args.requestId!=="string"||!UUID.test(args.requestId)||
       typeof args.text!=="string"||!args.text.trim()||args.text.includes("\0")||
       Buffer.byteLength(args.text,"utf8")>4096)deny();
  }else deny();
  safeId(args.workspaceId);
  if(operation!=="listTeams")safeId(args.leadSessionId);
  return operation;
}

/**
 * Validate both ends of the future Agent Mesh hop. Input is not a URL, argv,
 * IP or Docker target; it never contains OAuth secrets, grants or certs.
 * The host must additionally enforce its own independent lab-only allowlist,
 * exact DSH mTLS peer pin, and fail closed until a private local path exists.
 */
export function validateDshAgentMeshEnvelope(value) {
  exact(value,["op","args"]);
  if(value.op!==OP)deny();
  checkArgs(value.args);
  const serialized=JSON.stringify(value);
  if(Buffer.byteLength(serialized,"utf8")>MAX_ENVELOPE_BYTES)deny();
  return Object.freeze({op:OP,args:Object.freeze({...value.args})});
}
export function makeDshAgentMeshEnvelope(args) {
  return validateDshAgentMeshEnvelope({op:OP,args});
}
