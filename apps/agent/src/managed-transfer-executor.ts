import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink, progressEvent } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner, CommandResult } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

interface TransferItem { relPath: string; size: number; modTime: string; objectKey: string; }
interface ManagedTransferPayload {
  ruleId: string; sourceEndpointId: string; sourcePath: string; destinationEndpointId: string; destinationPath: string;
  mode: "copy" | "move"; verification: "size"; transferAttempt: number;
  multiThreadStreams: number; multiThreadCutoff: string; rcloneArgs: string[]; items: TransferItem[];
}
interface ProgressBase { completedBytes: number; completedFiles: number; totalBytes: number; totalFiles: number; }

const RESERVED_RCLONE_FLAGS = new Set([
  "-n",
  "--config",
  "--dry-run",
  "--use-json-log",
  "--partial-suffix",
  "--backup-dir",
  "--compare-dest",
  "--copy-dest",
  "--suffix",
  "--suffix-keep-extension",
  "--log-file",
  "--password-command",
]);

export class ManagedTransferExecutor implements JobExecutor {
  readonly #config: AgentRuntimeConfig;
  readonly #runner: CommandRunner;
  readonly #events: ExecutionEventSink;
  constructor(config: AgentRuntimeConfig, runner: CommandRunner, events: ExecutionEventSink = noopExecutionEventSink) { this.#config=config;this.#runner=runner;this.#events=events; }

  async execute(job: BackupJob, signal: AbortSignal): Promise<JobExecutionResult> {
    const payload=parsePayload(job.payload);
    const sourceEndpoint=this.#config.rcloneEndpoint(payload.sourceEndpointId);
    const destinationEndpoint=this.#config.rcloneEndpoint(payload.destinationEndpointId);
    if(payload.mode==="move"&&sourceEndpoint.allowMove!==true)throw new Error(`rclone move is not allowed for source endpoint: ${sourceEndpoint.id}`);

    const totalBytes=payload.items.reduce((sum,item)=>sum+item.size,0);
    const stageBase=joinTarget(destinationEndpoint.fs,joinRelative(payload.destinationPath,".nexus-backup-staging",job.id));
    let completedBytes=0,completedFiles=0;
    this.#events.emit({type:"log",tool:"rclone",stream:"stdout",message:`Preparing staged transfer ${payload.ruleId} (${payload.items.length} file${payload.items.length===1?"":"s"})`});
    if(payload.transferAttempt>1)await this.#purgeBestEffort(stageBase,signal,"stale staging");

    let usedMultiThread=false;
    for(const item of payload.items){
      const source=joinTarget(sourceEndpoint.fs,joinRelative(payload.sourcePath,item.relPath));
      const stage=joinTarget(stageBase,item.relPath);
      const result=await this.#copyTo(source,stage,signal,{completedBytes,completedFiles,totalBytes,totalFiles:payload.items.length},payload);
      usedMultiThread ||= result;
      completedBytes+=item.size;completedFiles+=1;
    }
    this.#events.emit(progressEvent("rclone",{bytesDone:completedBytes,bytesTotal:totalBytes,filesDone:completedFiles,filesTotal:payload.items.length,speedBytesPerSecond:0,etaSeconds:0,errors:0}));

    this.#events.emit({type:"log",tool:"rclone",stream:"stdout",message:"Verifying staged manifest by exact byte size"});
    for(const item of payload.items)await this.#verifySize(joinTarget(stageBase,item.relPath),item.size,signal);

    this.#events.emit({type:"log",tool:"rclone",stream:"stdout",message:"Committing verified staging to final destination"});
    for(const item of payload.items){const stage=joinTarget(stageBase,item.relPath),final=joinTarget(destinationEndpoint.fs,joinRelative(payload.destinationPath,item.relPath));await this.#runRclone(["moveto",stage,final],signal);}

    this.#events.emit({type:"log",tool:"rclone",stream:"stdout",message:"Verifying committed destination"});
    for(const item of payload.items)await this.#verifySize(joinTarget(destinationEndpoint.fs,joinRelative(payload.destinationPath,item.relPath)),item.size,signal);

    let deleted=0;
    if(payload.mode==="move"){
      this.#events.emit({type:"log",tool:"rclone",stream:"stdout",message:"Destination verified; deleting only committed source files"});
      for(const item of payload.items){await this.#runRclone(["deletefile",joinTarget(sourceEndpoint.fs,joinRelative(payload.sourcePath,item.relPath))],signal);deleted+=1;}
    }
    await this.#purgeBestEffort(stageBase,signal,"empty staging");
    this.#events.emit({type:"summary",tool:"rclone",data:{operation:"managed-transfer",ruleId:payload.ruleId,mode:payload.mode,files:payload.items.length,bytes:totalBytes,verified:true,sourceFilesDeleted:deleted,transferAttempt:payload.transferAttempt,multiThreadUsed:usedMultiThread}});
    return{status:"completed"};
  }

  async #copyTo(source:string,destination:string,signal:AbortSignal,base:ProgressBase,payload:ManagedTransferPayload):Promise<boolean>{
    const common=["copyto",source,destination,"--partial-suffix",".nexus-part","--use-json-log","--stats","1s","--stats-log-level","NOTICE","--stats-file-name-length","0",...(this.#config.tools.rcloneArgs??[]),...payload.rcloneArgs];
    const withMt=[...common];
    if(payload.multiThreadStreams>1){withMt.push("--multi-thread-streams",String(payload.multiThreadStreams));if(payload.multiThreadCutoff)withMt.push("--multi-thread-cutoff",payload.multiThreadCutoff);}
    const first=await this.#runCopy(withMt,signal,base);
    if(first.exitCode===0)return payload.multiThreadStreams>1;
    if(payload.multiThreadStreams<=1||!isMultiThreadUnsupported(first))throw new ToolExitError("rclone",first);
    this.#events.emit({type:"log",tool:"rclone",stream:"stderr",message:"Multi-thread copy is unsupported for this transfer; retrying single-thread"});
    const fallback=await this.#runCopy(common,signal,base);
    if(fallback.exitCode!==0)throw new ToolExitError("rclone",fallback);
    return false;
  }

  async #runCopy(args:string[],signal:AbortSignal,base:ProgressBase):Promise<CommandResult>{
    const full=[...args];if(this.#config.tools.rcloneConfigPath)full.push("--config",this.#config.tools.rcloneConfigPath);
    return this.#runner.run({executable:this.#config.tools.rcloneBinary??"rclone",args:full},signal,{stdout:line=>this.#events.emit({type:"log",tool:"rclone",stream:"stdout",message:compactLog(line)}),stderr:line=>this.#handleStats(line,base)});
  }

  #handleStats(line:string,base:ProgressBase):void{
    const message=parseJson(line),stats=isRecord(message?.stats)?message.stats:null;
    if(!stats){this.#events.emit({type:"log",tool:"rclone",stream:"stderr",message:compactLog(line)});return;}
    const currentBytes=numberValue(stats.bytes)??0,currentFiles=numberValue(stats.transfers)??0;
    this.#events.emit(progressEvent("rclone",{bytesDone:Math.min(base.totalBytes,base.completedBytes+currentBytes),bytesTotal:base.totalBytes,filesDone:Math.min(base.totalFiles,base.completedFiles+currentFiles),filesTotal:base.totalFiles,speedBytesPerSecond:numberValue(stats.speed),etaSeconds:nullableNumberValue(stats.eta),errors:numberValue(stats.errors)}));
  }

  async #verifySize(target:string,expected:number,signal:AbortSignal):Promise<void>{const result=await this.#runRclone(["lsjson",target,"--stat","--no-mimetype"],signal,false);const value=parseJson(result.stdoutTail),actual=numberValue(value?.Size??value?.size);if(actual===undefined)throw new Error("rclone verification did not return a file size");if(actual!==expected)throw new Error(`rclone size verification failed: expected ${expected} bytes, got ${actual}`);}
  async #runRclone(args:string[],signal:AbortSignal,log=true):Promise<CommandResult>{const full=[...args,...(this.#config.tools.rcloneArgs??[])];if(this.#config.tools.rcloneConfigPath)full.push("--config",this.#config.tools.rcloneConfigPath);const result=await this.#runner.run({executable:this.#config.tools.rcloneBinary??"rclone",args:full},signal,log?{stdout:line=>this.#events.emit({type:"log",tool:"rclone",stream:"stdout",message:compactLog(line)}),stderr:line=>this.#events.emit({type:"log",tool:"rclone",stream:"stderr",message:compactLog(line)})}:{});if(result.exitCode!==0)throw new ToolExitError("rclone",result);return result;}
  async #purgeBestEffort(target:string,signal:AbortSignal,label:string):Promise<void>{try{await this.#runRclone(["purge",target],signal,false)}catch(error){this.#events.emit({type:"log",tool:"rclone",stream:"stderr",message:`Could not clean ${label}; continuing safely (${error instanceof Error?error.message:String(error)})`})}}
}

function parsePayload(value:unknown):ManagedTransferPayload{
  if(!isRecord(value))throw new Error("managed transfer payload must be an object");const mode=value.mode;if(mode!=="copy"&&mode!=="move")throw new Error("managed transfer mode must be copy or move");if(value.verification!=="size")throw new Error("managed transfer verification must be size");if(!Array.isArray(value.items)||value.items.length===0||value.items.length>5000)throw new Error("managed transfer requires 1-5000 manifest items");const items=value.items.map(parseItem),paths=new Set<string>();for(const item of items){if(paths.has(item.relPath))throw new Error(`duplicate managed transfer path: ${item.relPath}`);paths.add(item.relPath)}return{ruleId:requireId(value.ruleId,"ruleId"),sourceEndpointId:requireId(value.sourceEndpointId,"sourceEndpointId"),sourcePath:normalizeBase(value.sourcePath,"sourcePath"),destinationEndpointId:requireId(value.destinationEndpointId,"destinationEndpointId"),destinationPath:normalizeBase(value.destinationPath,"destinationPath"),mode,verification:"size",transferAttempt:positiveInteger(value.transferAttempt,"transferAttempt"),multiThreadStreams:integerRange(value.multiThreadStreams??4,"multiThreadStreams",1,32),multiThreadCutoff:sizeSuffix(value.multiThreadCutoff??"256M","multiThreadCutoff"),rcloneArgs:transferRcloneArgs(value.rcloneArgs),items};
}
function parseItem(value:unknown):TransferItem{if(!isRecord(value))throw new Error("managed transfer item must be an object");const size=Number(value.size);if(!Number.isSafeInteger(size)||size<0)throw new Error("managed transfer item size is invalid");const modTime=typeof value.modTime==="string"&&Number.isFinite(Date.parse(value.modTime))?new Date(value.modTime).toISOString():(()=>{throw new Error("managed transfer item modTime is invalid")})();return{relPath:normalizeObjectPath(value.relPath),size,modTime,objectKey:requireHex(value.objectKey,"objectKey")}}
function transferRcloneArgs(value:unknown):string[]{const args=stringArray(value,"rcloneArgs");for(const arg of args){const flag=arg.split("=",1)[0]??arg;if(isReservedRcloneFlag(flag))throw new Error(`rcloneArgs may not override managed transfer safety flag: ${flag}`)}return args}
function isReservedRcloneFlag(flag:string):boolean{return RESERVED_RCLONE_FLAGS.has(flag)||flag.startsWith("--stats")||flag.startsWith("--multi-thread-")||flag.startsWith("--delete-")||flag==="--rc"||flag.startsWith("--rc-")||flag==="--dump"||flag.startsWith("--dump-")}
function sizeSuffix(value:unknown,name:string):string{const result=requireString(value,name,1,32);if(!/^\d+(?:\.\d+)?(?:[kKmMgGtTpPeE](?:i?[bB])?)?$/.test(result))throw new Error(`${name} must be a numeric rclone size suffix such as 256M or 1G`);return result}
function isMultiThreadUnsupported(result:CommandResult):boolean{const text=`${result.stderrTail}\n${result.stdoutTail}`.toLowerCase();return text.includes("multi-thread")||text.includes("multithread")||text.includes("multi thread")||text.includes("not supported")}
function joinTarget(base:string,relative:string):string{if(!relative)return base;if(base.endsWith(":")||base.endsWith("/"))return`${base}${relative}`;return`${base}/${relative}`}
function joinRelative(...parts:string[]):string{return parts.filter(Boolean).map(part=>part.replace(/^\/+|\/+$/g,"")).filter(Boolean).join("/")}
function normalizeBase(value:unknown,name:string):string{if(value==null||value==="")return"";if(typeof value!=="string")throw new Error(`${name} must be a string`);const n=value.trim().replaceAll("\\","/").replace(/^\/+|\/+$/g,"");if(!n)return"";if(n.split("/").some(part=>!part||part==="."||part===".."))throw new Error(`${name} may not contain dot segments`);return n}
function normalizeObjectPath(value:unknown):string{if(typeof value!=="string")throw new Error("relPath must be a string");const n=value.replaceAll("\\","/").replace(/^\/+|\/+$/g,"");if(!n||n.split("/").some(part=>!part||part==="."||part===".."))throw new Error("relPath must be a safe relative path");return n}
function requireId(value:unknown,name:string):string{if(typeof value!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.trim()))throw new Error(`${name} is invalid`);return value.trim()}
function requireHex(value:unknown,name:string):string{if(typeof value!=="string"||!/^[a-f0-9]{64}$/i.test(value))throw new Error(`${name} must be a sha256 hex string`);return value.toLowerCase()}
function requireString(value:unknown,name:string,min:number,max:number):string{if(typeof value!=="string")throw new Error(`${name} must be a string`);const r=value.trim();if(r.length<min||r.length>max)throw new Error(`${name} must be ${min}-${max} characters`);return r}
function stringArray(value:unknown,name:string):string[]{if(value==null)return[];if(!Array.isArray(value))throw new Error(`${name} must be an array`);return value.map(item=>requireString(item,name,1,256))}
function positiveInteger(value:unknown,name:string):number{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw new Error(`${name} must be a positive integer`);return n}
function integerRange(value:unknown,name:string,min:number,max:number):number{const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`${name} must be an integer between ${min} and ${max}`);return n}
function parseJson(value:string):Record<string,unknown>|null{try{const p=JSON.parse(value) as unknown;return isRecord(p)?p:null}catch{return null}}
function compactLog(line:string):string{const p=parseJson(line);if(typeof p?.msg==="string")return p.msg;return line.length>4000?`${line.slice(0,4000)}…`:line}
function numberValue(value:unknown):number|undefined{return typeof value==="number"&&Number.isFinite(value)&&value>=0?value:undefined}
function nullableNumberValue(value:unknown):number|null|undefined{return value===null?null:numberValue(value)}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
