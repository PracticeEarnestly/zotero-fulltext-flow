# FullTextFlow 0.2.6 — dual JLSS session verification

## Problem

A stored JLSS bearer token can remain accepted by selected API endpoints after the website session has expired. Earlier FullTextFlow versions treated API validation alone as a successful login, which could create a false-positive state: the plugin showed login success while opening the JLSS personal center required a new login.

## Fix

0.2.6 separates two checks:

1. **API token validation** — verifies that the current token can call the JLSS task-list API.
2. **Web-session validation** — inspects the embedded JLSS page, through both direct DOM access and a Gecko frame-script fallback, for login/session signals.

Only when both checks are positive does FullTextFlow display **聚联登录成功**.

## Status semantics

- API + confirmed web session: green success and waiting tasks may resume.
- API valid + web session unknown: amber warning, never reported as full login success.
- API valid + web session expired: red warning that re-login is required; the still-valid token is retained so background work is not unnecessarily interrupted.
- API invalid: re-login required.

## Privacy

Web-session probes return only boolean/state indicators and method labels. They do not expose or log passwords, tokens, cookies, localStorage contents, sessionStorage contents, or session identifiers.
