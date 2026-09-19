# Website Studio dungeon

Domain: site generation, deterministic audits, sandboxed preview.

Nexus must never mount preview file servers. Preview belongs here and in the host; Playwright QA is later.

Wave 3 restores conversation result-return: “build a website about …” creates a canonical site, stores `index.html` in CAS, audits it, and posts the preview into that chat. Model HTML is used when it passes audit. Content-filter or empty model output falls back to a deterministic assembler — never an empty site and never a fake PASS.
