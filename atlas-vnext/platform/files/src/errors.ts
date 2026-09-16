export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}

export class UnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMediaError';
  }
}

export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestionError';
  }
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export class CitationUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CitationUnknownError';
  }
}

export class FilesAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilesAccessError';
  }
}

/** Metadata exists but the CAS object does not. Callers must not invent bytes. */
export class CasMissingError extends Error {
  constructor(readonly sha256: string) {
    super(`CAS object missing for hash ${sha256}.`);
    this.name = 'CasMissingError';
  }
}
