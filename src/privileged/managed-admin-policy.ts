export const MANAGED_ADMIN_CAPABILITY = "host.managed_admin";

export const MANAGED_ADMIN_DEFAULT_PROGRAMS = [
  "apt-get","apt","dpkg","systemctl","journalctl","docker","git","curl","wget",
  "install","cp","mv","rm","rmdir","mkdir","chmod","chown","chgrp","ln","tar","unzip",
  "ufw","firewall-cmd","ip","ss","hostnamectl","timedatectl","sysctl","mount","umount",
  "lsblk","df","du"
] as const;

export const MANAGED_ADMIN_HARD_DENY = [
  "bash","sh","dash","zsh","fish","sudo","su","pkexec","python","python3","node","perl","ruby","php"
] as const;

export const MANAGED_ADMIN_DEFAULT_CWDS = [
  "/opt/wandora/ops-workspace",
  "/opt/wandora",
] as const;

export function cwdLexicallyAllowed(cwd: string, roots: readonly string[]): boolean {
  if (!cwd.startsWith("/") || cwd.length > 1024 || /[\0\r\n]/.test(cwd) || cwd.split("/").includes("..")) return false;
  const clean=(value:string)=>value.replace(/\/+$/,"")||"/";
  const candidate=clean(cwd);
  return roots.some((raw)=>{
    const root=clean(raw);
    return candidate===root || candidate.startsWith(root+"/");
  });
}
