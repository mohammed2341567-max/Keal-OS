# KEAL OS — Project specification (6.2 target)

**Editions.** *Home* (Termux + Python relay, two-tablet workspace, real folders, LAN only) and *Web* (static GitHub Pages build; each browser/device has its own independent data).

**6.2 goals** (details and acceptance in the assignment, tracked in `ROADMAP.md`): independent public edition without Samsung/school-device integrations (Sidecar optional); drag-and-drop desktop icons and better windows; modern real settings; IndexedDB device storage with backup/restore and migrations; manifest-driven App Store; HTML/CSS/JS Code Lab with sandboxed preview and an educational virtual console; KEAL Notch notification API; two original touch games; Update Center; documented Termux workflow; security/performance review; full regression suite.

**Non-goals.** Real OS shell access, cross-device sync without a real backend, background push without real infrastructure, circumventing any device or school policy.

**Architecture reference:** `docs/AUDIT_6.2.md`.
