import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// The only outreach transport wired so far: Amazon SES, following the same
// "instance config names the provider and its settings" convention as
// research.futcoMcpUrl / web.authUserEnvVar - never a second implementation
// per instance, and fails closed if the config is missing rather than
// guessing a region or sender.
export function resolveOutreachSettings(instanceConfig) {
  const outreach = instanceConfig?.outreach;
  if (!outreach || outreach.provider !== 'ses') {
    throw new Error('Instance config has no outreach.provider "ses" configured; refusing to send outreach');
  }
  if (!isNonEmptyString(outreach.region)) {
    throw new Error('Instance config is missing outreach.region');
  }
  if (!isNonEmptyString(outreach.fromEmail)) {
    throw new Error('Instance config is missing outreach.fromEmail');
  }
  return { region: outreach.region, fromEmail: outreach.fromEmail };
}

// AWS credentials are deliberately not read from instance config - the SDK's
// default credential provider chain (~/.aws/credentials, env vars, etc.)
// handles that, matching how every other AWS-integrated tool on this machine
// is already authenticated.
export async function sendEmailViaSes({ instanceConfig, to, subject, body }) {
  const { region, fromEmail } = resolveOutreachSettings(instanceConfig);
  const client = new SESClient({ region });

  const command = new SendEmailCommand({
    Source: fromEmail,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Text: { Data: body, Charset: 'UTF-8' } }
    }
  });

  const response = await client.send(command);
  return { transport: 'ses', messageId: response.MessageId ?? null };
}
