# Wandora MCP Evolution — code-only backlog

Status: **proposal**, no deployments or live authority changes.
Source-of-truth order: accepted ADRs > security model > target/capability policy > this backlog.

| # | Capability | Reuse first | Phase | Status |
|---|---|---|---|---|
| 01 | Cross-VPS inventory | targets_list, target_status | V2.1 | Planned |
| 02 | Historical CPU/RAM/disk/network metrics | host_status, memory_status, disk_usage; bounded sampler TBD | V2.1 | Planned |
| 03 | Health and anomaly classification | pure health-policy module | V2.1 | **Code-only foundation** |
| 04 | HTTP/HTTPS uptime | endpoint allowlist + SSRF policy | V2.1 | Planned |
| 05 | TCP service health | explicit target/port allowlist | V2.1 | Planned |
| 06 | Alert classification/rules | health-policy + registry policy | V2.1 | Planned |
| 07 | Incident and operational event history | existing audit vs separate monitoring event schema | V2.1 | Planned |
| 08 | Container health consolidation | docker_health | V2.1 | Planned |
| 09 | Security audit | existing SSH and policy reads | V2.1 | Planned |
| 10 | TLS expiry and chain inspection | approved host/network probe | V2.1 | Planned |
| 11 | Backup inventory | host/providor specific adapters | V2.1 | Planned |
| 12 | Multi-VPS reporting | aggregate authorized metadata | V2.1 | Planned |
| 13 | Cronjob lifecycle | new governed operator capabilities | V2.2 | Planned |
| 14 | Versioned scripts | allowlisted typed script catalog | V2.2 | Planned |
| 15 | Script execution | reuse exec broker, explicit bounded authority | V2.2 | Planned |
| 16 | Automated backups | declared backup backend, retention, restore proof | V2.2 | Planned |
| 17 | TLS renewal | preview + dedicated privileged local adapter | V2.2 | Planned |
| 18 | SSH principal/key management | managed-admin broker, 2-phase approval | V2.2 | Planned |
| 19 | Firewall changes | host/cloud authority + rollback plan | V2.2 | Planned |
| 20 | Recovery playbooks | signed/allowlisted procedures + approval | V2.2 | Planned |
| 21 | Service control | reuse service_action | Existing | Reuse |
| 22 | Patch management | existing managed-admin broker, separate policy | V2.2 | Planned |
| 23 | Contabo inventory | isolated provider adapter and credential scope | V2.3 | Planned |
| 24 | Cloud snapshots | provider-specific create/restore gates | V2.3 | Planned |
| 25 | DNS | provider authority and rollback | V2.3 | Planned |
| 26 | IP/network operations | provider authority, enhanced approval | V2.3 | Planned |
| 27 | VPS lifecycle actions | provider + owner approval + impact preview | V2.3 | Planned |
| 28 | Universal dry-run contracts | existing prepare/apply patterns | V2.2 | Planned |
| 29 | Central approvals/audit | existing approvals and audit | Existing | Reuse/extend |
| 30 | Observatório integration | reviewed sanitized event schema | V3 | Planned |

## Immediate next slice
Wire health policy to a **read-only, authorization-aware** observation result from existing tools, without scheduling or external network calls. First reconcile in-flight DSH branches and ADR status. Add verification to existing CI **only in a separate approved PR**. Never expose raw targets, credentials or unsanitized logs.

## Guardrails
- No main writes, no automatic merge, no Docker/Portainer action, no MCP restart.
- Avoid new overlapping registries, policy engines or privileged executors.
- Keep independent vendor adapters behind target-specific capability checks.
- For any operation that can incur cost, remove data, change connectivity or service availability: propose, impact analysis, explicit approval, then constrained execution.
