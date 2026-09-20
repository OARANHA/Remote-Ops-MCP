import { OpsError } from "../lib/errors.js";
import type { TargetConfig } from "../config/targets.js";
import type { ExecResult } from "../ssh/pool.js";

export type RemoteRun = (argv: string[], opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<ExecResult>;
const SECRET_PATH_PATTERNS: RegExp[] = [/(^|\/)\.ssh(\/|$)/,/(^|\/)authorized_keys$/,/(^|\/)known_hosts$/,/(^|\/)\.env(\.[^/]+)?$/,/(^|\/)\.aws(\/|$)/,/(^|\/)\.gnupg(\/|$)/,/(^|\/)\.kube(\/|$)/,/(^|\/)\.docker(\/|$)/,/(^|\/)\.netrc$/,/(^|\/)\.git-credentials$/,/(^|\/)\.npmrc$/,/(^|\/)\.pypirc$/,/(^|\/)\.htpasswd$/,/(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.[^/]+)?$/, /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,/(^|\/)(credentials?|secrets?|tokens?)(\.[^/]*)?$/i,/(^|\/)(shadow|gshadow)(-\d+)?$/,/(^|\/)\.git\/config$/];
export function denySecretPath(p:string):boolean{return SECRET_PATH_PATTERNS.some((re)=>re.test(p));}
function sanitizeSegments(input:string):string{return input.replace(/\0/g,"").replace(/[\r\n]/g,"");}
async function canonicalRealPath(inputPath:string,run:RemoteRun):Promise<string>{
 const cleaned=sanitizeSegments(inputPath); if(!cleaned.startsWith("/")) throw new OpsError("PATH_DENIED","caminho deve ser absoluto");
 const segs=cleaned.split("/").filter((s)=>s.length>0&&s!=="."); if(segs.length===0) throw new OpsError("PATH_DENIED","caminho vazio não é permitido"); if(segs.some((s)=>s==="..")) throw new OpsError("PATH_DENIED","path traversal não é permitido");
 const normalized="/"+segs.join("/"); if(denySecretPath(normalized)) throw new OpsError("SECRET_PATH_DENIED","caminho nega regra de segredo","arquivos de segredos/credenciais nunca são lidos");
 let real=""; try{const res=await run(["realpath","-e","--",normalized]); if(res.code!==0) throw new OpsError("PATH_DENIED","caminho inexistente ou inacessível"); real=res.stdout.trim().split("\n")[0]??"";}catch(e){if(e instanceof OpsError) throw e; throw new OpsError("PATH_DENIED","falha ao resolver caminho");}
 if(!real.startsWith("/")||real.split("/").filter(Boolean).some((s)=>s==="..")) throw new OpsError("PATH_DENIED","caminho resolvido inválido"); if(denySecretPath(real)) throw new OpsError("SECRET_PATH_DENIED","caminho real nega regra de segredo (symlink?)");
 return real;
}
export async function resolveCheckedPath(inputPath:string,target:TargetConfig,run:RemoteRun):Promise<string>{
 const real=await canonicalRealPath(inputPath,run);
 if(target.allowedPaths.length===0) throw new OpsError("PATH_DENIED",`target "${target.id}" não possui allowedPaths configurado`);
 const inside=target.allowedPaths.some((root)=>{const r=root.replace(/\/+$/,''); return real===r||real.startsWith(r+"/");}); if(!inside) throw new OpsError("PATH_DENIED",`caminho fora da allowlist do target "${target.id}"`); return real;
}
export async function resolveCheckedGitRepo(inputPath:string,target:TargetConfig,run:RemoteRun):Promise<string>{
 const real=await canonicalRealPath(inputPath,run);
 if(target.allowedGitRepos.length===0) throw new OpsError("REPO_NOT_ALLOWED",`target "${target.id}" não possui allowedGitRepos configurado`);
 for(const configured of target.allowedGitRepos){
  let allowed:string; try{allowed=await canonicalRealPath(configured,run);}catch{continue;}
  if(real===allowed) return real;
 }
 throw new OpsError("REPO_NOT_ALLOWED",`repositório "${real}" não está na allowlist do target`,`allowlist: ${target.allowedGitRepos.join(", ") || "(vazia)"}`);
}
export function assertConfiguredPath(inputPath:string, roots:string[], label="execução"):string{
 const cleaned=sanitizeSegments(inputPath);
 if(!cleaned.startsWith("/")) throw new OpsError("PATH_DENIED","caminho deve ser absoluto");
 const segs=cleaned.split("/").filter((x)=>x.length>0&&x!==".");
 if(segs.length===0||segs.some((x)=>x==="..")) throw new OpsError("PATH_DENIED","caminho inválido ou com traversal");
 const normalized="/"+segs.join("/");
 if(denySecretPath(normalized)) throw new OpsError("SECRET_PATH_DENIED","caminho nega regra de segredo");
 if(roots.length===0) throw new OpsError("PATH_DENIED",`nenhuma raiz de ${label} configurada`);
 const inside=roots.some((root)=>{const r=root.replace(/\/+$/,"");return normalized===r||normalized.startsWith(r+"/");});
 if(!inside) throw new OpsError("PATH_DENIED",`caminho fora da allowlist de ${label}`,`allowlist: ${roots.join(", ")||"(vazia)"}`);
 return normalized;
}
export async function resolveCheckedProcessCwd(inputPath:string,target:TargetConfig,run:RemoteRun):Promise<string>{
 const real=await canonicalRealPath(inputPath,run);
 if(target.allowedProcessCwds.length===0) throw new OpsError("PATH_DENIED",`target "${target.id}" não possui allowedProcessCwds configurado`);
 const inside=target.allowedProcessCwds.some((root)=>{const r=root.replace(/\/+$/,"");return real===r||real.startsWith(r+"/");});
 if(!inside) throw new OpsError("PATH_DENIED",`cwd fora da allowlist do target "${target.id}"`);
 return real;
}
