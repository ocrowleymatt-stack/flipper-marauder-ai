# Workbench UX screenshots

Captured by `apps/host/tests/workbench.browser.test.ts` against a local mock host, except the production before shot.

| File | What it shows |
| --- | --- |
| `00-before-production.jpg` | Production defect on atlas.ocrowley.com: Website Studio + Run Inspection, no answer |
| `01-desktop-conversation.png` | Conversation-first desktop, visible complete answer, composer |
| `02-after-refresh.png` | Same answer restored from the server |
| `03-writing.png` | Caspa as a task with Back to conversation |
| `04-second-conversation.png` | New conversation without the previous thread leaking |
| `05-mobile.png` | Narrow viewport: thread still the primary surface |
| `06-run-details.png` | Optional diagnostics drawer |
| `12-wave5-desktop.png` | Wave 5 Ask Atlas website result, preview, Library reopen |
| `13-wave5-mobile.png` | Wave 5 390px website card, preview, composer still usable |
| `14-wave6-desktop.png` | Wave 6 Ask Atlas music result, player, Library reopen |
| `15-wave6-mobile.png` | Wave 6 390px music card, player, composer still usable |

Run:

```bash
npm run test:browser
```
