import { makeRequestId } from '../protocol.js';
import { PassivePromptLedger } from '../bridge/passivePromptLedger.js';

const CONTRACT = 'passive-prompt-v1';

function statusFields(state = {}) {
  return {
    storage_status: String(state.storage_status || state.status || 'UNKNOWN'),
    operator_status: String(state.operator_status || state.status || 'UNKNOWN'),
    can_retry: state.can_retry === true,
    reconciliation_required: state.reconciliation_required === true,
    ...(state.ageMs == null ? {} : { ageMs: state.ageMs }),
    ...(state.reviewAfterMs == null ? {} : { reviewAfterMs: state.reviewAfterMs }),
    ...(state.reconciliation ? { reconciliation: state.reconciliation } : {}),
  };
}

export function registerPassivePromptRoutes(router, bridge) {
  router.post('/browser/passive-prompt', async (req, res, next) => {
    const headerRequestId = String(req.headers['x-yazhan-request-id'] || '').trim();
    const bodyRequestId = String(req.body?.requestId || req.body?.request_id || '').trim();
    if (headerRequestId && bodyRequestId && headerRequestId !== bodyRequestId) {
      res.status(422).json({
        ok: false,
        contract: CONTRACT,
        submissionStatus: 'REJECTED_BEFORE_SUBMIT',
        error: 'Request identity header and body do not match',
      });
      return;
    }
    const requestId = headerRequestId || bodyRequestId || `passive-${makeRequestId()}`;
    try {
      res.json({
        ok: true,
        contract: CONTRACT,
        submissionStatus: 'SUBMITTED',
        requestId: requestId || undefined,
        result: await bridge.submitPassivePrompt({
          requestId,
          message: req.body?.message,
          sessionId: req.body?.sessionId,
          effort: req.body?.effort,
          model: req.body?.model,
          sourceClientId: req.body?.sourceClientId,
          timeoutMs: req.body?.timeoutMs,
        }),
      });
    } catch (error) {
      const rejected = error.submissionStatus === 'REJECTED_BEFORE_SUBMIT';
      let derived = {};
      try {
        derived = statusFields(await bridge.getPassivePromptStatus(error.requestId || requestId));
      } catch {}
      res.status(rejected ? 422 : 503).json({
        ok: false,
        contract: CONTRACT,
        submissionStatus: rejected ? 'REJECTED_BEFORE_SUBMIT' : 'UNCERTAIN_AFTER_SUBMIT',
        requestId: error.requestId || requestId || undefined,
        error: rejected ? 'Prompt rejected before submission' : 'Prompt submission could not be confirmed; do not resend',
        ...derived,
      });
    }
  });

  router.post('/browser/passive-prompt/reconcile/:requestId', async (req, res, next) => {
    const requestId = String(req.params.requestId || '').trim();
    if (!requestId || typeof bridge.reconcilePassivePrompt !== 'function') {
      res.status(404).json({ ok: false, contract: CONTRACT, submissionStatus: 'UNKNOWN', status: 'UNKNOWN' });
      return;
    }
    try {
      const state = await bridge.reconcilePassivePrompt(requestId, {
        actor: String(req.headers['x-yazhan-owner'] || 'owner').slice(0, 160),
        evidence: req.body?.evidence,
      });
      res.json({
        ok: true,
        contract: CONTRACT,
        submissionStatus: state.storage_status || state.status || 'INFLIGHT',
        requestId,
        ...statusFields(state),
      });
    } catch (error) {
      const status = Number(error.statusCode) || 422;
      res.status(status).json({
        ok: false,
        contract: CONTRACT,
        submissionStatus: 'INFLIGHT',
        requestId,
        error: String(error.message || 'Owner reconciliation was rejected'),
        code: String(error.code || 'PASSIVE_PROMPT_RECONCILIATION_REJECTED'),
      });
    }
  });

  router.get('/browser/passive-prompt/status/:requestId', async (req, res, next) => {
    const requestId = String(req.params.requestId || '').trim();
    if (!requestId || typeof bridge.getPassivePromptStatus !== 'function') {
      res.status(404).json({ ok: false, contract: CONTRACT, submissionStatus: 'UNKNOWN', status: 'UNKNOWN' });
      return;
    }
    try {
      const state = await bridge.getPassivePromptStatus(requestId);
      if (state?.status === PassivePromptLedger.states.SUBMITTED) {
        res.json({
          ok: true,
          contract: CONTRACT,
          submissionStatus: 'SUBMITTED',
          requestId,
          result: PassivePromptLedger.proof(state),
          ...statusFields(state),
        });
        return;
      }
      if (state?.status === PassivePromptLedger.states.REJECTED_BEFORE_SUBMIT) {
        const proof = PassivePromptLedger.proof(state) || {};
        res.status(422).json({
          ok: false,
          contract: CONTRACT,
          submissionStatus: 'REJECTED_BEFORE_SUBMIT',
          requestId,
          error: proof.error || 'Prompt rejected before submission',
          code: proof.code,
          ...statusFields(state),
        });
        return;
      }
      if (state?.status === PassivePromptLedger.states.INFLIGHT) {
        res.status(503).json({
          ok: false,
          contract: CONTRACT,
          submissionStatus: 'INFLIGHT',
          requestId,
          error: 'Prompt submission is still in flight; do not resend',
          ...statusFields(state),
        });
        return;
      }
      res.status(404).json({ ok: false, contract: CONTRACT, submissionStatus: 'UNKNOWN', status: 'UNKNOWN', requestId, ...statusFields(state) });
    } catch (error) { next(error); }
  });
}
