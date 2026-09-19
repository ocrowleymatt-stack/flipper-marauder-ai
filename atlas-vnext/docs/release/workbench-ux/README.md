# Workbench UX screenshots

Captured by `apps/host/tests/workbench.browser.test.ts` against a local mock host. These are the conversation-first shell, not production.

| File | What it shows |
| --- | --- |
| `01-desktop-conversation.png` | Project rail, dominant thread, visible complete answer, composer |
| `02-after-refresh.png` | Same answer restored from the server |
| `03-writing.png` | Caspa / Writing surface as a task, not a permanent inspector |
| `04-second-conversation.png` | New conversation without the previous thread leaking |
| `05-mobile.png` | Narrow viewport: thread still the primary surface |

Run:

```bash
npm run test:browser
```
