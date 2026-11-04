# Controlled Effect Worker

## Capability boundary

The Effect Worker is a durable, approval-gated dispatcher. Its production registry is intentionally closed and contains only two low-risk, idempotent, read-only Docker operations:

| Action | Behavior | Mandate scope |
| --- | --- | --- |
| service.inspect | Lists containers carrying an exact com.docker.compose.project label; includes stopped containers. | projectId and composeProject |
| container.inspect | Inspects one container and returns a narrow status summary only when its Compose project label matches. | projectId and composeProject; resourceId when the Mandate also declares resource scope |

Both actions require an empty payload object and risk=low. A Mandate must explicitly include the exact Compose project name in composeProjectNames. This is a separate dimension from the internal ComposeOps projectId: neither dimension grants the other. The Compose project name is bound into the immutable Mandate fingerprint. An older Mandate without this scope dimension cannot authorize either new read-only action and must be reissued.

The Worker connects only to the local Docker Engine. A non-empty hostId is rejected; remote hosts are not routed implicitly. Container IDs must be 12–64 hexadecimal characters. For a resource-scoped Mandate, the resource ID must also match exactly.

## Explicitly unsupported

No handler exists for image pull, Compose up/down, container start/stop/restart/remove, volume or network mutation, SSH, arbitrary shell, or payload-supplied commands. Unknown actions and risk above low are rejected before startOpsEffect and before any Docker method is invoked. Rejection is written to the Ticket activity log.

The container.inspect result is an allowlisted projection. It never returns Docker's raw inspect response, Config.Env, host mounts, network settings, or arbitrary labels. The service listing likewise returns only container identity, image, state and the two Compose labels.

## Dispatch lifecycle

1. An operator creates an Execute Effect against a Ticket and an active, scoped Mandate.
2. A human explicitly approves it. Approval only queues the intent.
3. The Worker claims one item using a short-lived lease.
4. Before starting, it verifies the closed action registry, approval record, risk, parameters and target shape. startOpsEffect independently re-checks the Mandate fingerprint, expiry, allowed/denied action and every declared target scope.
5. During the read-only request, the Worker renews its lease. It stores a redacted, bounded result or a known failure.
6. An expired lease before execution can return to the queue. An expired executing lease becomes outcome_unknown, clears its stale owner/expiry and is never automatically replayed. An operator must reconcile it with evidence.

An idempotency key only replays a semantically identical request. Reusing it with a different action, mode, risk, target, payload, assignment or Mandate returns idempotency_conflict.

## Runtime

The Docker Compose service starts the Worker with OPS_EFFECT_WORKER_ENABLED=1 (default through COMPOSEOPS_EFFECT_WORKER_ENABLED). Set COMPOSEOPS_EFFECT_WORKER_ENABLED=0 in the Compose environment and recreate only opsdash to pause dispatch. The authenticated status endpoint is:

GET /api/v1/ops-tickets/worker/status

The Ticket UI displays Worker state, queue/lease counters, supported actions and explicitly unsupported operations.

## Testing

Worker tests use a temporary SQLite database and an injected fake Docker client. They verify exact project-label filtering, container inspection projection/redaction, project mismatch handling, unsupported/high-risk rejection before Docker access, approval enforcement, idempotency conflicts, crash recovery and lifecycle status. No production Docker mutation is invoked by the test suite.
