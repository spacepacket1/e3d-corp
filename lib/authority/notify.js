import { spawn } from 'node:child_process';

// Optional, best-effort notification when a new level-2+ proposal becomes
// pending. Failure to notify (missing config, bad command, spawn error) must
// never block approvability, so every failure path here returns a result
// object instead of throwing. No email transport is wired anywhere in this
// repo yet, so `authorityNotify.email` is passed to the configured command as
// context (E3D_CORP_NOTIFY_EMAIL); actually sending mail is left to that
// command, not implemented here.
export function authorityNotify(instanceConfig, proposal) {
  const notifyConfig = instanceConfig?.authorityNotify;
  if (!notifyConfig || typeof notifyConfig.command !== 'string' || notifyConfig.command.trim() === '') {
    return { notified: false, reason: 'no authorityNotify.command configured' };
  }

  try {
    const child = spawn(notifyConfig.command, {
      shell: true,
      env: {
        ...process.env,
        E3D_CORP_NOTIFY_PROPOSAL_ID: proposal.id,
        E3D_CORP_NOTIFY_PROPOSAL_TYPE: proposal.type,
        E3D_CORP_NOTIFY_AUTHORITY_LEVEL: String(proposal.authorityLevel),
        E3D_CORP_NOTIFY_EMAIL: notifyConfig.email ?? ''
      },
      stdio: 'ignore',
      detached: true
    });
    child.on('error', () => {});
    child.unref();
    return { notified: true };
  } catch (error) {
    return { notified: false, reason: error.message };
  }
}
