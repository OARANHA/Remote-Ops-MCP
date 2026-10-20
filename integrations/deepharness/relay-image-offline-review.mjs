/**
 * Stage 20: offline, read-only review of a candidate Node 22 base image.
 * NEVER pulls, builds, creates containers, deploys, or reads Docker secrets.
 * A manifest digest identifies bytes, not the Node major version: a separate
 * official provenance/Node-version gate is required before any real build.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const digest=/^sha256:[0-9a-f]{64}$/;
const base=/^(?:docker\.io\/library\/)?node@(sha256:[0-9a-f]{64})$/;
const fail=()=>{throw Error("DSH_RELAY_IMAGE_REVIEW_NO_GO");};

export function checkCachedNodeBase({imageRef,os,architecture,repoDigests,imageId}={}){
  const match=typeof imageRef==="string"&&base.exec(imageRef);
  if(!match||os!=="linux"||architecture!=="amd64"||
    !Array.isArray(repoDigests)||!digest.test(imageId??""))fail();
  const matches=repoDigests.some(x=>typeof x==="string"&&
    x.endsWith("@"+match[1]) &&
    (x.startsWith("node@")||x.startsWith("docker.io/library/node@")));
  if(!matches)fail();
  return Object.freeze({
    status:"PREPARE_ONLY",cached:true,platform:"linux/amd64",
    immutable_ref:imageRef,image_id:imageId,
    node_version_verified:false,provenance_verified:false,
    relay_image_built:false,container_created:false,activation_authorized:false,
  });
}
export function readCachedNodeBase(imageRef){
  if(!base.test(imageRef??""))fail();
  // Inspect only exact nonsecret metadata. No image pull, build or run.
  const output=execFileSync("docker",["image","inspect","--format",
    "{{.Os}}|{{.Architecture}}|{{json .RepoDigests}}|{{.Id}}",imageRef],
    {encoding:"utf8",timeout:5000,maxBuffer:8192}).trim();
  const fields=output.split("|");
  if(fields.length!==4)fail();
  return checkCachedNodeBase({
    imageRef,os:fields[0],architecture:fields[1],
    repoDigests:JSON.parse(fields[2]),imageId:fields[3],
  });
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=="--dry-run"){
    process.stderr.write("Usage: node relay-image-offline-review.mjs --dry-run node@sha256:<64hex>\n");
    process.exitCode=2;
  }else{
    try{
      const result=readCachedNodeBase(args[1]);
      process.stdout.write(JSON.stringify(result,null,2)+"\n");
    }catch{
      process.stderr.write("DSH_RELAY_IMAGE_REVIEW=NO_GO (candidate image unavailable or not verified in local cache)\n");
      process.exitCode=1;
    }
  }
}
