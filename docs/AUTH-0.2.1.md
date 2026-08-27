# FullTextFlow 0.2.1 authentication

- Credentials are stored in Mozilla Login Manager under origin `chrome://fulltextflow` and realm `fulltextflow-jlss`.
- The legacy 0.2.0 plaintext token preference is migrated to Login Manager and cleared on startup.
- The primary flow opens the official JLSS web app inside Zotero, attempts best-effort username/password form fill, and watches JLSS local/session storage for `token`.
- CAPTCHA, MFA, institutional verification, and other interactive challenges are not bypassed.
- If browser DOM/localStorage access changes in future Zotero/JLSS builds, manual token input remains available as a fallback.
