"""Credential storage and lookup for external API connectors.

Raises CredentialError on lookup/IO failures. Library code — does not call
sys.exit or fail(). Step scripts catch CredentialError (via its ConnectorError
base class) and translate to fail().
"""
import json, os, stat
from connectors import ConnectorError

CREDENTIALS_PATH = os.path.expanduser("~/.montaj/credentials.json")

# Single source of truth for which providers Montaj knows about and
# which keys each one needs. `montaj install credentials` imports this.
# Adding a new connector → add it here first.
KNOWN_PROVIDERS: dict[str, list[str]] = {
    "kling":  ["access_key", "secret_key"],
    "gemini": ["api_key"],
    "openai": ["api_key"],
}


class CredentialError(ConnectorError):
    """Raised on any credential issue: missing, corrupt file, unreadable file.

    Subclass of ConnectorError so existing `except ConnectorError` handlers
    in step scripts still catch it. Workflows that want provider-fallback
    behavior can catch CredentialError specifically.
    """


def _env_var_name(provider: str, key: str) -> str:
    # "kling", "access_key" -> "KLING_ACCESS_KEY"
    return f"{provider.upper()}_{key.upper()}"


def _read_file() -> dict:
    """Return parsed credentials.json, {} if absent. Raises CredentialError on bad file."""
    if not os.path.isfile(CREDENTIALS_PATH):
        return {}
    try:
        with open(CREDENTIALS_PATH) as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise CredentialError(
            f"{CREDENTIALS_PATH} is not valid JSON ({e.msg} at line {e.lineno}). "
            f"Fix the file or delete it and re-run: montaj install credentials"
        ) from e
    except OSError as e:
        raise CredentialError(f"Could not read {CREDENTIALS_PATH}: {e}") from e


def get_credential(provider: str, key: str) -> str:
    """Return the credential value or raise CredentialError.

    Precedence: env var > ~/.montaj/credentials.json > raise.
    """
    env_val = os.environ.get(_env_var_name(provider, key), "").strip()
    if env_val:
        return env_val

    data = _read_file()
    val = (data.get(provider) or {}).get(key, "")
    if val:
        return val

    raise CredentialError(
        f"No {provider}.{key} credential found. "
        f"Set {_env_var_name(provider, key)} or run: "
        f"montaj install credentials --provider {provider} --key {key}"
    )


def set_credential(provider: str, key: str, value: str) -> None:
    """Write credential to ~/.montaj/credentials.json with 0600 perms."""
    os.makedirs(os.path.dirname(CREDENTIALS_PATH), exist_ok=True)
    data = _read_file()
    data.setdefault(provider, {})[key] = value
    tmp = CREDENTIALS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)  # 0600
    os.replace(tmp, CREDENTIALS_PATH)


def list_providers() -> dict:
    """Return all known providers with credential status (set/unset).

    Iterates KNOWN_PROVIDERS so unconfigured providers still appear.
    Never returns raw values — for display only.
    """
    data = _read_file()
    result = {}
    for provider, keys in KNOWN_PROVIDERS.items():
        provider_data = data.get(provider, {})
        result[provider] = {k: "set" if provider_data.get(k) else "unset" for k in keys}
    return result
