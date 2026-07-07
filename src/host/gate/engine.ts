/**
 * Gate engine (docs/SECURITY_MODEL.md): градуированная цена действия + провенанс + fail-closed deps.
 * Чистая функция — решения только в доверенном ядре.
 */
import type { QueueProvenance } from '../queue/store.ts';
import { ACTIONS, type ActionSpec } from './actions.ts';
import { lookupMcpAction } from './mcp-actions.ts';
import type { ActionClass, GateDecision, GateVerdict } from './types.ts';

export interface GateDeps {
  brokerAvailable: boolean;
  gateHealthy: boolean;
}

export interface GateRequest {
  actionId: string;
  provenance: QueueProvenance;
  /** Human-gate: true после успешного /approve. */
  confirmed?: boolean;
  /** S8: max(request, skill) — пока необязательно. */
  skillActionClass?: ActionClass;
}

const TRUSTED_FOR_EFFECT = new Set<QueueProvenance>(['owner']);
const TRUSTED_FOR_READONLY = new Set<QueueProvenance>(['owner', 'system']);
/** S9: фоновые cron-задачи — read-only + reversible, не irreversible. */
const TRUSTED_FOR_BACKGROUND = new Set<QueueProvenance>(['scheduler']);

function effectiveClass(spec: ActionSpec, req: GateRequest): ActionClass {
  const skill = req.skillActionClass;
  if (skill === undefined) return spec.actionClass;
  const order: ActionClass[] = ['read-only', 'reversible', 'irreversible'];
  return order[Math.max(order.indexOf(spec.actionClass), order.indexOf(skill))]!;
}

export function evaluate(req: GateRequest, deps: GateDeps): GateDecision {
  if (!deps.gateHealthy) {
    return { verdict: 'deny', actionClass: 'irreversible', reason: 'gate unhealthy (fail-closed)' };
  }

  const spec = ACTIONS[req.actionId] ?? lookupMcpAction(req.actionId);
  if (!spec) {
    return {
      verdict: 'deny',
      actionClass: 'irreversible',
      reason: `unknown action: ${req.actionId}`,
    };
  }

  const actionClass = effectiveClass(spec, req);

  if (spec.requiresBroker && !deps.brokerAvailable) {
    return { verdict: 'deny', actionClass, reason: 'broker unavailable (fail-closed)' };
  }

  const prov = req.provenance;

  if (actionClass === 'read-only') {
    if (!TRUSTED_FOR_READONLY.has(prov) && !TRUSTED_FOR_BACKGROUND.has(prov)) {
      return {
        verdict: 'deny',
        actionClass,
        reason: 'provenance not trusted for read-only action',
      };
    }
    return { verdict: 'allow', actionClass, reason: 'read-only allowed' };
  }

  if (!TRUSTED_FOR_EFFECT.has(prov)) {
    if (TRUSTED_FOR_BACKGROUND.has(prov) && actionClass === 'reversible') {
      return {
        verdict: 'allow',
        actionClass,
        reason: 'background reversible allowed for scheduler',
      };
    }
    return {
      verdict: 'deny',
      actionClass,
      reason: 'untrusted provenance cannot initiate external effect',
    };
  }

  if (actionClass === 'reversible') {
    return { verdict: 'allow', actionClass, reason: 'reversible allowed for trusted provenance' };
  }

  if (req.confirmed) {
    return { verdict: 'allow', actionClass, reason: 'irreversible human-confirmed' };
  }

  return {
    verdict: 'confirm_required',
    actionClass,
    reason: 'irreversible requires owner approval',
  };
}

export function verdictToAuditDecision(
  verdict: GateVerdict,
): 'allow' | 'deny' | 'confirm_required' {
  return verdict;
}
