# Grok Provider in e3d-corp

## Status and recommendation

The `grok-cli` provider is a normal optional entry under `llm.providers`. It is
not the default and it does not replace the local provider automatically. Roles
that should use Grok name that provider explicitly through `roles.<name>.provider`.

This provider uses the local `grok` CLI session on the machine. If Grok is
already installed and authenticated for `e3d-pilot`, `e3d-corp` uses that same
session. There is no separate API key field for this provider.

## Installation and authentication

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok --version
grok login --device-auth
e3d-corp providers status --instance futco
```

If `grok login --device-auth` was already completed for `e3d-pilot` on this
machine, nothing new is required for `e3d-corp`.

## Configuration

Add a named provider under `llm.providers`:

```json
{
  "llm": {
    "providers": {
      "local": {
        "kind": "local",
        "baseUrlEnvVar": "FUTCO_LLM_BASE_URL",
        "modelEnvVar": "FUTCO_LLM_MODEL"
      },
      "grok": {
        "kind": "grok-cli"
      }
    }
  },
  "roles": {
    "opportunity.prospect": {
      "provider": "local"
    },
    "opportunity.communicator": {
      "provider": "local"
    }
  }
}
```

Supported `grok-cli` fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | Must be `"grok-cli"` |
| `binEnvVar` | no | Env var name whose value overrides the `grok` binary path/name |
| `modelEnvVar` | no | Env var name whose value sets `--model`; when omitted, the CLI default model is used |
| `timeoutMs` | no | Timeout in milliseconds; defaults to 900000 |

When `modelEnvVar` is omitted, e3d-corp records the resolved model as
`"grok-cli-default"` because the CLI-owned default is not discoverable from the
outside.

## Availability and failure behavior

Use the readiness command before switching a role:

```bash
e3d-corp providers status --instance futco
```

For `grok-cli`, this checks whether the resolved binary exists. It does not make
a completion call and it does not try to inspect the login session deeply.

If the provider is unavailable:

- Missing binary: provider resolution fails clearly, naming the missing binary.
- Expired or missing login session: the real `grok` subprocess fails loudly at
  runtime and the error is surfaced directly.
- Timeout: the subprocess is terminated and the role surfaces a timeout error.

In every case, e3d-corp fails closed. There is no silent fallback to the local
provider.
