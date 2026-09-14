# @atlas-vnext/files

Platform primitive: ingestion, extraction, chunking, conversation attachments, textual artefacts, and logical generated sites.

Uploads are **data**. Paths are sanitised. MIME is sniffed, not trusted from the extension. PDF JavaScript, Office macros, and executables are rejected. Bytes live in CAS; PostgreSQL stores hashes, refs, and bounded chunk text for retrieval.

Long-running extract/chunk work uses the existing job engine (`files.ingest`). Unchanged content hashes are not re-extracted. Temporary websites are one logical site with a current-revision pointer; `storage.retain` / `storage.gc` bound physical growth.
