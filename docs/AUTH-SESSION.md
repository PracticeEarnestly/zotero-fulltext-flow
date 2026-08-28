# JLSS authentication state model

FullTextFlow treats **API token validity** and the **JLSS web session** as related but distinct states.

A bearer token can remain usable for selected API calls after the browser session used by the JLSS website has expired. Therefore, an API-only success must not be displayed as a fully authenticated web login.

## States

- `authenticated`: API token is valid and the embedded JLSS page shows a positive logged-in web-session signal.
- `api_only`: API token is valid but the web session cannot be positively confirmed.
- `web_expired`: the embedded page shows a login form, password field, login/register marker, or login-route signal.
- `api_invalid`: API token validation fails.
- `unknown`: neither side can be determined confidently.

## UI rule

Only `authenticated` may be presented as **聚联登录成功**.

`api_only` must be presented as a warning such as **API 可用，但网页会话未确认**. This prevents a stale bearer token from producing a false green-login state.

`web_expired` must request re-login even if the previous token can still access a limited API endpoint.

## Web-session probes

The embedded browser is inspected without logging secret values. The probe checks:

- URL/path hints for login/auth pages;
- visible password inputs;
- visible login/register text markers;
- positive session markers such as logout/account-center/user-center text when no negative signal exists.

Both a direct DOM path and a Gecko frame-script path are supported to tolerate Zotero/Firefox process isolation.

## Security

No password, token, cookie, localStorage value, sessionStorage value, or session identifier is written to logs or diagnostic UI.
