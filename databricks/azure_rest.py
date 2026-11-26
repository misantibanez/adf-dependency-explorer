"""Service-principal transport; no Azure CLI or secrets in output."""

import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from adf_api import guid


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AzureRest:
    def __init__(self, tenant_id: str, client_id: str, client_secret: str):
        self.tenant_id = guid(tenant_id)
        self.client_id = guid(client_id)
        self._secret = client_secret
        if not client_secret:
            raise ValueError("El secreto del service principal esta vacio.")
        self._tokens: dict[str, tuple[str, float]] = {}
        self._opener = build_opener(NoRedirect())

    def _json(self, request: Request) -> object:
        for attempt in range(4):
            try:
                with self._opener.open(request, timeout=60) as response:
                    return json.loads(response.read().decode("utf-8"))
            except HTTPError as error:
                status = error.code
                retry_after = error.headers.get("Retry-After", "")
                error.close()
                if status in (429, 500, 502, 503, 504) and attempt < 3:
                    delay = min(int(retry_after), 60) if retry_after.isdigit() else 2 ** attempt
                    time.sleep(delay)
                    continue
                raise RuntimeError(f"Consulta Azure rechazada (HTTP {status}); revisar identidad y permisos.") from None
            except (URLError, TimeoutError):
                raise RuntimeError("No se pudo conectar con Azure; revisar conectividad del compute.") from None
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise ValueError("Azure no devolvio JSON valido.") from None
        raise RuntimeError("Azure no completo la consulta.")

    def _token(self, audience: str) -> str:
        cached = self._tokens.get(audience)
        if cached and time.monotonic() < cached[1]:
            return cached[0]
        payload = urlencode({"grant_type": "client_credentials", "client_id": self.client_id,
                             "client_secret": self._secret, "scope": audience.rstrip("/") + "/.default"})
        response = self._json(Request(
            f"https://login.microsoftonline.com/{self.tenant_id}/oauth2/v2.0/token",
            data=payload.encode("utf-8"), headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        ))
        if (not isinstance(response, dict) or not isinstance(response.get("access_token"), str)
                or not response["access_token"] or not isinstance(response.get("expires_in"), (int, str))):
            raise ValueError("Respuesta OAuth invalida.")
        try:
            lifetime = int(response["expires_in"])
        except ValueError:
            raise ValueError("Vigencia OAuth invalida.") from None
        if lifetime <= 60:
            raise ValueError("Vigencia OAuth insuficiente.")
        token = response["access_token"]
        self._tokens[audience] = (token, time.monotonic() + lifetime - 60)
        return token

    def __call__(self, args: list[str], body: dict | None = None) -> object:
        if not args or args[0] != "rest" or len(args) % 2 != 1:
            raise ValueError("Solo se admiten consultas REST.")
        options = dict(zip(args[1::2], args[2::2]))
        if set(options) - {"--method", "--url", "--resource"}:
            raise ValueError("Opcion REST no admitida.")
        url = options.get("--url", "")
        parsed = urlsplit(url)
        method = options.get("--method", "").upper()
        audience = {"management.azure.com": "https://management.azure.com/",
                    "api.loganalytics.azure.com": "https://api.loganalytics.io"}.get(parsed.hostname)
        if (not audience or parsed.scheme != "https" or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.fragment):
            raise ValueError("Destino Azure no permitido.")
        if method not in ("GET", "POST") or (method == "POST" and not (
            parsed.path.endswith("/queryPipelineRuns") or (
                parsed.hostname == "api.loganalytics.azure.com" and parsed.path.endswith("/query")))):
            raise ValueError("Operacion no permitida; solo lectura y consultas de historial.")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        return self._json(Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + self._token(audience), "Content-Type": "application/json",
        }))
