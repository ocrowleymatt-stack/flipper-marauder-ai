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
